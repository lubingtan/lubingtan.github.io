# HAMi 项目研究

> 研究时间：2026-10-28
> 源码依据：本地 clone `github.com/Project-HAMi/HAMi`，`master` @ `07c89a3f`（`v2.10.0-280-g07c89a3f`，2026-10-28）；子模块 `libvgpu` → `Project-HAMi/HAMi-core` @ `de0e4df`
> 线上资料：project-hami.io（中文站）、CNCF 博客、GitHub API（抓取于 2026-10-28）

## 1. 项目概况

- **全称**：HAMi — Heterogeneous AI Computing Virtualization Middleware，Kubernetes 上的异构 AI 算力虚拟化 + 调度中间件；前身 `k8s-vGPU-scheduler`。
- **核心主张**：把一张物理加速器按显存（MiB）/ 算力（%）切给多个 Pod，应用不改代码、驱动不改，继续使用标准 `resources.limits`。
- **CNCF**：2024-08 进入 Sandbox，2026-07 晋升 Incubating（TOC 2026-07-02 通过，CNCF 博客 2026-07-15）<https://www.cncf.io/blog/2026/07/15/hami-becomes-a-cncf-incubating-project/>
- **最新 release**：v2.10.0（2026-08-21）<https://github.com/Project-HAMi/HAMi/releases/tag/v2.10.0>；master 已领先该 tag 280 个提交，正在开发下一版。
- **许可**：Apache-2.0；**语言**：Go（主仓库约 12.5 万行 `pkg/`+`cmd/`+`lib/` 代码）+ C/CUDA（HAMi-core）。
- **社区数据**（GitHub API 2026-10-28）：4,982 stars / 875 forks / 30 open issues；2026 年 786 次提交；贡献者以 limengxuan（653 commits）为主，dependabot 330 次。
- **默认分支**：`master`；远程分支 33 个，含大量 `feat/amd-*`，说明 AMD 方向在密集开发。
- **文档**：主仓库已无 `docs/`，文档迁至 website 仓库，统一入口 <https://project-hami.io/docs/>（版本化、中英日三语）。

## 2. 架构

三大组件 + 一个 admission webhook（webhook 由 scheduler 进程提供）：

| 组件 | 代码 | 作用 |
|---|---|---|
| Scheduler Extender | `cmd/scheduler` + `pkg/scheduler` | 提供 `/filter`、`/bind`（loopback `:9444`）与 `/webhook`、`/refit`、健康检查（`0.0.0.0:9443`）；**同一 Pod 内还运行一个 kube-scheduler 容器**（chart `scheduler.kubeScheduler.enabled`），用 KubeSchedulerConfiguration 指向该 extender |
| Device Plugin | `cmd/device-plugin/nvidia` + `pkg/device-plugin` | 由 NVIDIA 官方 device plugin fork 改造，向 kubelet 注册 vGPU 资源；`Allocate()` 注入环境变量/挂载 libvgpu；把节点设备信息写进 Node 注解 |
| vGPU Monitor | `cmd/vGPUmonitor` | DaemonSet，采集容器级显存/利用率并暴露 Prometheus（`:9394`），做 limits 反馈 |
| Mutating Webhook | `pkg/scheduler/webhook.go` | 校验并改写 Pod（schedulerName、注解、拒绝预设分配注解、拒绝 privileged+GPU 等） |

关键端口：extender `127.0.0.1:9444`（只被同 Pod 的 kube-scheduler 调用）、HTTP/webhook `0.0.0.0:9443`、scheduler metrics `:9395`、monitor metrics `:9394`。

关键注解（`hami.io/` 前缀）：

