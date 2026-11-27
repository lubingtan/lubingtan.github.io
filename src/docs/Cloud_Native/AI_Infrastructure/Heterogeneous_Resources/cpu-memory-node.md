# CPU、内存与节点资源基础

> **结论先行**：Kubernetes 的 `requests` 和 `limits` 不是同一件事。**request 主要影响调度、QoS 和
> 保护水位；limit 才由内核通过 cgroup 强制执行**。CPU 是「可压缩」资源，超限表现为 throttling；
> 内存是「不可压缩」资源，超限表现为 reclaim/OOM。把二者当成同一种「配额」来配，是节点抖动、
> 容器被 throttle、Pod 被 OOMKilled 的最常见来源。
>
> 这一篇先把 L0 讲清楚：cgroup v1/v2 的字段映射、CPU quota 与 cpuset、内存压力与 eviction、
> 以及 CPU Manager / Memory Manager / Topology Manager 的真实作用与边界。后面 GPU 的
> NUMA 对齐、MIG 切片、训推混部，都是建立在这些语义之上的。

## 一、requests / limits 到底分别由谁执行

| 维度 | `requests` | `limits` |
|---|---|---|
| 主要作用 | 调度器选节点；QoS 分类；kubelet 计算保护水位/OOM score | 内核 cgroup 强制执行上限 |
| CPU | 转成 `cpu.weight`（v2）或 `cpu.shares`（v1）；只决定「竞争时的相对份额」 | 转成 `cpu.max`（v2）或 `cfs_quota_us`+`cfs_period_us`（v1）；超限被 throttle |
| 内存 | 默认**不**在 cgroup 里预留；只影响调度和 OOM score。开启 MemoryQoS 的 `TieredReservation` 后才写 `memory.min`/`memory.low` | 转成 `memory.max`；超限触发 cgroup 内 OOM kill |
| 超卖 | 可以超卖（节点 request 总和 ≤ allocatable 是调度约束，不是内核约束） | 不可超卖；limit 是硬上限 |
| 典型误解 | 「request 小一点没关系，反正 limit 大」 | 「limit 设了就不会 OOM」——内存 limit 是**反应式**的，只有内核检测到压力才杀 |

Kubernetes 文档对二者的区别有一个很准确的表述：CPU limit 由 **CPU throttling** 强制执行，是硬限制；
memory limit 由 **OOM kill** 强制执行，是反应式的，容器可能先超过 limit，然后在内存压力下被杀。
见 [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)。

