# RESEARCH：CPU / GPU 异构资源管理与设备运维

- 日期：2026-11-27
- 范围：Kubernetes 节点资源语义、GPU 软件接入链路、共享/隔离/拓扑、GPU 故障处置、训推混部
- 产出：`src/docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/` 下 6 篇（总览 + 5 篇）
- 说明：本机是 WSL，`nvidia-smi` 报 `GPU access blocked by the operating system`，没有可用的
  真实 GPU；因此本文档**没有做性能 benchmark**，所有带宽/延迟数字都是量级参考，拓扑/故障结论
  来自源码、官方文档和可复现命令，不来自本机实测。

## 1. 代码基线

所有 GitHub 链接固定到 40 位 commit SHA，便于复核；`verify-links.py` 已校验 98 条 pinned 链接。

| 仓库 | tag / 分支 | commit |
|---|---|---|
| kubernetes/kubernetes | v1.37.2 | `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` |
| containerd/containerd | v2.4.2 | `b7a25261e029d68978bbf290df0a62fc819b3c51` |
| NVIDIA/k8s-device-plugin | v0.20.2 | `17ab9a55d400ecc8d5a6c781a35f2744907fdd60` |
| NVIDIA/gpu-operator | v26.7.3 | `dd9e4347feefa8e46622c78b8bd799820710bf10` |
| NVIDIA/DCGM | v4.7.0 | `9fae2867e6e5264fa0fca22a07dc898d591baa21` |
| NVIDIA/nvidia-container-toolkit | v1.20.2 | `adbd28c39b60f8eb7e03115b5ac61e58703f0ce7` |
| NVIDIA/k8s-dra-driver-gpu | v25.12.0 | `0882da8720c28763137e0987778ec476ec4cf8df` |
| kubernetes-sigs/node-feature-discovery | v0.20.1 | `848df700cb6438122b0ede644b4ca6bf2ac4234f` |
| NVIDIA/dcgm-exporter | 4.9.0 | `4e663a526c4624ad0e18ad816f09b7be2c5348a7` |
| NVIDIA/go-nvml | v0.13.4-1 | `1a1e86da474d340d7cf58274588f4a4afc8772e7` |
| kubernetes-sigs/kueue | v1beta2（HEAD） | `be7dc9d31470258dd324e5bd6d84f7eaf90f5f69` |
| torvalds/linux（sparse） | v7.3 | `c03c1a14507dfaf8b856c2608f9ac216021fc222` |

## 2. 核心结论（按页）

### 2.1 CPU/内存/节点

- kubelet 把 CPU request 转成 `cpu.shares`/`cpu.weight`，CPU limit 转成 CFS quota/`cpu.max`；
  memory limit 转成 `memory.max`；memory request 默认**不**预留，只有 MemoryQoS 的
  `TieredReservation` 才写 `memory.min`/`memory.low`。
- MemoryQoS 在 1.37 是 Beta 默认开启，但 `memoryThrottlingFactor` 默认 nil、
  `memoryReservationPolicy` 默认 None；「默认开启」不等于默认生效。
- CPU static policy 只对 Guaranteed + 整数 CPU 生效；1.37 中 exclusive CPUs 不再受 CFS quota
  限制（`DisableCPUQuotaWithExclusiveCPUs` 锁定 true）；但系统守护进程仍可运行在独占 CPU 上，
  且 kubelet 不设置 `cpuset.cpus.partition`。
- Memory Manager Static 只对 Guaranteed 生效，写 `cpuset.mems`，不限制内存量；`reservedMemory`
  必须等于 `kubeReserved + systemReserved + evictionHard`。
- Topology Manager 只合并 hint provider 的 NUMA hint；device plugin 的 `TopologyInfo` 只有
  NUMA node ID，没有 NVLink/PCIe 距离。
- 节点 `memory.available = capacity - workingSet`；默认 evictionHard 100Mi；OOM score
  Guaranteed -997 / BestEffort 1000 / Burstable 按 request 比例。

### 2.2 GPU 接入链路

- device plugin：注册 → ListAndWatch → kubelet 上报 extended resource → Allocate → CRI →
  runtime hook/CDI。分配账本在 `/var/lib/kubelet/device-plugins/kubelet_internal_checkpoint`。
- device plugin unhealthy：只降 allocatable，不降 capacity，不迁移已分配 Pod；NVIDIA 插件健康
  事件是单向的，恢复要重启插件（源码 FIXME）。
- DRA：ResourceSlice/DeviceClass/ResourceClaim/ResourceClaimTemplate；调度器分配，
  kubelet 调 `NodePrepareResources`，驱动返回 CDI device IDs，runtime 注入。
- NVIDIA DRA Driver v25.12：ComputeDomain 正式支持；GPU DRA plugin 实验性、Helm 默认关闭；
  GPU 属性有 UUID/productName/PCI BDF/MIG profile，但**没有 NVLink/NUMA 拓扑属性**。
- DRA 不支持调度器抢占（官方 Limitations）；DeviceTaints 1.37 GA，`NoExecute` 会驱逐 Pod；
  NVIDIA DRA driver 当前是「从 ResourceSlice 移除 unhealthy 设备」，需重启恢复。

### 2.3 共享/隔离/拓扑

- time-slicing：replica 只是调度槽位；无内存/故障隔离；`renameByDefault` 和
  `failRequestsGreaterThanOne` 是防误用的开关。
- MPS：SM 百分比 + Volta+ per-client memory limit；地址空间隔离，但错误不隔离（server FAULT
  会影响同 GPU 客户端）；带宽/L2 无 QoS；device plugin 的 MPS 不支持 MIG。
