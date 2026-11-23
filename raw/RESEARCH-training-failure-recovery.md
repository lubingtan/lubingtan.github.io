# RESEARCH: 训练失败与自愈 —— 故障分类、首发归因、恢复单元与失败预算

调研日期：2026-11-23。方法：只读 `.repos/upstream/` 已克隆仓库的源码与仓库内官方文档（NCCL、Kubeflow Trainer 的 `docs/`），
外加 NVIDIA / Kubernetes / PyTorch 官方文档，不凭记忆补全。证据格式 `https://github.com/<org>/<repo>/blob/<FULL_SHA>/<path>#Lx-Ly`。
本文是专题资料研究稿，不含任何具体集群的实测数字。

## 0 证据基线

| 仓库 | 固定 SHA（本稿全部引用基于此） |
|---|---|
| pytorch | `02e06c707ee33f8bbad64652dc8f695729a92766` |
| nccl | `ad2d192c1f279aefcaf340f67e07880b65a1116b` |
| jobset | `32c9ea3144095df1fbc778433505c35a53e5acfe` |
| lws | `51d7d5ad84f7badeee1466e4a7b846cacfdbc961` |
| volcano | `2006640ed881e632119eedb9d3fac82819402301` |
| training-operator | `ae27d3faf401f627af88d451cab7092458083420`（此 SHA 已是 Trainer V2，无 PyTorchJob/TFJob） |
| mpi-operator | `a057ca529cb7c3b831207d8bbd37f18136057e0f` |
| kueue | `be7dc9d31470258dd324e5bd6d84f7eaf90f5f69` |
| kubernetes | `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` |
| training-operator legacy v1 | `3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d`（release-1.9 head）/ v1.9.3 `c77ee3ff4d21aa8e5027580d83361c1a426ee789` |

## 1 故障分类与可观测信号

### 1.1 分层总表