kubelet 把 API 里的 quantity 翻译成 runtime 资源结构的关键代码在
[`calculateLinuxResources`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_container_linux.go#L354-L400)：
CPU request → `CpuShares`，CPU limit → `CpuQuota`/`CpuPeriod`，memory limit → `MemoryLimitInBytes`。
真正的 cgroup 写入由 runtime（containerd + runc）完成。

> 一个容易忽略的点：如果只写 limit 不写 request，API server 会把 request 默认成 limit
> （除非有 LimitRange 等准入机制另设）。所以「只设 limit」通常等价于「request = limit」，
> 会直接改变 QoS 和调度结果。

## 二、QoS：不是标签，是调度与驱逐的输入

| QoS | 判定条件 | CPU 行为 | 内存行为 | 驱逐/OOM 优先级 |
|---|---|---|---|---|
| **Guaranteed** | 每个容器（或 Pod 级 resources）CPU、memory 的 request 都等于 limit，且都 > 0 | 整数 CPU 可被 static CPU Manager 独占 | 最不容易被驱逐；OOM score 最低 | 最后 |
| **Burstable** | 不满足 Guaranteed，但至少一个容器/Pod 有 CPU 或 memory 的 request/limit | 共享池；有 limit 时受 CFS quota | 有 limit 时受 `memory.max`；OOM score 按 request 比例 | 中间 |
| **BestEffort** | 所有容器/Pod 都没有 CPU、memory 的 request/limit | 共享池，无 quota | 无 limit；最容易 OOM | 最先 |

判定与驱逐顺序见 [Pod QoS Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)。
注意：**QoS 不直接决定 kubelet 的驱逐顺序**。kubelet 的排序是「是否超过 request → Priority →
超过 request 的程度」；QoS 只是让你预判谁更可能超过 request。文档明确写了
`The kubelet does not use the pod's QoS class to determine the eviction order.`

### 2.1 Pod 级 resources 与 effective request

从 1.34 起 Pod 级 `spec.resources` 是 Beta 默认开启；1.37 中 Pod 级 **resource managers**
（CPU/Memory/Topology 使用 Pod 级 resources）还是 Beta 但**默认关闭**。两者不要混为一谈。

Pod 的 effective request 不是简单把容器加起来：

```text
effective_init = max over init 容器 i ( request(i) + 它之前已启动的 sidecar 的 request )
effective_steady = sum(所有非 init 容器，即 app + sidecar)
effective = max(effective_init, effective_steady) + pod overhead
```

原因：init 容器逐个运行，sidecar 在 init 阶段就已经常驻。调度按 effective request 预留，
所以「init 容器申请很大」会抬高整个 Pod 的调度请求，即使稳态用不到。详见
[Effective Pod requests and limits](https://kubernetes.io/docs/concepts/resource-management/effective-pod-requests-limits/)。

> GPU 训练/推理里的 sidecar（日志、监控、模型加载、KV cache 预热）很容易把 effective request
> 抬高一个档位；如果节点只按「稳态」估算容量，就会出现调度不上或节点实际超卖。

## 三、cgroup v1 与 v2：同一语义，不同字段

Kubernetes 同时支持 cgroup v1 和 v2。v2 是统一层级（unified hierarchy），CPU/内存/IO 控制器挂在
同一棵树上；v1 是每个控制器一棵树。字段映射如下（以 kubelet 实际写入为准）：

| 语义 | cgroup v1 | cgroup v2 | 说明 |
|---|---|---|---|
| CPU 相对份额 | `cpu.shares` | `cpu.weight` | v2 权重范围 1–10000，默认 100；kubelet 在两者间做近似换算 |
| CPU 带宽上限 | `cpu.cfs_quota_us` + `cpu.cfs_period_us` | `cpu.max`（`$MAX $PERIOD`） | 默认 period 100ms；`max` 表示不限 |
| CPU 统计 | `cpu.stat` | `cpu.stat` / `cpu.stat.local` | 都有 `nr_periods`、`nr_throttled`、`throttled_usec` |
| CPU 压力 | 无统一接口 | `cpu.pressure` | PSI，见后文 |
| CPU 亲和 | `cpuset.cpus` | `cpuset.cpus` / `cpuset.cpus.effective` | CPU Manager 写的是前者 |
| 内存 NUMA 亲和 | `cpuset.mems` | `cpuset.mems` / `cpuset.mems.effective` | Memory Manager 写的是前者 |
| 内存硬上限 | `memory.limit_in_bytes` | `memory.max` | 超限触发 cgroup 内 OOM |
| 内存软限制 | `memory.soft_limit_in_bytes` | `memory.low` | v2 的语义更明确：best-effort 保护 |
| 内存硬保护 | 无 | `memory.min` | 内核在保护范围内不回收；过度保护会导致 OOM |
| 内存节流 | 无 | `memory.high` | 超过后节流 + 强回收，但**不**触发 OOM |
| 内存事件 | `memory.failcnt` 等 | `memory.events` | `low/high/max/oom/oom_kill` 计数 |
| OOM 整组杀 | 无 | `memory.oom.group` | 1 表示 cgroup 内进程整组杀 |
| PID 上限 | `pids.max` | `pids.max` | 防 fork bomb |

内核语义以 [cgroup v2 文档](https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/admin-guide/cgroup-v2.rst#L1331-L1509)
为准。几个关键定义：

- **`memory.min`（硬保护）**：使用量在 min 以内时，内核**不会**回收该 cgroup 的内存；
  如果系统没有可回收的无保护内存，就触发 OOM。把超过实际可用的内存设成 min，会导致持续 OOM。
- **`memory.low`（软保护）**：使用量在 low 以内时，只有在没有无保护内存可回收时才回收；
  是「尽量不回收」，不是「绝不回收」。
- **`memory.high`（节流）**：超过后进程被节流并承受强回收压力；**永远不会**触发 OOM，
  极端情况下可以被突破。适合「先降速、别杀」的场景。
- **`memory.max`（硬上限）**：主要限制手段；达到后无法回收就在 cgroup 内触发 OOM。
- **`memory.events`**：观察 `high`、`max`、`oom`、`oom_kill` 的第一手证据。

## 四、CPU：quota、throttling 与 cpuset

### 4.1 CPU limit 如何变成 throttling

假设容器 `limits.cpu = 200m`，默认 period 100ms，则 quota = 20ms/100ms。容器内多线程在
一个 period 的前 20ms 把配额跑完，剩余 80ms 就会被内核挂起，直到下一个 period。
这就是为什么：

- 平均 CPU 使用率只有 20% 的容器，也可能出现严重 throttling；
- 延迟敏感服务（推理、网关、tokenizer）的 p99 会在 quota 边界上跳变；
- 把 `limits.cpu` 设得太低，比不设 limit 更容易造成尾延迟。

诊断：

```bash
# 找到容器 cgroup（cgroup v2）
crictl inspect <container-id> | jq '.info.runtimeSpec.linux.cgroupsPath'
# 读取节流统计
cat /sys/fs/cgroup/<path>/cpu.stat
#   nr_periods 12345
#   nr_throttled 678
#   throttled_usec 45678901
cat /sys/fs/cgroup/<path>/cpu.max
#   20000 100000

# 节点/容器级 PSI
cat /sys/fs/cgroup/<path>/cpu.pressure
```

`nr_throttled / nr_periods` 是「有多少个 period 被节流」；`throttled_usec` 是累计被压住的时间。
两者都要看趋势，不要只看单点。

### 4.2 CPU Manager：static 策略

默认 `none` 策略：所有容器共享 CPU 池，靠 CFS 调度和 quota。`static` 策略则把
**Guaranteed Pod 中整数 CPU request 的容器**放到独占 cpuset：

条件（源码注释写得最清楚）：

1. Pod QoS 是 Guaranteed；
2. CPU request 是正整数；
3. 容器不在共享池里（BestEffort/Burstable/小数 CPU 的 Guaranteed 仍在共享池）。

`static` 策略要求节点有大于 0 的 CPU 预留（`--kube-reserved`/`--system-reserved` 或 `--reserved-cpus`），否则共享池会被独占分配吃空。CPU 池被分成三块：

| 池 | 内容 | 谁用 |
|---|---|---|
| **SHARED** | 初始为节点所有 CPU（**包含** RESERVED；启用 `strict-cpu-reservation` 时先移除 RESERVED） | BestEffort、Burstable、小数 CPU 的 Guaranteed |
| **RESERVED** | `ceil(system-reserved.cpu + kube-reserved.cpu)`，或 `--reserved-cpus` 显式列表 | 系统守护进程、kubelet、runtime |
| **ASSIGNABLE** | 总 CPU − RESERVED（从 SHARED 扣除 RESERVED；strict 时 SHARED 已先移除 RESERVED） | 只给独占容器分配 |

> 默认（未启用 `strict-cpu-reservation`）RESERVED 仍留在 SHARED 里，BestEffort/Burstable 可以运行；
> `strict-cpu-reservation` 才把它们从共享池彻底移除。

源码见 [`policy_static.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/cpumanager/policy_static.go#L78-L110)，
CPU 亲和写入 cgroup 的路径见
[`internal_container_lifecycle_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/internal_container_lifecycle_linux.go#L33-L51)。

常用 policy options（1.37 基线）：

| 选项 | 成熟度 | 作用 | 代价/边界 |
|---|---|---|---|
| `full-pcpus-only` | GA | 只分配完整物理核，避免 SMT 兄弟核被不同容器占用 | 可能降低可分配密度 |
| `distribute-cpus-across-numa` | Beta | 需要跨 NUMA 时，把 CPU 均匀分散到多个 NUMA | 与 `full-pcpus-only` 可叠加 |
| `align-by-socket` | Alpha | 按 socket 边界对齐，而不是 NUMA 边界 | 需要开启 Alpha options gate |
| `distribute-cpus-across-cores` | Alpha | 把 SMT 线程分散到不同物理核 | 与 `full-pcpus-only` 互斥 |
| `strict-cpu-reservation` | GA | 把 reserved CPUs 从共享池中彻底移除 | 共享池变小；需删 state 文件重启 |
| `prefer-align-cpus-by-uncorecache` | GA | 尽量按 uncore cache 边界对齐 | 尽力而为，不保证 |

几个必须知道的边界：

- **独占只对 Pod 之间生效**。文档明确写：kubelet、runtime 等系统服务仍可能运行在这些
  exclusive CPUs 上；CPU Manager 不是 `isolcpus`，也没有设置 `cpuset.cpus.partition=isolated`。
  要更强的隔离，需要内核启动参数（`isolcpus`、`nohz_full`、`rcu_nocbs`）+ IRQ 亲和 + 实际验证。
- **1.37 中 exclusive CPUs 不再受 CFS quota 限制**。`DisableCPUQuotaWithExclusiveCPUs`
  已锁定为 true（1.36 Deprecated，1.37 LockToDefault），所以整数 CPU 的 Guaranteed 容器
  不会因为 quota 被 throttle；但共享池容器仍然会。
- **state 文件是硬约束**。`/var/lib/kubelet/cpu_manager_state` 记录分配；切换策略（none→static）
  或修改 reserved 后不删 state，kubelet 会拒绝启动并提示 drain + 删除 state 文件。
- **reconcile 有窗口**。CPU Manager 周期性 reconcile（默认 10s），刚分配的容器在窗口内
  可能仍与共享池有短暂重叠；对延迟极端敏感的场景要考虑这个窗口。
- **不支持 CPU 热插拔**。文档明确写了 CPU Manager 不支持运行时 offline/online CPU。

### 4.3 cpuset 不是全部隔离

即使容器被 pin 到 CPU 0-3，仍可能受到：

- 系统守护进程、IRQ、内核线程在同一 CPU 上运行；
- 同 physical core 的 SMT 兄弟线程（如果没开 `full-pcpus-only`）被另一个容器占用；
- 共享 LLC/uncore cache、内存带宽、NUMA 互连；
- CPU 频率/功耗管理（turbo、C-state）带来的抖动。

所以「CPU 独占」是**调度域隔离**，不是「性能隔离保证」。真正做低延迟，需要把
cpuset、IRQ、NUMA、内存带宽、SMT 和频率策略一起考虑。

## 五、内存：保护、节流、硬上限与压力

### 5.1 cgroup v2 的四个水位

```text
memory.min   ── 硬保护：不回收；过度保护 → OOM
memory.low   ── 软保护：尽量不回收
memory.high  ── 节流：降速 + 强回收；不杀
memory.max   ── 硬上限：回收不了就 OOM
```

Kubernetes 的默认行为很重要：

| 配置 | 默认 | 效果 |
|---|---|---|
| `memory.max` | 由 limit 设置 | 容器的硬上限 |
| `memory.high` | `memoryThrottlingFactor` 默认 **nil** | 默认**不设置** `memory.high`，即不节流 |
| `memory.min` / `memory.low` | `memoryReservationPolicy` 默认 **None** | 默认**不设置**保护 |
| `memory.oom.group` | cgroup v2 上默认设为 `1`（`SingleProcessOOMKill` 未配置时 kubelet 取 false）；cgroup v1 无此文件 | cgroup v2 默认**整组杀**，避免容器内只死一个进程留下坏状态；显式设 `SingleProcessOOMKill=true` 可恢复单进程行为 |

MemoryQoS 在 1.37 是 Beta 且默认开启，但它只是「允许使用」这些机制；要真正生效，必须显式配置
`memoryThrottlingFactor` 和/或 `memoryReservationPolicy: TieredReservation`。文档写得很清楚：
`The default kubelet configuration does not enable memory throttling or memory protection.`

### 5.2 MemoryQoS 的两个旋钮

**节流**（`memoryThrottlingFactor`，0 < f ≤ 1）：

```text
memory.high = floor[(request + f × (limit - request)) / pageSize] × pageSize
```

如果 Burstable 容器没有 memory limit，则用 node allocatable 替代 limit。Guaranteed 容器
request == limit，不设 `memory.high`。例如 request 256Mi、limit 1Gi、f=0.9，
`memory.high ≈ 947Mi`。

**分层保护**（`memoryReservationPolicy: TieredReservation`）：

- Guaranteed Pod：`memory.min = request`（硬保护）；
- Burstable Pod：`memory.low = request`（软保护）；
- BestEffort：不设保护；
- 同时给 `kubeps.slice` 等祖先 cgroup 设置聚合保护，否则子 cgroup 的保护无效。

源码见 [`kuberuntime_container_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_container_linux.go#L218-L267)
和 [`qos_container_manager_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/qos_container_manager_linux.go#L333-L370)。

> **重要警告**：Guaranteed 的 request == limit，所以 `memory.min == memory.max`。
> 如果工作负载有大量 page cache，内核可能来不及回收就到 `memory.max`，反而更容易 OOM。
> 文档专门提示：limit 要给 page cache 留余量。见
> [Memory QoS 的 Caution](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/#configuring-memory-reservation)。

### 5.3 怎么读内存压力

优先级从高到低：

1. **`memory.events`**：`high` 增多说明在节流；`max` 增多说明摸到硬上限；`oom_kill` 是实际被杀。
2. **`memory.current` / `memory.peak`**：当前/峰值使用量；`memory.peak` 可 reset。
3. **PSI `memory.pressure`**：`some avg10/60/300` 表示有任务因内存停顿的时间比例；
   `full` 表示所有可运行任务都停顿。比「使用率」更接近「用户体验」。
4. **`memory.stat`**：`anon`、`file`、`inactive_file`、`active_file`、`slab` 等，用于判断
   是匿名内存涨还是 page cache 涨。
5. **节点 `memory.available`**：kubelet 的驱逐信号，不等于 `free`。

```bash
cat /sys/fs/cgroup/<path>/memory.current
cat /sys/fs/cgroup/<path>/memory.peak
cat /sys/fs/cgroup/<path>/memory.events
cat /sys/fs/cgroup/<path>/memory.pressure
grep -E '^(anon|file|inactive_file|active_file|slab) ' /sys/fs/cgroup/<path>/memory.stat
```

`memory.available` 的计算（Linux）：`node.status.capacity[memory] - node.stats.memory.workingSet`，
其中 workingSet 会排除 `inactive_file`。这意味着 page cache 很多时，`free` 很低但
`memory.available` 可能仍然健康；反过来，`active_file` 会被当作不可回收，可能误触发压力。
详见 [Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)。

### 5.4 节点可分配量与 eviction

```text
Node Allocatable = Node Capacity
                 - kubeReserved
                 - systemReserved
                 - evictionHard thresholds
                 (内存还要减去预分配的 hugepages)
```

`Capacity` 来自 `/proc/meminfo` 的 `MemTotal`，不是物理内存条容量；内核/固件在启动时保留的内存
不算。见 [Reserve Compute Resources](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/)。

默认硬驱逐阈值（Linux）：

| 信号 | 默认阈值 |
|---|---|
| `memory.available` | 100Mi |
| `nodefs.available` | 10% |
| `nodefs.inodesFree` | 5% |
| `imagefs.available` | 15% |
| `imagefs.inodesFree` | 5% |

源码见 [`defaults_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/eviction/defaults_linux.go#L21-L28)。

- **硬驱逐**：无 grace period，立即杀 Pod；
- **软驱逐**：`evictionSoft` + `evictionSoftGracePeriod`，超过阈值持续一段时间才驱逐；
- `evictionPressureTransitionPeriod` 默认 5m，防止节点条件抖动；
- kubelet 默认每 10s 评估一次；短时间暴涨可能来不及，直接触发内核 OOM；
- `kernelMemcgNotification` 可以更早收到 memcg 阈值通知。

驱逐排序（不是按 QoS）：

1. BestEffort 或 Burstable 中**超过 request** 的 Pod；
2. 按 Priority、再按超过 request 的程度；
3. Guaranteed 和未超过 request 的 Burstable 最后，按 Priority。

### 5.5 三种 OOM 必须分清

| 类型 | 触发者 | 典型信号 | 影响范围 | 处理方向 |
|---|---|---|---|---|
| **容器 cgroup OOM** | 内核 memcg（`memory.max`） | `OOMKilled`、exit 137、`memory.events oom_kill` | 单容器/单 Pod | 调 limit/request、查泄漏、加 headroom |
| **节点 OOM** | 内核全局 OOM killer | `dmesg` 的 `Out of memory: Killed process`、节点 `MemoryPressure` | 节点上多个进程 | 修 reserved/eviction、迁移负载、加内存 |
| **GPU 显存 OOM** | CUDA/NVML 驱动 | `CUDA out of memory`、`torch.OutOfMemoryError` | 单进程/单容器 | 调 batch/KV cache、查泄漏、隔离 |

三者的关键区别：**GPU 显存 OOM 不会让 kernel OOM killer 杀容器**，Pod 可能仍然是 `Running`，
只是训练进程崩了；反过来，容器 `OOMKilled` 也不是 GPU 显存不够。把它们混为一谈会导致
「加内存 limit」这种完全无效的处置。

kubelet 给容器设置的 `oom_score_adj`：

| QoS | oom_score_adj |
|---|---|
| Guaranteed / system-node-critical | -997 |
| BestEffort | 1000 |
| Burstable | `min(max(2, 1000 - 1000 × request / capacity), 999)` |

源码见 [`qos/policy.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/qos/policy.go#L34-L59)。
注意这是**启发式**：很多小进程的容器，OOM score 可能不准。

## 六、Memory Manager 与 Topology Manager：只做 NUMA 对齐

### 6.1 Memory Manager 的真实职责

`--memory-manager-policy=Static` 只对 **Guaranteed Pod** 生效，做两件事：

1. 按 NUMA 节点分配 memory/hugepages 的「块」，给 Topology Manager 提供 hint；
2. 把分配结果写成容器的 `cpuset.mems`，把内存访问限制在指定 NUMA 节点。

它**不**设置 `memory.max`，**不**限制内存用量，**不**保证内存带宽。真正的用量上限仍然是 cgroup。
源码见 [`policy_static.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/memorymanager/policy_static.go#L193-L260)
和 [`internal_container_lifecycle_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/internal_container_lifecycle_linux.go#L40-L51)。

启用 Static 必须配 `--reserved-memory`，且满足：

```text
Σ reservedMemory[i] = kubeReserved.memory + systemReserved.memory + evictionHard.memory.available
```

不满足 kubelet 会启动失败。默认 `evictionHard` 的 100Mi 也要算进去，这是最常见的配置错误。
详见 [Memory Manager](https://kubernetes.io/docs/tasks/administer-cluster/memory-manager/)。

### 6.2 Topology Manager：hint 的协调者，不是放置执行者

Topology Manager 不直接分配 CPU/内存/设备；它收集各 Hint Provider（CPU Manager、Memory Manager、
Device Manager）的 NUMA hint，按 policy 合并，决定「是否允许这个 Pod 在这台节点上启动」。

| Policy | 行为 | 失败表现 |
|---|---|---|
| `none` | 不做对齐 | 无 |
| `best-effort` | 选择最优 hint，但不满足也允许 | 可能跨 NUMA，性能下降 |
| `restricted` | hint 必须是 preferred，否则拒绝 | Pod 被 kubelet 拒绝，进入 Terminated/Failed，调度器不会自动重调度 |
| `single-numa-node` | 必须落在单个 NUMA 节点，否则拒绝 | 同上 |

Scope：

- **container**（默认）：每个容器单独对齐；
- **pod**：整个 Pod 的所有容器对齐到同一组 NUMA 节点，适合 gang/紧耦合负载。

关键边界：

- **Topology Manager 只看 hint provider 提供的信息**。device plugin 的 `TopologyInfo` 只有
  `NUMANode.ID`，没有 NVLink/PCIe 距离；所以 Topology Manager **不会**因为两张卡在同一
  NVLink 域而优先选择它们。GPU 间的 NVLink 拓扑要靠 DRA 属性/自定义调度器/应用自己处理。
- **它只做准入，不做迁移**。`restricted`/`single-numa-node` 拒绝后，Pod 会进入失败状态，
  调度器不会自动换节点；需要用 Deployment/Job 重建，或外部控制器处理。
- **它不保证带宽**。NUMA 对齐减少跨 socket 访存，但不隔离内存带宽、LLC、PCIe 带宽。
- **NUMA 距离默认不感知**。多 socket/多 NUMA 系统上，跨 NUMA 的「最优」可能很差；
  `prefer-closest-numa-nodes=true` 才会优先选择距离近的节点组合（1.32 GA）。
- **`max-allowable-numa-nodes` 默认 8**。NUMA 节点数超过该值时 Topology Manager 会拒绝；
  可以用 policy option 提高该值（必须 ≥ 8，超过 8 只告警），所以不是永久硬上限。源码
  `defaultMaxAllowableNUMANodes = 8`，但 `NewPolicyOptions` 允许调大。

## 七、一张表定位问题

| 症状 | 首先看 | 可能原因 | 处置 |
|---|---|---|---|
| 容器 CPU 用不上去，p99 抖动 | `cpu.stat` 的 `nr_throttled`、`throttled_usec` | CPU limit 太低；quota period 内突发 | 提高 limit 或去掉 limit；调 period；拆线程 |
| 容器 CPU 被限制在固定核，但仍被干扰 | `cpuset.cpus`、`/proc/interrupts`、SMT 兄弟 | IRQ/系统进程/SMT 共享 | `reserved-cpus`、IRQ 亲和、`full-pcpus-only`、`isolcpus` |
| 容器内存没超 limit 却被杀 | `memory.events`、`memory.max`、`dmesg` | page cache/匿名内存突增；节点 OOM | 加 headroom；查泄漏；调 eviction/reserved |
| 节点 `free` 很低但 Pod 没被驱逐 | `memory.available`、`memory.stat` 的 `inactive_file` | page cache 被算作可用 | 正常；看 PSI/`memory.events` 而不是 `free` |
| Pod 被 kubelet 拒绝，事件 `Topology Affinity Error` | Topology Manager 日志、hint | `restricted`/`single-numa-node` 无法满足 | 放宽 policy；调整 CPU/内存/设备请求；重建 Pod |
| GPU 分配了但跨 NUMA | `nvidia-smi topo -M`、`cpuset.mems` | 没开 Topology Manager/Memory Manager；device plugin 无 topology | 开 static policy + reserved-memory；用 DRA 属性选择 |
| 内存 limit 设了但容器还是被节点 OOM 杀 | `oom_score_adj`、节点 `dmesg` | 节点整体内存不足，不是 cgroup 超限 | 修 reserved/eviction；迁移；加节点 |

## 八、设计检查清单

- [ ] 每个容器都有 request；延迟敏感服务不要用「只设 limit」的写法。
- [ ] CPU limit 是否真的必要？如果设置，是否验证过 p99 和 `nr_throttled`？
- [ ] 内存 limit 是否给 page cache/allocator 留了 headroom？是否开了 MemoryQoS？开了之后是否验证过 `memory.events`？
- [ ] 节点是否配置了 `kubeReserved`/`systemReserved`/`evictionHard`？三者和是否与 `reservedMemory` 一致？
- [ ] 是否需要 CPU 独占？如果需要，`reserved-cpus`/`strict-cpu-reservation`/`full-pcpus-only` 是否配套？
- [ ] 是否需要 NUMA 对齐？`topologyManagerPolicy` 与 `memoryManagerPolicy` 是否同时配置？`reservedMemory` 公式是否满足？
- [ ] 是否误以为 Topology Manager 会按 NVLink/PCIe 放置？如果是，改用 DRA 属性或应用级拓扑。
- [ ] 是否把 `free` 当作可用内存？是否用 `memory.available`/PSI/`memory.events` 做过验证？
- [ ] OOM 告警是否能区分容器 OOM、节点 OOM、GPU 显存 OOM？

## 参考与证据

**Kubernetes 文档**

- [Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Pod QoS Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Effective Pod requests and limits](https://kubernetes.io/docs/concepts/resource-management/effective-pod-requests-limits/)
- [Resource managers](https://kubernetes.io/docs/concepts/resource-management/resource-managers/)
- [Pod-level resource managers](https://kubernetes.io/docs/concepts/resource-management/pod-level-resource-managers/)
- [Control CPU Management Policies](https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/)
- [Control Memory Management Policies](https://kubernetes.io/docs/tasks/administer-cluster/memory-manager/)
- [Control Topology Management Policies](https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/)
- [Node-pressure Eviction](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Reserve Compute Resources for System Daemons](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/)

**Kubernetes 源码（v1.37.2，commit c50e5395）**

- [`pkg/kubelet/kuberuntime/kuberuntime_container_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_container_linux.go#L354-L400)：CPU shares/quota、memory limit 的翻译
- [`pkg/kubelet/kuberuntime/kuberuntime_container_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_container_linux.go#L218-L267)：`memory.high` 公式
- [`pkg/kubelet/cm/cpumanager/policy_static.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/cpumanager/policy_static.go#L78-L110)：static policy 的分配条件
- [`pkg/kubelet/cm/cpumanager/policy_options.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/cpumanager/policy_options.go#L31-L52)：policy options 与成熟度
- [`pkg/kubelet/cm/memorymanager/policy_static.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/memorymanager/policy_static.go#L193-L260)：Memory Manager Static 的分配
- [`pkg/kubelet/cm/topologymanager/policy.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/topologymanager/policy.go#L24-L30)：`IsAlignmentGuaranteed`
- [`pkg/kubelet/cm/internal_container_lifecycle_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/cm/internal_container_lifecycle_linux.go#L33-L51)：`cpuset.cpus`/`cpuset.mems` 写入
- [`pkg/kubelet/eviction/defaults_linux.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/eviction/defaults_linux.go#L21-L28)：默认驱逐阈值
- [`pkg/kubelet/qos/policy.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/qos/policy.go#L34-L59)：OOM score 计算
- [`pkg/features/kube_features.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1566-L1570)：`DisableCPUQuotaWithExclusiveCPUs`
- [`pkg/features/kube_features.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1845-L1848)：`MemoryQoS` 默认值
- [`pkg/kubelet/apis/config/types.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/apis/config/types.go#L500-L520)：`memoryThrottlingFactor` / `memoryReservationPolicy`
- [`pkg/kubelet/kubelet.go`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kubelet.go#L775-L785)：cgroup v2 下 `SingleProcessOOMKill` 的默认逻辑

**内核文档**

- [cgroup v2: Memory Interface Files](https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/admin-guide/cgroup-v2.rst#L1331-L1509)
- [cgroup v2: CPU Interface Files](https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/admin-guide/cgroup-v2.rst#L1143-L1240)
- [cgroup v2: cpuset](https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/admin-guide/cgroup-v2.rst#L2513-L2680)
- [PSI](https://github.com/torvalds/linux/blob/c03c1a14507dfaf8b856c2608f9ac216021fc222/Documentation/accounting/psi.rst)