- MIG：GI/CI；显存、L2、DRAM 带宽、SM、引擎硬件分区；故障隔离；但**不支持 GPU-GPU P2P
  （PCIe/NVLink）**，跨 GI CUDA IPC 不支持；适合推理多租户，不适合训练主路径。
- CUDA memory limit hook：NVML `SetMemoryLimits_v1` + cgroup v2，只限容量，不限带宽/故障域。
- Topology Manager 不会按 NVLink 放置；NVLink/PCIe/NIC 需要 DRA 属性、自定义调度或节点分组。
- `nvidia-smi topo -m` 图例：PIX/PXB/PHB/SYS/NODE/NV#；`-p2p` 查 P2P；`-mp` 只看 PCIe。

### 2.4 GPU 运维

- Xid 13/31/43/45/109 等多为应用错误；63/64 是行重映射过程；94 contained；95/140 uncontained；
  79 掉总线；74 NVLink；119/120 GSP；121 C2C corrected；137 NVLink FLA。
- device plugin 默认忽略 13/31/43/45/68/109；DCGM 默认只把 Xid 119 当 fatal；dcgm-exporter
  默认导出 XID、row remap 393–395、NVLink throughput，但 ECC/page retirement/NVLink 错误计数/
  health status 默认是注释或缺失的。
- ECC 要区分 SBE/DBE、volatile/aggregate、page retirement/row remap；RMA 不是「一个 DBE 就换卡」，
  行重映射失败 + 现场诊断才是强信号（同一 bank 8 个不可纠正行等）。
- 三种 OOM：GPU 显存 OOM / 容器 cgroup OOM / 节点 OOM；处置完全不同。
- 处置顺序：停止新分配 → 隔离 → 重试（必要时 reset）→ 升级/RMA；证据保留优先。

### 2.5 训推混部

- 推荐分层：生产推理独立池；训练独立池/可借用；开发共享池。
- Kueue 提供 nominalQuota/borrowingLimit/lendingLimit/cohort/preemption/stopPolicy/
  maximumExecutionTimeSeconds；`reclaimablePods` 是「释放配额」，不是抢占。
- 推理 CQ `lendingLimit: 0` 保护配额；训练 CQ 设 `borrowingLimit` 上限。
- DRA 无调度器抢占，所以高优先级推理不能靠 kube-scheduler 抢 DRA 训练；用 Kueue/独立池。
- 容量模型：权重 + KV cache + workspace + headroom；训练 16 bytes/param（混合精度 Adam）
  + 激活；抢占损失 ≈ checkpoint 间隔/2 + 写 checkpoint + 重启。
- 尾延迟：不要用 GPU utilization 判断隔离；看 TTFT/TPOT/p99、SM occupancy、DRAM util。

## 3. 主要来源

### Kubernetes

- <https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/>
- <https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/>
- <https://kubernetes.io/docs/concepts/resource-management/effective-pod-requests-limits/>
- <https://kubernetes.io/docs/concepts/resource-management/resource-managers/>
- <https://kubernetes.io/docs/concepts/resource-management/pod-level-resource-managers/>
- <https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/>
- <https://kubernetes.io/docs/tasks/administer-cluster/memory-manager/>
- <https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/>
- <https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/>
- <https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/>
- <https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/>
- <https://kubernetes.io/docs/concepts/resource-management/dynamic-resource-allocation/>
- <https://kubernetes.io/docs/concepts/resource-management/dynamic-resource-allocation/how-dra-works/>
- <https://kubernetes.io/docs/concepts/resource-management/dynamic-resource-allocation/device-taints/>
- <https://kubernetes.io/docs/concepts/resource-management/dynamic-resource-allocation/dra-observability/>
- <https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/>

### NVIDIA

- <https://docs.nvidia.com/deploy/xid-errors/index.html>
- <https://docs.nvidia.com/deploy/a100-gpu-mem-error-mgmt/index.html>
- <https://docs.nvidia.com/datacenter/tesla/mig-user-guide/index.html>
- <https://docs.nvidia.com/deploy/mps/index.html>
- <https://docs.nvidia.com/deploy/nvidia-smi/index.html>
- <https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html>
- <https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html>
- <https://docs.nvidia.com/cuda/gpudirect-rdma/index.html>
- <https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/>

### 内核 / Kueue / vLLM

- <https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/admin-guide/cgroup-v2.rst>
- <https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/accounting/psi.rst>
- <https://kueue.sigs.k8s.io/>
- <https://docs.vllm.ai/en/latest/configuration/engine_args.html>

## 4. 未决/版本敏感点

1. **MPS v3**：NVIDIA 2026 文档已引入 v3（namespaces、SM partitions、memory partitioning），
   但 device plugin/DRA driver 当前主要使用 v2 控制命令（`set_default_active_thread_percentage`、
   `set_default_device_pinned_mem_limit`）。文档只把 v3 作为「存在且需按版本确认」的提示，
   没有把 v3 的新隔离能力写成所有环境都成立。
2. **NVIDIA DRA GPU plugin**：v25.12 仍是实验性、Helm 默认关闭；文档把它作为方向，不作为
   生产默认。
3. **Xid/RMA 阈值**：不同 GPU 代际、不同厂商现场诊断流程可能不同；文档只给通用判断，
   不替代 NVIDIA 现场诊断。
4. **内存带宽/延迟数字**：没有本机 GPU，全部是量级参考；真实选型必须用 `nvbandwidth`/
   `all_reduce_perf`/`ib_write_bw` 在目标硬件上测。
5. **Kubernetes 版本**：1.37 的 MemoryQoS、DRA、DeviceTaints 行为与 1.34 之前差异较大；
   文档在关键处标注了基线，迁移前要按目标版本复核 feature gate 与默认值。