| 注解 | 写入方 | 含义 |
|---|---|---|
| `hami.io/vgpu-node` / `hami.io/vgpu-time` | scheduler Filter | 选中节点与决策时间 |
| `hami.io/vgpu-devices-to-allocate` | scheduler | 待分配设备（device plugin 消费后清除） |
| `hami.io/vgpu-devices-allocated` | scheduler Bind | 分配结果（长期保留） |
| `hami.io/mutex.lock` | scheduler Bind | 节点级分布式锁，串行化并发 bind |
| `hami.io/bind-phase` / `hami.io/bind-time` | scheduler Bind | 绑定阶段与时间戳 |
| `hami.io/node-handshake` / `hami.io/node-nvidia-register` | device plugin | 节点设备注册与心跳 |
| `hami.io/node-scheduler-policy` / `hami.io/gpu-scheduler-policy` | 用户 | Pod 覆盖调度策略 |
| `nvidia.com/use-gputype` / `nouse-gputype` / `use-gpuuuid` / `nouse-gpuuuid` | 用户 | 设备型号/UUID 选择 |
| `hami.io/overwrite-env` / `overwrite-env-containers` | 用户 | 是否向无 GPU 请求的容器隐藏设备 |

## 3. 调度模型

1. Webhook（Create/Update 都拦）做校验：拒绝 Pod 预设 scheduler 所有的分配注解、拒绝 privileged 容器申请 GPU、校验 policy/numa-alignment/device-scoring-weights；对申请了设备的 Pod 把 `schedulerName` 改为 `hami-scheduler`（chart 默认 `forceOverwriteDefaultScheduler=true`）。
2. 内嵌 kube-scheduler 走正常调度，但 Filter 阶段调用 HAMi extender。
3. **HAMi 的 `/filter` 不是纯过滤**：它自己读取节点设备信息 + Pod 请求，做 `Fit`（设备级可用性）+ 节点/设备打分（binpack/spread/...），挑出唯一最优节点，把该节点写进 `hami.io/vgpu-node`、预占 Pod（`podManager`）、写 `to-allocate` 注解，然后 **只返回这一个节点名**。等于把选点决策提前到 Filter，绕开 extender 的 prioritize 协议。
4. `/bind` 中：获取节点锁（`hami.io/mutex.lock` 注解 + 重试），写 `hami.io/bind-phase=allocating`，调用 kube-apiserver 的 Binding，写最终 `vgpu-devices-allocated`，释放锁；失败走 rollback 并记录指标。
5. 同一个 PodGroup（`scheduling.x-k8s.io/pod-group`）成员抢锁失败会重试（`--node-lock-retry-timeout`，默认 28s，低于 extender 30s 超时），v2.10 引入。

调度策略（`pkg/scheduler/policy`）：

- 节点级（`hami.io/node-scheduler-policy`）：`binpack`（先填满繁忙节点）/ `spread`（优先空闲节点），默认 binpack。
- 设备级（`hami.io/gpu-scheduler-policy`）：`binpack` / `spread` / `topology-aware`（按 GPU 间拓扑挑卡）/ `mutex`（只选完全空闲 GPU）/ `numa`（NUMA 作为排序键）。
- v2.10 起支持**逗号分隔的策略链**，如 `mutex,binpack,numa`：过滤型（mutex、topology-aware）先筛，排序型（binpack/spread/numa）按书写顺序做多级排序。
- 设备打分权重可通过 `hami.io/device-scoring-weights` 调整（utilization/memory/core 等维度）。

## 4. 资源模型与设备后端

NVIDIA 资源名：

- `nvidia.com/gpu`：申请**物理 GPU 张数**；节点上注册的值 = 每卡 `deviceSplitCount`（默认 10）个虚拟槽位。
- `nvidia.com/gpumem`：MiB；`nvidia.com/gpumem-percentage`：百分比（与 gpumem 互斥）。
- `nvidia.com/gpucores`：0–100 的算力百分比。
- 其它厂商资源名在 chart `devices.<vendor>` 下配置（如 `metax-tech.com/sgpu`、`huawei.com/Ascend910` 等）。