| 层 | 典型故障 | 强信号（先看） | 弱/易误判信号 |
|---|---|---|---|
| 调度 | 配额、亲和/拓扑、gang 不齐 | Pod `Pending` + `FailedScheduling`；PodGroup `Pending`（[gang.go#L84-L92](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/scheduler/plugins/gang/gang.go#L84-L92)） | 「容器起不来」 |
| 容器启动 | 镜像、RBAC/PSA、配置、端口、DNS | `ErrImagePull`（[image_manager.go#L419](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/images/image_manager.go#L419)）、`CreateContainerConfigError`、秒级 exit 1/2 | 「训练脚本 bug」 |
| 成员加入 | rendezvous 超时、TCPStore 不可达、rank 缺失 | 全体 rank 卡在同一行 init；`join_timeout` 600s（[dynamic_rendezvous.py#L145-L152](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L145-L152)） | 「NCCL 挂了」 |
| 计算/通信 | collective mismatch、单 rank 卡死、慢节点 | 有 rank 已退出、其余报 timeout；DDP 静态图不匹配（[reducer.cpp#L2205-L2213](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/reducer.cpp#L2205-L2213)） | 「网络抖动」 |
| 进程退出 | OOMKilled 137、CUDA assert 1、SIGSEGV 139、SIGTERM 143 | `lastState.terminated.exitCode/reason`、torchrun 的 `exitcode :` 行 | 只看最后一个 rank 的栈 |
| 节点 | NotReady、kubelet 失联、磁盘满、驱逐 | Node conditions + taint（[node_lifecycle_controller.go#L83-L113](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/nodelifecycle/node_lifecycle_controller.go#L83-L113)）、`Evicted` | 「Pod 被删了」 |
| 设备 | Xid、ECC、掉卡、NVLink/IB 降级 | `dmesg` 的 `NVRM: Xid`、`nvidia-smi -q`、`rdma statistic` | 「NCCL 超时」 |

### 1.2 启动失败

- **调度失败**：`phase=Pending` + `FailedScheduling` 事件；Volcano 的 gang 在成员不齐时直接给
  `Not enough valid tasks for gang-scheduling, valid: %d, min: %d`。LWS 的 `RecreateGroupAfterStart` 对不能放置的组
  不再重建，而是报 `GroupUnschedulable` warning（[pod_controller.go#L698-L704](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/pkg/controllers/pod_controller.go#L698-L704)）。
- **镜像/权限/配置**：`ErrImagePull`/`CreateContainerConfigError`；容器秒退但 `restartCount` 快涨，`reason=Error`、`exitCode=1/2`。
  这类故障应用 `podFailurePolicy` 的 `Ignore`/`FailJob` 与「跑了一会儿才崩」分开记账（§4）。
- **端口冲突/DNS**：torchrun 在 `--rdzv-endpoint` 上起 TCPStore，未写端口默认 29400
  （[run.py#L110-L116](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L110-L116)）。
  多租户共用节点时表现为「master 起不来、worker 连不上」。JobSet 默认 `publishNotReadyAddresses=true`，不待 Ready 就发 DNS，
  正是为了让成员互相找到（[jobset_types.go#L441-L444](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L441-L444)）。
- **NCCL/IB 初始化失败**：官方路径 `NCCL_DEBUG=INFO NCCL_DEBUG_SUBSYS=INIT,BOOTSTRAP,NET`
  （[logging.rst#L431-L445](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/docs/userguide/source/troubleshooting/logging.rst#L431-L445)）。
  初始化期卡住与计算期卡住是两类问题：前者看 BOOTSTRAP/NET，后者看 WARN 与 watchdog。

### 1.3 成员加入超时

- **rendezvous 超时**：join=600s、last_call=30s、close=30s、heartbeat=5s（[dynamic_rendezvous.py#L145-L152](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L145-L152)），
  到期抛 `RendezvousTimeoutError`（[#L705](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L705)）。
  各 agent 各有 join deadline，多会在同一时间窗内集体超时——日志里 N 个 rank 同时失败是**症状不是原因**。
- **TCPStore 不可达**：master 端口不通、Pod 网络不通、master 自己重启；worker 在 init 阶段重试后超时。
- **rank 缺失 / Pod Pending**：`--nnodes=MIN:MAX` 下只等 `MIN`，其余进 waiting list；已运行的 agent 能看到
  `num_nodes_waiting()`；它**会**触发整组重启，但不计入重试预算（§3.1）。
- **慢启动**：大镜像、JIT、数据预热。平台侧可用 Kueue `waitForPodsReady.timeout` 把「迟迟不就绪」变成可计费事件
  （[configuration_types.go#L330-L340](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/config/v1beta2/configuration_types.go#L330-L340)）。
- **启动顺序**：LWS `StartupPolicy` 为 `LeaderReady`（leader Ready 才建 worker）或 `LeaderCreated`
  （[leaderworkerset_types.go#L750-L758](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L750-L758)）；
  MPI 有 `LauncherCreationPolicy=WaitForWorkersReady`
  （[types.go#L155-L166](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L155-L166)）。
  选错的症状是「launcher 先起、mpirun 连不上、最后被 deadline 杀掉」。

### 1.4 Hang

- **collective mismatch**：DDP 在下一次迭代开始时发现上轮 reduce 未完成，报
  `Expected to have finished reduction in the prior iteration before starting a new one`，并提示是未使用参数
  （[reducer.cpp#L2205-L2226](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/reducer.cpp#L2205-L2226)）。这是逻辑层问题，不是 NCCL 故障。
- **NCCL watchdog**：只有「已入队的 collective」才有超时计时；本 SHA 的文本是
  `Watchdog caught collective operation timeout: NCCL operation timed out`
  （[WorkNCCL.cpp#L209-L212](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/WorkNCCL.cpp#L209-L212)）。
  torchrun 默认注入 `TORCH_NCCL_ASYNC_ERROR_HANDLING=1`
  （[local_elastic_agent.py#L450-L458](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L450-L458)），
  所以「异步错误 → 进程 abort」是开着的。
- **某 rank 卡住 / 慢节点**：没有内核级信号。torchrun 只看本地子进程是否退出
  （[local_elastic_agent.py#L624-L670](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L624-L670)），
  进程活着就 `HEALTHY`——「训练不动也不报错」不会被发现。
- **CPU 侧 hang / D 状态**：唯一内建兜底是 D-state 检测，需显式开 `TORCHELASTIC_UNINTERRUPTIBLE_STATE_TIMEOUT`；
  命中后报 `stuck in uninterruptible sleep (D-state) ... marking worker group UNHEALTHY and disabling restarts`
  （[local_elastic_agent.py#L554-L593](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L554-L593)）。
  注意是「禁用重启」——卡住的进程还占着 GPU/NIC 内核资源。
- **死锁**：部分 rank 卡在某个 collective、部分已到下一个；需 `NCCL_DEBUG=INFO` 比对各 rank 最后入队的 op 序号（§2）。

### 1.5 单 rank 退出

| 退出码 | 语义 | 关键字段 | 恢复含义 |
|---|---|---|---|
| 137 | OOM（SIGKILL） | `reason: OOMKilled`（CRI 契约 [api.proto#L1537-L1540](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto#L1537-L1540)） | 可重试，但须同时调资源，否则 OOM 循环 |
| 139 | SIGSEGV | 形如 `exitcode : -11 (SIGSEGV)` | 多半不可重试（坏指针/驱动 bug） |
| 143 | SIGTERM | 形如 `exitcode : -15 (SIGTERM)` | 通常是**别人杀它**（驱逐/停机），非首发 |
| 1 / 2 | 应用异常 / 用法错误 | 栈在 stderr | 按内容判断 |

Kubeflow legacy v1 的 `ExitCode` 策略把这套经验固化：永久错误 `139/128/127/126/2/1`，可重试 `143/137/130/138`
（[tensorflow.md#L150-L158](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/legacy-v1/user-guides/tensorflow.md#L150-L158)）。
torchrun 的失败报告同时给 exitcode 与信号名，区分「自己退出」与「被信号杀」
（[errors/__init__.py#L166-L174](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/errors/__init__.py#L166-L174)），
这是区分首发与连锁的第一手材料。

### 1.6 节点故障

- **conditions**：`Ready/MemoryPressure/DiskPressure/PIDPressure`；`Ready=False/Unknown` 打 `node.kubernetes.io/not-ready` taint
  （[node_lifecycle_controller.go#L83-L113](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/nodelifecycle/node_lifecycle_controller.go#L83-L113)）。
- **判定时延**：依赖 NodeStatus 与 NodeLease 两种心跳，超时先置 `NodeReady=ConditionUnknown`；默认
  `NodeMonitorGracePeriod` 在本版本是 **50s**（[defaults.go#L40-L46](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/nodelifecycle/config/v1alpha1/defaults.go#L40-L46)，
  设计约束见 [#L273-L300](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/nodelifecycle/node_lifecycle_controller.go#L273-L300)）。
- **驱逐时延**：默认 toleration 对 `not-ready:NoExecute`/`unreachable:NoExecute` 各给 300s
  （[admission.go#L68-L73](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/plugin/pkg/admission/defaulttolerationseconds/admission.go#L68-L73)）。
  所以「节点挂了」到「Pod Failed」有数分钟延迟，训练侧先表现为 hang/超时。
- **驱逐计入预算**：`Evicted` 的 Pod 是 `Failed`，默认计入失败；要排除只能用 `podFailurePolicy` 匹配 `DisruptionTarget`
  后 `Ignore`（条件定义 [types.go#L3751-L3753](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/core/v1/types.go#L3751-L3753)）。
- **磁盘满**：`DiskPressure` → kubelet 驱逐；checkpoint 写失败会先以应用错误出现。

### 1.7 设备故障

Xid 是驱动打到内核日志的错误码，格式（官方示例）为 `NVRM: GPU at 0000:03:00: GPU-...` 后接
`NVRM: Xid (0000:03:00): 14, Channel 00000001`（[XID Errors r555](https://docs.nvda.net.cn/deploy/xid-errors/index.html)；
英文原页 <https://docs.nvidia.com/deploy/xid-errors/index.html>）。与本主题相关的码：

| Xid | 含义 | 处理方向 |
|---|---|---|
| 48 | DBE（双位）ECC 错误 | 该卡不可信，drain + reset/RMA |
| 63/64 | ECC page retirement / row remapping | 记录并观察；容量/带宽可能已降级 |
| 74 | NVLink 错误 | 整机（含 NVSwitch）排查，非单 Pod |
| 79 | GPU has fallen off the bus | 节点级故障，必须换节点 |
| 94 / 95 | contained / uncontained ECC error | 94 可能只需重启进程；95 需整卡复位 |
| 119/120 | GSP RPC timeout / GSP error | 常见为掉卡前兆 |

采集：`dmesg -T | grep -i xid`、`nvidia-smi -q`（ECC 模式、retired pages、remapped rows）、`rdma statistic`
（`rnr_nak_retry_err`、`local_ack_timeout_err` 增长即链路劣化）、`mlxlink -d <mst_device>` 看链路宽度/速率/误码
（[networking_troubleshooting.rst#L124-L160](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/docs/userguide/source/troubleshooting/networking_troubleshooting.rst#L124-L160)）。
设备故障的第一手证据在节点上，不在 Pod 事件里；Pod 侧只会看到 `CUDA error` 或 NCCL `remote process exited`。

## 2 首发 vs 连锁

**「所有 rank 都报 NCCL timeout」不等于 NCCL 有问题**：NCCL 自己就把这条错误定义成二义性的。
`ncclGetErrorString(ncclRemoteError)` 返回 `remote process exited or there was a network error`，
`ncclUnhandledCudaError` 返回 `unhandled cuda error (run with NCCL_DEBUG=INFO for details)`
（[init.cc#L4043-L4064](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L4043-L4064)）。
即：**对端进程先死** 与 **网络先坏** 在 NCCL 看来是同一个错误；其余 N-1 个 rank 的 timeout 是「有人在集合通信里缺席」的必然结果。

三条独立证据链，按可靠性排序：

1. **退出码与信号**：`137`（OOM kill）/`139`（段错误）/`1`（异常）是该 rank 自身终止；`-15 (SIGTERM)`/`-9` 是被别人杀（torchrun 停机、控制器删除）。有 `137/139/1` 的 rank 才是首发候选。
2. **时间戳**：torchrun 的 `ChildFailedError` 按 timestamp 取最早失败者，并标注 `Root Cause (first observed failure)`
   （[errors/__init__.py#L193-L202](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/errors/__init__.py#L193-L202)，
   实现见 [#L248-L250](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/errors/__init__.py#L248-L250)）；
   agent 只按最早失败打一行 `failed (exitcode: ...) local_rank: ... (pid: ...) of binary: ...`
   （[multiprocessing/api.py#L1002-L1010](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/api.py#L1002-L1010)）。
   容器场景下该 timestamp 精度有限，需配 `kubectl logs --timestamps` 或采集侧纳秒时间。
3. **节点侧**：`kubectl describe pod` 的 `Last State`/`Events`、`kubectl get events --sort-by=.lastTimestamp`、
   `kubectl describe node` 的 conditions/taints、`dmesg` 的 Xid。Xid 79/48 出现时，前面所有 NCCL 报错都不重要。

**诊断顺序（建议固化为 runbook）**：

1. 找「谁先退出」：按 (exitCode 非 0 且非 -15/-9) ∧ (最早 timestamp) 定位；没有候选即 hang。
2. 找「谁先丢心跳」：`kubectl get pods -o wide` 看 restartCount、phase 变化时间；Node conditions/lease。
3. 区分「组重启 N 次」与「同一 rank 死 N 次」：`restartCount` 与 `TORCHELASTIC_RESTART_COUNT` 对照。
4. 前三步都指向通信层才看 NCCL：`NCCL_DEBUG=INFO` + 各 rank 最后入队的 op/seq，比对各 rank 的 collective 序列是否一致
   （不一致 → 应用层 mismatch；一致但缺人 → 有人退出）。
5. 若是 IB 完成错误，按 NCCL 自带 HINT 分流：`IBV_WC_RETRY_EXC_ERR` → `NCCL_IB_TIMEOUT` 过短；
   `IBV_WC_LOC_PROT_ERR` → ACS 打开破坏 GPUDirect RDMA；`IBV_WC_WR_FLUSH_ERR` → 同机 NIC 互不通
   （[net_ib/common.h#L758-L780](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/transport/net_ib/common.h#L758-L780)）。
6. 最后才怀疑 NCCL 版本/参数——证据强度最低。

判断口诀：**所有 rank 同时报同一句 timeout ≈ 单点退出的连锁反应；各 rank 报不同 op/不同阶段 ≈ 配置或 mismatch。**

## 3 框架/编排的恢复语义（代码级）

### 3.1 torchrun elastic

- **恢复单元 = worker group（本机全部 local worker）**：`UNHEALTHY`/`FAILED` 且 `_remaining_restarts > 0` 就整组重建，否则停机
  （[api.py#L945-L961](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L945-L961)）。
- **成员变化也整组重启，但不消耗预算**：`HEALTHY` 时 `num_nodes_waiting() > 0` 即重启，注释写
  `membership changes do not count as retries`
  （[api.py#L962-L976](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L962-L976)）。
  这也是跨节点传播机制：某机重启后重新 rendezvous，其它 agent 下个 tick 看到 waiting node 就重启本地 worker，
  **于是「全组重启、PG 整体重建」是设计行为**。
- **预算是 `--max-restarts`，CLI 默认 0**（[run.py#L552-L558](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L552-L558)）；
  以代码构造 `WorkerSpec` 时默认 3（[api.py#L95](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L95)）。
  「用 torchrun 起、以为有 3 次重试」是常见误判。
- **可观测**：worker 环境注入 `TORCHELASTIC_RESTART_COUNT`/`_MAX_RESTARTS`/`_RUN_ID`
  （[local_elastic_agent.py#L444-L449](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L444-L449)），
  agent 日志形如 `[default] Worker group FAILED. 3/3 attempts left; will restart worker group`。
- **没有心跳/进度检测**（§1.4），容器 liveness 与 torchrun 都发现不了 hang；必须外部 watchdog。

### 3.2 JobSet

- **失败判定来自子 Job 的 `JobFailed` condition 的 reason/message**，规则顺序匹配 `onJobFailureReasons`
  （如 `BackoffLimitExceeded`/`DeadlineExceeded`）与 `onJobFailureMessagePatterns`（RE2），可按 `targetReplicatedJobs` 限定
  （[jobset_types.go#L487-L518](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L487-L518)、
  匹配实现 [failure_policy.go#L142-L168](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L142-L168)）。
- **五个动作**：`FailJobSet`、`RestartJobSet`、`RestartJobSetAndIgnoreMaxRestarts`、`RestartJob`、`RestartJobAndIgnoreMaxRestarts`
  （[#L458-L485](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L458-L485)）。
  `RestartJob` 只重建失败的那个 Job——这是**子组恢复**在 JobSet 的落点。
- **默认行为易踩坑**：没写 `failurePolicy` → 直接 `Failed` 不重启（[failure_policy.go#L52-L60](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L52-L60)）；
  写了但没有规则命中 → 默认 `RestartJobSet`（[#L45](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L45)）。
- **预算是 `maxRestarts`**，比对 `restartsCountTowardsMax + Σ jobRestartsCountTowardsMax`
  （[failure_policy.go#L236-L240](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L236-L240)、
  [#L558-L560](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L558-L560)）。
  `maxRestarts: 0` 等价「第一条命中规则即失败」；超限 reason 为 `ReachedMaxRestarts`。
- **重启策略** `restartStrategy`：`Recreate`（默认）、`BlockingRecreate`（全删再建）、`InPlaceRestart`（原地重启健康 Pod）
  （[#L548-L570](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L548-L570)）。
- **SuccessPolicy**：`All`/`Any` + `targetReplicatedJobs`，用于「launcher 成功即整组成功」
  （[#L573-L584](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L573-L584)）。

### 3.3 LWS

- `restartPolicy` 默认 `RecreateGroupOnPodRestart`：**任一 Pod 重建或任一容器重启即整组重建**；`RecreateGroupAfterStart` 是等首轮稳定版；
  `None` 退化为 StatefulSet 语义（[leaderworkerset_types.go#L719-L748](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L719-L748)）。
  所以「单 Pod 重启会不会带走整组」取决于该字段，默认会。
- **预算可选**：`maxGroupRestarts` 未设时**无限重建**；设置后耗尽即终止该组、保留 leader Pod，用
  `leaderworkerset.sigs.k8s.io/recover=true` 重置（[#L452-L466](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L452-L466)）。
- **退避可选**：`restartBackoff` 要求组存在至少 `min(base*2^count, cap)` 才允许重建，base 默认 10s、cap 300s，
  从 leader 创建时间起算（[#L468-L478](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L468-L478)）。
- **执行点**：`count >= *maxGroupRestarts` 时 `terminateExhaustedGroup`，且预算判定在退避之前
  （[pod_controller.go#L713-L724](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/pkg/controllers/pod_controller.go#L713-L724)）。

### 3.4 Volcano

- **`maxRetry` 分 Job/Task 两级**，Job 级默认 3（[job.go#L96-L101](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L96-L101)、
  Task 级 [#L270-L274](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L270-L274)）。
- **计数发生在状态机动作里**：`RestartJob/RestartTask/RestartPod/RestartPartition` 都 `RetryCount++` 并进入 `Restarting`
  （[running.go#L34-L46](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/state/running.go#L34-L46)）；
  `Restarting` 下 `RetryCount >= maxRetry` 即 `Failed`
  （[restarting.go#L31-L39](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/state/restarting.go#L31-L39)）。
- **谁来触发：`lifecyclePolicy`**，可按 event（`PodFailed`/`PodEvicted`）或 **exitCode** 指定 action，action 默认 `None`
  （[job.go#L199-L225](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L199-L225)）。
  **不配 policies 时 Volcano 不会因 Pod Failed 自动重建同名 Pod**——控制器只对「不存在的 Pod 名」建 Pod
  （[job_controller_actions.go#L517-L521](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/job_controller_actions.go#L517-L521)），
  失败累积到 Running 态终局判定（`Succeeded+Failed==replicas` 且 `Succeeded<minAvailable` → `Failed`，
  [running.go#L83-L105](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/state/running.go#L83-L105)）。
- **gang**：Job 的 `minAvailable`（默认等于 tasks 副本和，[job.go#L61-L65](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L61-L65)）
  与 PodGroup `minMember`（资源不够则一个都不启，[scheduling/types.go#L165-L175](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/scheduling/types.go#L165-L175)）
  共同定义原子性；`valid < minAvailable` 时不调度并给事件（[gang.go#L84-L92](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/scheduler/plugins/gang/gang.go#L84-L92)）。
  **推论**：gang 把「部分失败」放大成「整组不可调度」，既是保护也是放大器。
- **重试是全量重建**：按 `podRetainPhase` 删 Pod，最后一次才保留 Failed/Succeeded Pod 供取证
  （[job_controller_actions.go#L178-L192](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/job_controller_actions.go#L178-L192)）。

### 3.5 Training Operator（legacy v1）与 MPIJob

- **replica 级 `restartPolicy`**：`Always/OnFailure/Never/ExitCode`，覆盖 PodTemplate 的设置；`ExitCode` 按退出码分流（§1.5）。
  语义差异决定恢复单元：`ps` 建议 `Always`（本不该退出）；`chief`/`worker` 建议 `OnFailure`；
  `chief` 负责编排与 checkpoint，chief 掉等于语义上整组要重启；`Never` 把任何非零退出当永久失败，等于放弃自愈。
  出处 [tensorflow.md#L138-L160](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/legacy-v1/user-guides/tensorflow.md#L138-L160)。
- **`runPolicy`**：`cleanPodPolicy`（默认 `None`）、`ttlSecondsAfterFinished`、`activeDeadlineSeconds`、`backoffLimit`
  （[common_types.go#L194-L214](https://github.com/kubeflow/training-operator/blob/c77ee3ff4d21aa8e5027580d83361c1a426ee789/pkg/apis/kubeflow.org/v1/common_types.go#L194-L214)）。
  `backoffLimit` 判定混两条路：失败 Pod 计数 + 容器 `restartCount` 之和（仅 OnFailure/Always/ExitCode），
  并混入 `WorkQueue.NumRequeues` 作为「已重试次数」
  （[job.go#L176-L198](https://github.com/kubeflow/training-operator/blob/3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d/pkg/controller.v1/common/job.go#L176-L198)、
  `PastBackoffLimit` [#L413-L420](https://github.com/kubeflow/training-operator/blob/3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d/pkg/controller.v1/common/job.go#L413-L420)）；
  超限报 `Job %s has failed because it has reached the specified backoff limit`，超时报 `... active longer than specified deadline`
  （[#L208-L214](https://github.com/kubeflow/training-operator/blob/3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d/pkg/controller.v1/common/job.go#L208-L214)）。
- **Trainer V2 换了恢复单元**：`TrainJob` 只有 `activeDeadlineSeconds`（超时 → `DeadlineExceeded`）
  （[trainjob_types.go#L81-L84](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/apis/trainer/v1alpha1/trainjob_types.go#L81-L84)、
  [#L131-L139](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/apis/trainer/v1alpha1/trainjob_types.go#L131-L139)），
  底层用 JobSet；MPI runtime 用 `successPolicy: targetReplicatedJobs: [launcher]` + `dependsOn: status Ready` 表达
  「launcher 成功即成功、node 先 Ready 再起 launcher」（[migration.md#L155-L170](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/operator-guides/migration.md#L155-L170)）。
- **MPIJob 的恢复边界 = launcher 这个 K8s Job**：launcher 以 Job 创建，`backoffLimit`/`activeDeadlineSeconds` 取自 `runPolicy`，
  并设 `podReplacementPolicy: Failed`（[mpi_job_controller.go#L1560-L1580](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1560-L1580)）。
  worker 是**裸 Pod**，只在「不存在」时补建（[#L1017-L1022](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1017-L1022)），
  **Failed 的 worker 不会被重建**——mpirun 等不到对端而挂住，只能靠 `activeDeadlineSeconds` 收场。
  失败原因从 launcher Job 的 `JobFailed` condition 反填 MPIJob（[#L1204-L1225](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1204-L1225)）。

### 3.6 K8s Job（多数编排器的底座）

- `backoffLimit` 默认 6；设 `backoffLimitPerIndex`（仅 Indexed）时默认变 2147483647
  （[types.go#L352-L356](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L352-L356)）。
- `podFailurePolicy` 需 `restartPolicy: Never`（校验强制，[validation.go#L300-L312](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/apis/batch/validation/validation.go#L300-L312)）；
  `Ignore` 不增加 `.status.failed`，`Count` 才增加（[types.go#L135-L144](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L135-L144)）；
  控制器侧只有 `countFailed` 的 Pod 进 `uncountedStatus.Failed`
  （[job_controller.go#L1360-L1378](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/job/job_controller.go#L1360-L1378)）。
- `backoffLimitPerIndex` + `maxFailedIndexes`：重试从作业级降到 index 级，失败 index 数超限整 Job 失败
  （[types.go#L358-L378](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L358-L378)），
  每 index 失败次数记在 Pod 注解 `batch.kubernetes.io/job-index-failure-count`。
- `successPolicy` 只对 Indexed Job 生效，满足即终止其余 Pod（[types.go#L343-L350](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L343-L350)）。
- **哪些故障计一次重试**：Pod `Failed` 且判定 `countFailed` 时 +1；容器内重启（`OnFailure`）**不计**；`Evicted` 默认计；
  `activeDeadlineSeconds` 到期不是「重试」而是直接失败（`DeadlineExceeded`，[types.go#L699-L706](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L699-L706)）。

### 3.7 恢复单元对照

| 编排器 | 默认恢复单元 | 触发条件 | 预算字段 | 成员变化计费 |
|---|---|---|---|---|
| torchrun | 本机 worker group（全体 rank 重建 PG） | 本地 worker 失败 / 新节点加入 | `--max-restarts`（默认 0） | 否 |
| JobSet | JobSet 全局 或 单个子 Job | 子 Job `JobFailed` 命中规则 | `failurePolicy.maxRestarts` | 计入同一池 |
| LWS | 整个 group | 任一 Pod/容器重启 | `maxGroupRestarts`（默认无限） | 不适用 |
| Volcano | Job / Task / Pod / Partition | `lifecyclePolicy` 的 event/exitCode | `maxRetry`（默认 3） | 不适用 |
| Training Operator v1 | 单 replica | `restartPolicy` | `backoffLimit` | 不适用 |
| MPIJob | launcher Job | launcher 容器失败 | `runPolicy.backoffLimit` | 不适用 |
| K8s Job | 单 Pod / 单 index | Pod `Failed` | `backoffLimit` / `backoffLimitPerIndex` | 默认计入 |

## 4 失败预算与避免无限重试

### 4.1 分层预算模型

| 层 | 目的 | 机制 | 对应 API |
|---|---|---|---|
| L0 容器内 | 应对单次瞬时崩溃 | 原地重启 | `restartPolicy: OnFailure/Always`（**不计数**，只作最内层兜底） |
| L1 进程/组 | 限制「同一组失败几次」 | 计数 + 整组重建 | torchrun `--max-restarts`；Volcano `maxRetry`；LWS `maxGroupRestarts` |
| L2 作业 | 限制「重建几次」并退避 | 计数 + 指数退避 | JobSet `maxRestarts` + `restartStrategy`；LWS `restartBackoff` |
| L3 时间 | 给「不失败也不前进」封顶 | 墙钟 deadline | `activeDeadlineSeconds`（Job/JobSet/TrainJob/MPIJob） |
| L4 队列 | 限制「反复排队」与占坑 | requeue 计数 + 退避 + 停用 | Kueue `requeuingStrategy.backoffLimitCount`、`maximumExecutionTimeSeconds` |
| L5 人 | 熔断后交给人 | 标记/隔离/告警 | Volcano `AbortJob`、LWS `recover` 注解、JobSet `FailJobSet` |

推荐写进平台默认值的判定式：

```
允许重启 ⇔ (n_restart < N_max) ∧ (window_restarts < R_max) ∧ (now < deadline) ∧ ¬circuit_breaker
```

- **退避**：可用 LWS `restartBackoff` 语义（`min(base*2^count, cap)`，从创建时间起算，§3.3）或 Kueue 的
  `b*2^(n-1)+Rand`（默认 60s 起、上限 3600s，[configuration_types.go#L464-L490](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/config/v1beta2/configuration_types.go#L464-L490)）。
- **熔断**：出现设备类证据（Xid 79/48/95）立即停，重试只会重复烧预算。
- **人工阈值**：`maxRestarts` 耗尽、`backoffLimitCount` 耗尽（Kueue 会 `deactivate`，
  [workload_controller.go#L1044-L1050](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/controller/core/workload_controller.go#L1044-L1050)）、LWS 预算耗尽（等 `recover=true`）。

### 4.2 常见配置漏洞

1. **只设 `restartPolicy: Always`/`OnFailure`**：kubelet 原地重启，`Job.status.failed` 不增长，`backoffLimit` 永不触发 →
   OOM/断言循环可以跑到天荒地老。K8s Job 甚至直接拒绝 `Always`（[validation.go#L302-L305](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/apis/batch/validation/validation.go#L302-L305)），
   用户退而用 `OnFailure`，同样不计数。
2. **只设 `backoffLimit`**：a) 容器内 **hang 不产生 Pod 失败**，预算不消耗；b) 节点故障/驱逐**会**计入，坏节点吃光预算而真正的
   bug 还没开始重试；c) 无时间上限、无退避，重试风暴打满队列。
3. **JobSet 的 deadline 被重启重置**：全局重启会 `resetStartTimeOnGlobalRestart`
   （[active_deadline.go#L61-L76](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/active_deadline.go#L61-L76)），
   `activeDeadlineSeconds` 实际是「每次尝试」的上限；总预算要在平台层自己记。
4. **torchrun 默认不重启**（§3.1）：「加了 JobSet 就有重试」不成立——Pod 内 torchrun 先退出，Job 层才看到一个失败 Pod。
5. **LWS 默认无限重建 + 整组重建**：单 Pod 抖动带走整组，在 gang 下把「1 个坏 Pod」放大成「N 卡重新排队」。
6. **MPIJob 的 worker 失败不计费**（§3.5）：预算只在 launcher 侧，hang 期间没有任何计数增长。
7. **Volcano 不配 `lifecyclePolicy`**：默认 `None`，Pod 失败不重建、直接走向终态（§3.4）；配了 `RestartJob` 又只用默认
   `maxRetry: 3`，等于 3 次全量重建后放弃。
8. **Kueue `backoffLimitCount` 默认 null = 无限 requeue**（[configuration_types.go#L464-L475](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/config/v1beta2/configuration_types.go#L464-L475)）；
   `maximumExecutionTimeSeconds` 只对 **admitted 后**的时间计费（[workload_types.go#L79-L88](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/workload_types.go#L79-L88)）。

## 5 决策表

| 故障类型 | 检测信号 | 爆炸半径 | 推荐恢复单元 | 对应 API | 预算注意点 |
|---|---|---|---|---|---|
| 调度失败（配额/亲和/gang 不齐） | `Pending` + `FailedScheduling`；PodGroup `Pending` | 整组（gang 下 0 个启动） | **不恢复**，等容量或换队列 | Kueue 队列配额；Volcano `minAvailable`/`minMember` | 不计失败；用 `waitForPodsReady.timeout` 防永久排队 |
| 镜像拉取失败 | `ErrImagePull`/`ImagePullBackOff` | 该 Pod → 整组 | 换镜像/修 registry 后整 Job 重建 | `podFailurePolicy` `Ignore`/`FailJob`；JobSet `onJobFailureReasons` | 应 `FailJobSet` 而非重试，否则空转 |
| 配置/权限错误（秒退 1/2） | `restartCount` 快涨、首行即错 | 整组 | **不自动恢复**，直接失败 | `podFailurePolicy` `onExitCodes In [1,2]` → `FailJob` | 不能与 OOM 共用预算 |
| rendezvous/TCPStore 超时 | 全体 rank 同时 init 超时（600s） | 整组 | 整组（重建 PG） | torchrun 重启；JobSet `RestartJobSet` | 先确认是否有 rank 没被调度，否则重试无用 |
| 单 rank OOMKilled 137 | `reason: OOMKilled`、exitCode 137 | 单 rank → 整组 | 进程/组（先调资源再重启） | TFJob `ExitCode`（137 可重试）；`--max-restarts` | 连续 137 必须熔断 |
| CUDA assert / illegal access（1/139） | stderr 的 CUDA error、exitCode 1/139 | 单 rank → 整组 | 整 Job，且**先隔离节点** | `podFailurePolicy` `In [139]` → `FailJob` | 视为永久错误，不重试 |
| 被 SIGTERM（143） | exitCode 143、`lastState.reason=Error` | 可能整组 | 先查「谁发的 SIGTERM」 | 视来源：驱逐/抢占/滚动更新 | 驱逐应 `Ignore`（`DisruptionTarget`） |
| 集合通信 hang（watchdog 超时） | watchdog timeout、各 rank 最后 op 不同 | 整组 | 整组（重建 PG），保留首个失败证据 | torchrun/JobSet 重启；MPI 靠 `activeDeadlineSeconds` | 无 deadline 的 hang 永不计费 → 必须补 L3 |
| 慢节点（无报错、吞吐掉） | step 时间分布、`NCCL_DEBUG=INFO` 时序 | 整组性能 | 换节点（不重启进程） | 平台 drain/反亲和；无直接 API | 不在任何失败预算内，需专门检测 |
| Node NotReady / kubelet 失联 | Node conditions + taint；Pod 数分钟后 Failed | 整节点 | 换节点，整组重建 | 反亲和/拓扑分布；`podFailurePolicy` `Ignore` 驱逐 | 默认驱逐计费，坏节点会吃光预算 |
| 设备故障（Xid 79/48/95） | `dmesg` Xid、`nvidia-smi -q`、`rdma statistic` | 单卡 → 整机 → 整组 | 换节点 + 隔离设备 | GPU Operator/设备插件健康检查；节点 drain | 立即熔断，禁止重试 |
| 存储/磁盘满 | `DiskPressure`、checkpoint 写失败 | 整节点 | 换节点；清理 PVC | `emptyDir` sizeLimit、PVC 配额 | 与训练失败分开记账 |

## 6 真实错误签名

以下文本均来自本稿核过的源码/官方文档，未改写；`%s` 为代码中的格式占位符。

1. **NCCL 的两条二义错误**：`remote process exited or there was a network error`（`ncclRemoteError`）与
   `unhandled cuda error (run with NCCL_DEBUG=INFO for details)`（`ncclUnhandledCudaError`）
   —— [init.cc#L4043-L4064](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L4043-L4064)。
2. **collective watchdog 超时**：`Watchdog caught collective operation timeout: NCCL operation timed out`
   —— [WorkNCCL.cpp#L209-L212](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/WorkNCCL.cpp#L209-L212)。
3. **torchrun 首个失败进程**：`failed (exitcode: %s) local_rank: %s (pid: %s) of binary: %s`
   —— [multiprocessing/api.py#L1006-L1010](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/api.py#L1006-L1010)。
4. **torchrun 失败报告头**：`Root Cause (first observed failure):`
   —— [errors/__init__.py#L193-L202](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/multiprocessing/errors/__init__.py#L193-L202)。
5. **DDP 集体通信不匹配**：`Expected to have finished reduction in the prior iteration before starting a new one`
   —— [reducer.cpp#L2205-L2213](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/reducer.cpp#L2205-L2213)。
6. **IB 完成错误的三条 HINT**：`HINT: In many cases this error indicates that NCCL_IB_TIMEOUT is set too short (the default value is 20, which is ~30 seconds before timing out).` /
   `HINT: In many cases this error indicates that ACS is enabled, which breaks the GPU Direct RDMA protocol.` /
   `HINT: In many cases this error indicates that NICs on the same node cannot talk to each other.`
   —— [net_ib/common.h#L758-L780](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/transport/net_ib/common.h#L758-L780)。
7. **Xid 内核日志格式（官方示例）**：`NVRM: GPU at 0000:03:00: GPU-...` 后接 `NVRM: Xid (0000:03:00): 14, Channel 00000001`
   —— [NVIDIA XID Errors r555 / 查看 Xid 消息](https://docs.nvda.net.cn/deploy/xid-errors/index.html)；
   同页列表中 Xid 79 为「GPU 已从总线脱落」，94/95 为「包含的/未包含的 ECC 错误」。
8. **K8s Job 失败原因**：`BackoffLimitExceeded` / `DeadlineExceeded` / `FailedIndexes`
   —— [batch/v1 types.go#L699-L706](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L699-L706)。
9. **Volcano gang 不可调度事件**：`Not enough valid tasks for gang-scheduling, valid: %d, min: %d`
   —— [gang.go#L84-L92](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/scheduler/plugins/gang/gang.go#L84-L92)。
10. **JobSet 预算耗尽 / 无策略失败**：`jobset failed due to reaching max number of restarts` /
    `jobset failed due to one or more job failures`
    —— [constants.go#L54-L61](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/constants/constants.go#L54-L61)。
11. **legacy v1 backoff/deadline 失败消息**：`Job %s has failed because it has reached the specified backoff limit`
    —— [job.go#L208-L214](https://github.com/kubeflow/training-operator/blob/3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d/pkg/controller.v1/common/job.go#L208-L214)。
12. **Kueue 超时驱逐**：reason `MaximumExecutionTimeExceeded`、message `exceeding the maximum execution time`
    —— [workload_controller.go#L1044-L1050](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/controller/core/workload_controller.go#L1044-L1050)。
13. **OOMKilled 判定**：CRI 规定 cgroup OOM 杀掉的容器必须把 `reason` 置为 `"OOMKilled"`，用户侧对应 `exitCode: 137`
    —— [api.proto#L1537-L1540](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/cri-api/pkg/apis/runtime/v1/api.proto#L1537-L1540)；
    `kubectl describe pod` 中 `Reason: OOMKilled` / `Exit Code: 137` 的示例见
    [Assign Memory Resources](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)。

> 注：本 SHA 的 PyTorch 已把 `ProcessGroupNCCL` 迁到 `c10d/nccl2/`，旧版常见的
> `Watchdog caught collective operation timeout: WorkNCCL(...) ran for ... milliseconds before timing out`
> 在该目录 `grep` 无命中，故只引用现存字符串，避免张冠李戴。

## 7 不确定 / 需复核

1. **`TFJob`/`PyTorchJob` 的 `successPolicy` 不存在于 legacy v1 API**：v1.9.3 与 release-1.9 head 的 `RunPolicy` 只有
   `cleanPodPolicy/ttlSecondsAfterFinished/activeDeadlineSeconds/backoffLimit/schedulingPolicy/suspend/managedBy`
   （[common_types.go#L194-L214](https://github.com/kubeflow/training-operator/blob/c77ee3ff4d21aa8e5027580d83361c1a426ee789/pkg/apis/kubeflow.org/v1/common_types.go#L194-L214)）。
   `successPolicy` 只在 JobSet / K8s Job / Trainer V2 runtime 层存在；任务描述里的「TFJob successPolicy」应改述。
2. **legacy v1 默认 `restartPolicy` 自相矛盾**：`ReplicaSpec.RestartPolicy` 注释写 `Default to Never`
   （[common_types.go#L106-L109](https://github.com/kubeflow/training-operator/blob/c77ee3ff4d21aa8e5027580d83361c1a426ee789/pkg/apis/kubeflow.org/v1/common_types.go#L106-L109)），
   而 `RestartPolicy` 类型注释写 `default one is RestartPolicyAlways`
   （[#L172-L176](https://github.com/kubeflow/training-operator/blob/c77ee3ff4d21aa8e5027580d83361c1a426ee789/pkg/apis/kubeflow.org/v1/common_types.go#L172-L176)）。
   应以 webhook defaulting 为准，但该代码不在 master checkout 内，未核实。
3. **legacy v1 控制器不在本 checkout**：`backoffLimit` 与状态机逻辑取自 release-1.9 分支文件，未与 v1.9.3 tag 逐行 diff。
4. **`previousRetry := jc.WorkQueue.NumRequeues(jobKey)`**（[job.go#L176](https://github.com/kubeflow/training-operator/blob/3a3a1da8d5287f9f96e1b2d3be6a4b6ad756566d/pkg/controller.v1/common/job.go#L176)）
   把 workqueue requeue 次数混进「已重试次数」，与「失败 Pod 数」不是同一维度，实际影响未验证。
5. **MIG 异常**未找到一手判据：`nvidia-smi mig -lgi` 的失败形态、MIG 实例级 Xid 与整卡 Xid 的区别需再查 NVIDIA MIG 文档；
   本稿只在决策表写「设备故障」，未细分 MIG。
6. **Xid 页面**：`docs.nvidia.com` 在本环境不可达（TLS/网络），引用的是 NVIDIA 官方中文镜像 `docs.nvda.net.cn`（r555，2024-09-24）；
   英文原页与更新版本可能新增错误码，需复核。
7. **Volcano `lifecyclePolicy.Timeout` 与 `maxRetry` 的交互**（延迟执行的动作是否跨重试计数）未验证。
8. **Kueue `maximumExecutionTimeSeconds` 向 JobSet/TrainJob 的传播路径**（是否由集成层自动写入）未验证。
9. **torchrun 跨节点传播的确切时序**：依赖各 agent 的 `monitor_interval`（默认 0.1s，[run.py#L561-L566](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L561-L566)），
   但「谁先看到」的时序未实测。
10. **`CUDA error: an illegal memory access was encountered` 未找到一手出处**：该串来自 CUDA runtime（`cudaErrorIllegalAddress` 类），
    在 pytorch/nccl 仓库中 `grep` 无命中（只有测试注释提到 illegal memory access），故未列入 §6；
    决策表只把它归入「设备/内存错误」类，确切文本需按 NVIDIA CUDA Runtime API 文档复核。