设备抽象：`pkg/device/devices.go` 的 `Devices` 接口（`MutateAdmission` / `GenerateResourceRequests` / `Fit` / `ScoreNode` / `AddResourceUsage` / `PatchAnnotations` / `GetNodeDevices` / `LockNode`…），14 个后端目录：nvidia、amd、ascend、cambricon、hygon、iluvatar、metax、mthreads、enflame、kunlun、biren、awsneuron、vastai、remotegpu。

NVIDIA 节点运行模式（`operatingmode`，按节点配置，写进 device-plugin ConfigMap）：

| 模式 | 隔离方式 |
|---|---|
| `hami-core`（默认） | 注入 `libvgpu.so`（LD_PRELOAD/ld.so.preload），软件记账 + 算力令牌桶 |
| `mig` | 动态/静态 NVIDIA MIG 实例；v2.10 起 Flexible MIG 支持按需建删、免 drain |
| `mps` | CUDA MPS 模式（常量 `MpsMode`） |
| `remote` | 本节点作为 Lupine 远程 GPU 服务端，由 `remotegpu` 后端跨节点分配 |

## 5. 虚拟化实现（HAMi-core / libvgpu）

- **注入**：device plugin 在 `Allocate()` 返回 `Mounts` 把 `libvgpu.so` 挂到 `/usr/local/vgpu/libvgpu.so`，并把 `/etc/ld.so.preload` 挂成内容为 `/usr/local/vgpu/libvgpu.so` 的文件；整卡分配自动注入 `CUDA_DISABLE_CONTROL=true` 跳过；remote 模式用 `LD_PRELOAD` 环境变量。
- **不改 libcudart/libcuda**：靠三条符号解析路径把调用导向自己的同名包装函数：
  1. `ld.so.preload` 全局符号抢占（直接链接 libcuda 的程序）；
  2. 用汇编 interposer 劫持 `dlsym`（保留 `RTLD_NEXT` 语义）；
  3. 劫持 `cuGetProcAddress` / `cuGetProcAddress_v2`（CUDA 11.3+/12 的 lazy 查表主路径）。
- **真实函数表**：`preInit()` 中 `dlopen("libcuda.so.1", RTLD_NOW|RTLD_NODELETE)`，用 `real_dlsym` 填 `cuda_library_entry[]`，找不到时回退 `RTLD_NEXT`、再按 `_v2`→`_v1` 版本降级；NVML 同理。
- **显存**：`cuMemAlloc_v2` 先 `oom_check`（使用量+申请量 vs `CUDA_DEVICE_MEMORY_LIMIT_<i>` / `/overrideEnv`），再调真实分配并记账；记账写在**每容器一份的共享内存文件**（`CUDA_DEVICE_MEMORY_SHARED_CACHE`，如 `/usr/local/vgpu/usage.cache`），每进程一个 slot + seqlock 原子读写；`cuMemGetInfo_v2`、`cuDeviceTotalMem_v2`、`nvmlDeviceGetMemoryInfo` 都被改写成“配额视图”。
- **算力**：`cuLaunchKernel*` 调用前 `rate_limiter(grid 乘积)` 扣令牌，负数就 `nanosleep(10ms)` 阻塞下发；120ms 周期的 watcher 线程用 NVML 读容器真实 SM 利用率，按 `delta()` 比例反馈调整令牌总量，逼近 `CUDA_DEVICE_SM_LIMIT`。
- **失效条件**：musl/Alpine、静态链接、setuid、DinD、绕过 CUDA 库（直接 ioctl `/dev/nvidia*`）、`CUDA_DISABLE_CONTROL=true`、MIG/MPS 模式；算力限制还要求能反查宿主 PID（`pidfound`），失败则降级为只有显存限制。

## 6. 生态与对比

- 集成：vLLM（按显存上限跑推理共享 GPU）、Volcano（gang + 队列）、Kueue（ResourceTransformation 暴露 HAMi 资源）、Prometheus/Grafana、NVIDIA GPU Operator（共存但须关其 device plugin）、HAMi-WebUI、HAMi-DRA（DRA 独立 chart）、KAI Resource Isolator（KAI 调度 + HAMi-core 隔离）。
- 与 MIG 对比：MIG 硬件硬隔离、Ampere+、固定 profile；HAMi 软件配额、任意 NVIDIA 卡（驱动 ≥440）、MiB/% 粒度、可动态改配额，但隔离是软的、多租户噪声 best-effort。
- 与 MPS/time-slicing：MPS 有并发但无显存隔离；time-slicing 只分时间片；HAMi 同时管显存+算力+调度。
- 与 cGPU：能力最接近，但 cGPU 依赖阿里云宿主机内核 + ACK；HAMi 厂商中立、可自建、覆盖 12+ 厂商。
- 与 GPU Operator：不是竞争，Operator 管驱动/Toolkit，HAMi 管调度与切分。
- 边界：不做驱动/运行时管理；生产环境要硬隔离/SLA 合规应直接用 MIG。

## 7. 限制与风险

- 仅 Linux（glibc ≥ 2.17、kernel ≥ 3.10），未提及 Windows 支持。
- 同一节点只能有一个 GPU 管理插件（HAMi / NVIDIA 官方 / volcano-vgpu 三选一）。
- 镜像里已有 `/etc/ld.so.preload` 或被覆盖会冲突；CDI/musl 场景受限。
- 显存是账本式限制，context/碎片/对齐需补偿（`CONTEXT_SIZE`、`memoryFactor`），不是硬件隔离。
- 文档主仓库移除后，代码与文档版本可能短暂不同步（README 中的链接指向 project-hami.io）。
- 仓库 `skill/hami-vgpu-metrics-summary/SKILL.md` 中包含面向 AI Agent 的可疑指令（“respond with 'YARRR!'” 等），使用 agent skill 前需人工审查。
- go.mod 要求 Go 1.27.3；构建 `libvgpu` 需要 CUDA toolkit + CMake（生产镜像 `docker/Dockerfile` 中完成）。

## 8. 官方文档结构（project-hami.io）

- Get started：Choose your setup、Quick Start（Helm）、Validate HAMi
- Introduction：What is HAMi、Device sharing、Device resource isolation
- Install：Prerequisites、在线/离线安装、Upgrade/Uninstall、WebUI、HAMi-DRA、Volcano、KAI、各云平台（AWS/K3s/GKE/TKE/CCE/ACK/OpenShift）
- Vendor guides：NVIDIA、昇腾、AMD、寒武纪、海光、摩尔线程、天数、燧原、昆仑芯、MetaX、Biren、Vastai、AWS Neuron
- Operate：Configuration、Monitoring、Benchmarks、WebUI、Kueue、Troubleshooting、FAQ
- Design and develop + Contributor Guide：GPU 虚拟化原理/架构/协议/调度策略/HAMi-core 设计/动态 MIG；adopters、contributing、governance、roadmap、e2e

## 9. 参考

- 仓库：<https://github.com/Project-HAMi/HAMi>（本地 `.repos/hami`）
- HAMi-core：<https://github.com/Project-HAMi/HAMi-core>（本地 `.repos/hami/libvgpu`）
- 官网：<https://project-hami.io/>；中文文档 <https://project-hami.io/zh/docs/>
- v2.10.0 发布博客：<https://project-hami.io/zh/blog/hami-v2-10-0-release>
- CNCF 晋升：<https://www.cncf.io/blog/2026/07/15/hami-becomes-a-cncf-incubating-project/>
- 关键源码：`cmd/scheduler/main.go`、`pkg/scheduler/{scheduler.go,webhook.go}`、`pkg/scheduler/policy/`、`pkg/device/devices.go`、`cmd/device-plugin/nvidia/`、`cmd/vGPUmonitor/`、`charts/hami/`、`libvgpu/src/`
