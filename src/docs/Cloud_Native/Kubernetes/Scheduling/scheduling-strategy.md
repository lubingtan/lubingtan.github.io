# 调度策略与约束：配额、Gang、拓扑与 DRA

这篇页面回答的是**策略层**的问题：一个作业从"提交了"到"跑起来"，中间要过哪几道门；每一道门由谁负责、改哪个对象/字段、失败时留下什么状态；以及当资源"看起来够"但作业就是起不来时，应该先怀疑哪一层。它不逐行讲 kube-scheduler 的队列与绑定循环（见 [kube-scheduler：对象、队列与调度主流程](./native-scheduler.md)），也不展开 Volcano 的 Session/Action 内部实现（见 [Volcano 调度器：Session、Action 与队列模型](./volcano-scheduler.md)）；这里只保留能支撑策略判断的代码位置和失败语义。

版本基线：Kubernetes **v1.37.2**（`c50e5395`）、Volcano **v1.16.1**（`a2543678`）、Kueue **main@2026-11-23**（`be7dc9d`，晚于 v0.20.8，是未发布快照）。Kueue 的代码结论只对这份快照负责，不声称对应某个 release。

## 1. 分析框架：需求 → 权益 → 准入 → 放置 → 回收/抢占 → 运行

策略问题经常被压缩成一句"资源够不够"。实际上至少要拆成六层，每层的输入、状态和失败后果都不同：

| 层 | 回答的问题 | 主要对象/字段 | 典型失败表现 |
| --- | --- | --- | --- |
| 需求 | 这个作业要什么形状的资源？ | Pod `requests`/`limits`、extended resources、`ResourceClaim`、PodSet 数量、`topologyKey`、gang size | 需求建模错了，后面所有判断都错 |
| 权益 | 这个租户"应该"拿到多少？ | Kueue `ClusterQueue.nominalQuota`/`borrowingLimit`、Cohort；Volcano `Queue.spec`；原生 `PriorityClass` | 配额被邻租户借走，或长期超卖 |
| 准入 | 现在允许它开始吗？ | Kueue `Workload` + `AdmissionCheck`；Volcano `enqueue` + `JobEnqueueable`；原生 `PreEnqueue`/`SchedulingGates` | 作业停在 Pending，Pod 未创建或未入队 |
| 放置 | 放到哪个节点/拓扑域？ | `Filter`/`Score`、`PodTopologySpread`、`VolumeBinding`、TAS `Placement`、Volcano `Predicate`/`NodeOrder` | Pod Pending，事件是 `FailedScheduling` |
| 回收/抢占 | 资源被谁占着，能不能拿回来？ | Kueue preemption；Volcano `reclaim`/`preempt`；原生 `DefaultPreemption` | 抢占后 victim 未退出，preemptor 仍 Pending |
| 运行 | 绑定、设备分配、容器启动是否真的成功？ | `Binding`、DRA claim `Status.Allocation`、`ReservedFor`、kubelet | Pod 已绑定但容器起不来，或设备不可用 |

```mermaid
flowchart LR
  A[需求 R(w)] --> B[权益 entitlement]
  B --> C[准入 admission]
  C --> D[放置 placement]
  D --> E[回收/抢占 reclaim/preempt]
  E --> D
  D --> F[绑定 bind]
  F --> G[设备分配 DRA / 运行时]
  G --> H[运行]
  E --> I[失败: 队列/权益不变, 作业继续等]
  D --> J[失败: Pod Unschedulable]
  F --> K[失败: Unreserve + 重新排队]
```

三个必须分开的三元组：

1. **权益 / 容量 / 用量**：`nominalQuota`、`capability`、`guarantee`、`deserved` 是权益侧的四个不同概念；`allocated` 是已经发生的用量；集群实际可分配容量又是第三个东西。把 `deserved` 当"配额"、把 `capability` 当"保证"，是最常见的误读。
2. **准入 / 放置 / 绑定**：Kueue/Volcano 的准入门发生在 kube-scheduler 之前；放置是选节点；绑定是一次 API 写。准入成功不等于 Pod 能放下，放置成功也不等于绑定和运行时成功。
3. **回收 / 抢占 / 驱逐**：回收（reclaim）通常是"跨队列把借出去的权益拿回来"；抢占（preempt）通常是"高优先级把低优先级挤走"；驱逐（evict）是 API 层删除 Pod。三者都可能调用同一套 victim 选择，但不是同一件事。

表中把 `Filter`/`Score` 与 Volcano 的 `Predicate`/`NodeOrder` 并列，只是为了说明"放置"这一层，**不是名称映射**：原生 `Filter` 是 per-node 的 Framework 扩展点，由 runtime 按扩展点顺序调用；Volcano 的 predicate 是 plugin 注册的 `PredicateFn`，在 action 内部被调用。两者的调用者、状态作用域、失败码和能否参与抢占都不同，见 [Scheduling Framework](./scheduling-framework.md) 与 [Volcano 调度器](./volcano-scheduler.md) 的对照。

下面每一节都按"哪一层、哪个对象/字段、哪段代码、失败会怎样"来写。

## 2. 需求：资源向量之外，还有拓扑与设备集合

一个作业的需求不是单个标量。对 PodSet `ps`，一个简化的有效请求是：

```
r(ps) = max( Σ_{普通容器 c} req(c), max_{init 容器 c} req(c) ) + overhead
R(w)  = Σ_{ps ∈ PodSets(w)} count(ps) · r(ps)
```

这个式子省略了 sidecar 重启策略、hugepages、Pod-level resources 等细节，但足以说明两件事：**gang 的规模是乘出来的**，且**同一作业的不同 PodSet 可以有不同形状**。更完整的建模见 [工作负载建模](../../AI_Infrastructure/Distributed_Training/workload-modeling.md)。

对 GPU 类资源，需求至少有三个维度：

- **数量**：`nvidia.com/gpu: N` 是 extended resource，只能是整数；它由 device plugin 上报，调度器只看到"节点上有 N 个可用"，看不到型号、显存、算力、MIG 切分。
- **属性**：型号（A100/H100/昇腾）、显存（80GB/40GB）、算力、NUMA/NVLink 位置。这些在 device plugin 模型里通常靠节点标签 + 设备插件内部逻辑表达；在 DRA 里由 `DeviceClass` 的 CEL selector 和 `ResourceSlice` 的 `Device.attributes`/`capacity` 表达。
- **拓扑**：这些卡是否在同一台机器、同一个机架、同一个 NVLink domain。它决定"4 张卡"能不能当成一个 4 卡作业来用。

DRA 的需求更不是向量：一个 `ResourceClaim` 可以包含多个 request，每个 request 可以是 `exactly`（精确数量）或 `firstAvailable`（按顺序尝试的候选列表）：

```yaml
# 语义示意，不是完整对象
devices:
  requests:
  - name: gpu
    firstAvailable:        # 依次尝试，第一个能满足的胜出
    - name: a100-80g
      deviceClassName: a100-80g
      count: 4
    - name: h100-80g
      deviceClassName: h100-80g
      count: 4
```

`firstAvailable` 的注释明确说 DRA 目前**不做 scoring**，只选第一组满足条件的设备，节点选择交给其它调度特性（[`types.go` L1313-L1336](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/resource/v1/types.go#L1313-L1336)）。所以"DRA 能选最优卡"是过度承诺；它能表达属性约束，但优化能力有限。

## 3. 权益：三套队列模型与公式

### 3.1 原生：PriorityClass + QueueSort，没有队列配额

原生 kube-scheduler 的队列里只有实体（Pod，或 `GenericWorkload` 开启后的 PodGroup），没有"队列对象"，也没有"租户配额账本"。默认插件集里与排序有关的只有 `SchedulingGates` 和 `PrioritySort`（[`default_plugins.go` L31-L60](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/apis/config/v1/default_plugins.go#L31-L60)）；`PrioritySort.Less` 只比较 priority，priority 相同再比时间戳（[`priority_sort.go` L40-L47](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/queuesort/priority_sort.go#L40-L47)）：

```go
func (pl *PrioritySort) Less(entity1, entity2 fwk.QueuedEntityInfo) bool {
	p1 := entity1.GetPriority()
	p2 := entity2.GetPriority()
	return (p1 > p2) || (p1 == p2 && entity1.GetTimestamp().Before(entity2.GetTimestamp()))
}
```

`PriorityClass` 本身只有 `value`、`globalDefault`、`preemptionPolicy` 三个有调度意义的字段（[`types.go` L38-L60](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/scheduling/v1/types.go#L38-L60)）。它能表达"谁先谁后"和"能不能抢占"，不能表达"这个租户最多用 64 张卡"。

> [!NOTE]
> 原生并非完全没有配额：`ResourceQuota`/`LimitRange` 在 apiserver 准入侧限制命名空间的对象数和资源总量（[官方文档](https://kubernetes.io/docs/concepts/policy/resource-quotas/)）。但它是**命名空间准入**，不是调度队列权益：不参与 `QueueSort`，不做 cohort 借用，不做 fair sharing，也不感知 PodGroup。把它当"队列配额"会在多租户场景下漏掉调度侧的争用。

失败后果：没有队列上限时，一个低优先级租户可以把集群吃满；只有更高优先级的 Pod 到来时，`DefaultPreemption` 才会尝试驱逐。若 victim 有 `preemptionPolicy: Never`，或 PDB 违规代价让该候选节点不可接受（原生会优先 reprieve 造成 PDB 违规的 victim，但**不保证零违规**），抢占可能失败或换一个更差的节点，高优先级 Pod 继续 Pending——这不是"配额没生效"，而是"原生只有优先级，没有预留/借用"。

### 3.2 Kueue：nominal / borrowing / lending / cohort / fair sharing

Kueue 的对象关系是：`LocalQueue`（命名空间入口）→ `ClusterQueue`（集群级配额）→ `Cohort`（可借用的队列组）；`ResourceFlavor` 用 `nodeLabels`/`nodeTaints` 把配额绑定到一类节点（[`resourceflavor_types.go` L50-L64](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/resourceflavor_types.go#L50-L64)）；`Workload` 是准入单元。`ClusterQueue` 的 `cohortName` 为空时**不能**借用，也不能被借用（[`clusterqueue_types.go` L103-L116](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/clusterqueue_types.go#L103-L116)）。

配额字段的语义（[`clusterqueue_types.go` L332-L374](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/clusterqueue_types.go#L332-L374)）：

- `nominalQuota`：这个 `[flavor, resource]` 在某一时刻可供本 CQ 准入的基准量；
- `borrowingLimit`：最多能从同 cohort 的其它 CQ 借多少；`null` 表示无限；
- `lendingLimit`：最多能把多少未用配额借给别人；`null` 表示全部 `nominalQuota` 都可出借。

代码里的账本不是一个减法，而是沿 cohort 树递归。设节点（CQ 或 Cohort）的 `T` 为 `SubtreeQuota`（CQ 等于 `nominalQuota`；Cohort 是自身配额加子树聚合），`l` 为 `LendingLimit`，`b` 为 `BorrowingLimit`（空表示无限），`u` 为 `Usage`；`l` 为空表示"全部可出借"，此时 `localQuota=0`，而不是 `T`：

```
localQuota(fr)      = 0                                # 若 l 为空（全部可出借）
                    = max(0, T(fr) - l(fr))          # 若 l 非空：只属于本子树、绝不外借的部分
localAvailable(fr)  = max(0, localQuota(fr) - u(fr))
borrowCapacity(fr)  = (T - localQuota) - max(0, u - localQuota) + b
available(fr)       = T(fr) - u(fr)                    # 无父
                    = localAvailable(fr) + min(available(parent), borrowCapacity(fr))  # 有父
```

`localQuota` 和 `available` 的实现分别在 [`resource_node.go` L78-L85](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/scheduler/resource_node.go#L78-L85) 与 [`resource_node.go` L111-L135](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/scheduler/resource_node.go#L111-L135)。`available` 的注释明确允许返回负数：配额被删、CQ 换了 cohort、或已经 overadmission 时，账本会是负的，后续准入被挡住。这就是"回收失败/配置变更后的权益暂时为负"。

`addUsage` 只把**超过 `localAvailable` 的部分**上推到父 Cohort（[`resource_node.go` L157-L168](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/scheduler/resource_node.go#L157-L168)）。因此父 Cohort 看到的 `Usage` 是"子树借走的部分"，不是全部用量；这也是为什么 `borrowingLimit` 能在父层被检查。

Cohort 还可以有层级：`Cohort.spec.parentName`，根 Cohort 没有父；如果形成环，webhook 会禁用整棵子树（[`cohort_types.go` L24-L60](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/cohort_types.go#L24-L60)）。Cohort 自身的 `nominalQuota` 是"在子 CQ 配额之外额外提供的共享池"，不是子 CQ 配额的替代。

**Fair sharing 用的是 DRS，不是 `allocated/deserved`。** Kueue 的 `FairSharing.Weight` 默认 1，weight 为 0 且正在借用时 share 为 `+Inf`（[`fairsharing_types.go` L25-L40](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/fairsharing_types.go#L25-L40)）。`dominantResourceShare` 对每个 resource 算：

```
borrowed(fr) = max(0, usage(fr) - subtreeQuota(fr))
ratio        = 1000 * max_fr( borrowed(fr) / lendable_parent(fr) )   # 仅当 lendable > 0
weightedShare = ratio / weight
```

代码用千分比保存未加权比率（`PerThousandOf`），比较时只看相对大小；`PreciseWeightedShare` 再除以 weight（[`fair_sharing.go` L97-L112](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/scheduler/fair_sharing.go#L97-L112)、[`fair_sharing.go` L166-L205](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/scheduler/fair_sharing.go#L166-L205)）。两个边界值得记住：没有父 Cohort 的 CQ 永远 `borrowing=false`，DRS 为 0；正在借用但父 Cohort 没有可借资源（`lendable=0`）时，比率仍为 0，`IsZero()` 为真——不是"没借用"，而是"借了但没有可比的出借池"。

fair sharing 开启时，准入不是全局按 DRS 排序，而是用 `fairSharingIterator` 在 cohort 树上逐层做锦标赛（[`fair_sharing_iterator.go` L50-L118](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/fair_sharing_iterator.go#L50-L118)）：每个 CQ 先按 `compareEntries` 排自己的候选，再在每一层比较 DRS，选出该层最该被准入的 CQ，然后从它取一个 entry。这样"公平"是逐层比较，不是把所有 Workload 拉成一条全局队列。

不开 fair sharing 时，`compareEntries` 的顺序是（[`scheduler.go` L1293-L1360](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/scheduler.go#L1293-L1360)）：

1. 已经预留 quota 的 entry 优先（可能是第二轮）；
2. **不借用的 Workload 先于借用的**；
3. `PrioritySortingWithinCohort` 开启时，高优先级先；
4. 最后按 eviction/creation 时间 FIFO。

注意第 2 条在第 3 条之前：一个低优先级但"在 nominal 内"的 Workload，可能排在一个高优先级但"要借用"的 Workload 前面。这不是 bug，而是 Kueue 的显式取舍：先保护不借用的份额，再谈优先级。

`QueueingStrategy` 只有两种：`StrictFIFO` 和 `BestEffortFIFO`，默认后者（[`clusterqueue_types.go` L118-L131](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/clusterqueue_types.go#L118-L131)）。`StrictFIFO` 下，队头不能被准入就会挡住后面的 Workload；`BestEffortFIFO` 下，队头不可准入时，等价的不可准入 Workload 会被移到 inadmissible 集合，后面的 Workload 可以继续试（[`cluster_queue.go` L849-L863](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/cache/queue/cluster_queue.go#L849-L863)）。这是"队头阻塞"与"绕过"在 Kueue 里的准确含义；不存在第三种 `traverse` 策略，`traverse` 是 Volcano 的 Queue 字段。

### 3.3 Volcano：weight / capability / guarantee / deserved

Volcano 的 `Queue` 是集群级对象，`QueueSpec` 的字段（[`types.go` L622-L668](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/staging/src/volcano.sh/apis/pkg/apis/scheduling/v1beta1/types.go#L622-L668)）：

| 字段 | 语义 | 用在哪 |
| --- | --- | --- |
| `weight` | 竞争剩余资源时的权重（默认 1，范围 1–65535） | `proportion` 计算 deserved、QueueOrder |
| `capability` | 队列上限（硬顶），没设则视为无限 | `proportion`/`capacity` 的 `realCapability`、入队检查 |
| `guarantee` | 预留下限，任何情况下尽量不被抢走 | `capacity` 的 reclaim 保护、proportion 的 deserved 下限 |
| `deserved` | 期望份额/回收阈值；不设则视为 best-effort 队列 | `capacity` 的 share、Reclaimable/Preemptive |
| `reclaimable` | 是否允许别人回收 | `Queue.spec.reclaimable` 与插件回调 |
| `parent` | 层级队列的父 | `capacity` 的祖先回收 |
| `priority` | 队列优先级 | 两个插件的 QueueOrder 都先比它 |
| `dequeueStrategy` | `fifo` 或 `traverse`（默认） | API 层声明，见下面的 caveat |

注意 `Queue.spec.priority` 与 Pod/Job 的 `priorityClassName` 是两层：前者决定**队列之间**的顺序，后者在队列内由 `priority` 插件排 Job/Task；不要用 Queue priority 代替作业优先级。

**proportion 是权重份额模型。** 它每一轮把所有队列的 `request` 和 `weight` 拿来迭代：先按 `weight/totalWeight` 分剩余资源，再用 `realCapability`（= `(totalResource - totalGuarantee) + guarantee`，再被 `capability` 截断）、`request` 和 `guarantee` 夹逼，直到没有队列还能增加（[`proportion.go` L206-L258](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/proportion/proportion.go#L206-L258)）。`deserved` 是**每轮根据 request 重新计算的动态份额**，不是静态配额；`share = max_r allocated_r/deserved_r`（[`proportion.go` L614-L626](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/proportion/proportion.go#L614-L626)）。`Overused` 的定义是 `deserved <= allocated`（所有维度都到顶才算 overused），`QueueOrder` 先比 `priority` 再比 `share` 升序（[`proportion.go` L273-L292](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/proportion/proportion.go#L273-L292)、[`proportion.go` L326-L338](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/proportion/proportion.go#L326-L338)）。

**capacity 是层级保证 + 显式 deserved 模型。** 它不按 weight 分；`deserved` 由 `Queue.spec.deserved` 给出，没给就退回 `guarantee`；父队列把 `realCapability` 减去子队列 guarantee 总和，再加子队列自己的 guarantee，并受子 `capability` 截断（[`capacity.go` L1501-L1538](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/capacity/capacity.go#L1501-L1538)）。`share` 同样是 `max_r allocated/deserved`，但没配 `deserved` 的队列被视为 best-effort，`share` 固定为 1，永远排在有 `deserved` 且 `share<1` 的队列之后（[`capacity.go` L1895-L1922](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/capacity/capacity.go#L1895-L1922)）。capacity 没有注册 `OverusedFn`，`Overused` 只在 `OnSessionClose` 里作为指标写 `share > 1`；它的回收判断主要落在 `Reclaimable` 和 `Preemptive` 上。

**两者最关键的差异：**

- proportion：`weight` 决定份额，`deserved` 是算出来的；`Overused` 是"所有维度都达到 deserved"；`Allocatable` 检查 `futureUsed <= deserved`，所以队列在每轮都不能超过当前 deserved。
- capacity：`deserved` 是配置出来的（或 guarantee），`weight` 不参与；支持父子层级、祖先回收；`Preemptive` 只要求**存在一个维度** `deserved > allocated`，就可能允许回收，比 proportion 的 overused 更宽松。

不要把 Volcano 的 `capacity` 和 Kueue 的 `ClusterQueue` 当同义词：前者是插件 + 队列字段 + 层级回收算法，后者是 CRD + cohort 借用账本 + 准入调度器；两者的公式、状态作用域和失败语义都不同。

### 3.4 对照表

| 维度 | 原生 | Kueue | Volcano |
| --- | --- | --- | --- |
| 队列对象 | 无 | `ClusterQueue`/`Cohort`/`LocalQueue` | `Queue` |
| 基准量 | `PriorityClass.value` | `nominalQuota` | `guarantee`/`deserved`/`capability` |
| 借用 | 无 | `borrowingLimit` + cohort 树 | proportion 动态份额 / capacity 祖先回收 |
| 出借上限 | 无 | `lendingLimit` | `reclaimable` + `capability` |
| 公平 | 无（只有优先级） | DRS + weight；或 `share` 语义的 fair sharing | `share=allocated/deserved`；DRF 插件另有实现 |
| 队头绕过 | 无 | `BestEffortFIFO` | `dequeueStrategy=traverse`（API 声明，见 §5.2） |
| 准入单位 | Pod | Workload | Job（PodGroup Inqueue） |

## 4. 准入：作业级与 Pod 级是两道门

### 4.1 Kueue：Workload 准入 + AdmissionCheck

Kueue 的调度循环先 `Heads` 取各队列头，再 `Snapshot`，再 `nominate` 计算 flavor/借用，再按 `compareEntries`/fair sharing 顺序 `admit`（[`scheduler.go` L360-L405](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/scheduler.go#L360-L405)）。`AdmissionCheck` 是外部闸门：Workload 的 `Admitted` 需要所有 required check 为 `Ready`；MultiKueue 的 worker 准入就是一个 check。它不改变 `nominalQuota`/`borrowingLimit` 的公式，只决定"配额预留之后，外部条件是否允许继续"。

关键边界：Kueue 的准入是**作业级**的。它决定 Workload 能不能被 admit，从而让 Job 控制器创建/恢复 Pod；它不决定 Pod 放哪个节点，也不提供 gang 的原子放置。把 Kueue 当 gang 调度器，会得到"作业被准入但 Pod 仍然部分 Pending"的结果。

### 4.2 Volcano：enqueue 的 JobEnqueueable / QueueState / capability

Volcano 的 `enqueue` action 把 PodGroup 从 `Pending` 推到 `Inqueue`；插件通过 `JobEnqueueable` 回调投票。`proportion` 的检查顺序是：队列必须 `Open`；没设 `realCapability` 就直接 Permit；`MinResources` 为空也 Permit；否则检查 `minReq + allocated + inqueue - elastic <= realCapability`（[`proportion.go` L409-L440](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/proportion/proportion.go#L409-L440)）。`capacity` 的版本还要检查是否 leaf queue、层级上的 `checkJobEnqueueableHierarchically`。注意这里的 `capability` 是硬顶，不是 deserved；入队通过不代表 allocate 时一定能拿到资源。

### 4.3 原生：PreEnqueue 只做门控

原生的 `SchedulingGates` 插件在 `PreEnqueue` 阶段检查 `Pod.spec.schedulingGates`，非空就返回 `UnschedulableAndUnresolvable`，Pod 不进 activeQ（[`scheduling_gates.go` L45-L55](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/schedulinggates/scheduling_gates.go#L45-L55)）。它只做门控：没有配额、没有借用、没有队列优先级；门一旦被移除，Pod 还是按 `PrioritySort` 进队。

| 准入问题 | 谁回答 | 失败后 Pod 在哪 |
| --- | --- | --- |
| 作业能否开始 | Kueue `Workload.Admitted` / AdmissionCheck | 未 admit，Job 控制器不创建/不恢复 Pod |
| PodGroup 能否入队 | Volcano `enqueue` + `JobEnqueueable` | PodGroup 仍 Pending，Pod 可存在但不被调度 |
| 这个 Pod 能否进调度队列 | 原生 `PreEnqueue`（SchedulingGates/资源门控） | 不进 activeQ，等待 gate 消除事件 |

## 5. 回收、抢占、优先级与公平

### 5.1 借用归还：overused、victim 与回滚

**Kueue** 没有独立的 `reclaim` action；它在 preemption 里完成"把借出去的配额拿回来"。`classicalPreemptionStrategy` 的候选分三类：层级候选（preemptor 在层级上更接近配额，可以无视优先级）、优先级候选（看 priority 和 `BorrowWithinCohort` 配置）、同队列候选；它会尝试 `allowBorrowing=true/false` 两种方案（[`classical_strategy.go` L36-L78](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/preemption/classical_strategy.go#L36-L78)）。fair sharing 开启时改用 `fairPreemptionStrategy`，按 DRS 规则选 victim，并在模拟中把 preemptor 的用量加进去（[`fair_strategy.go` L42-L60](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/preemption/fair_strategy.go#L42-L60)）。

**Volcano** 有两个不同 action：

- `reclaim`：只处理 starving job；队列如果是 overused（通过 `OverusedFn`）就跳过，因为它自己都超了，没有资格回收别人（[`reclaim.go` L106-L115](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/actions/reclaim/reclaim.go#L106-L115)）。victim 由 `Reclaimable` 回调选出；capacity 会先检查 victim 是否还能保持在 guarantee 之上，再检查 `allocated > deserved`；proportion 则用 `deserved` 判断（[`capacity.go` L466-L520](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/capacity/capacity.go#L466-L520)）。
- `preempt`：只处理 starving job；先同队列内、再同 Job 内；victim 还要过 priority 和 gang 的 `Preemptable` 回调；带 `networkTopology` 的 Job 直接跳过（[`preempt.go` L132-L137](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/actions/preempt/preempt.go#L132-L137)）。这是 v1.16.1 的明确限制，不是"拓扑作业只是慢一点"。

**回滚**：Volcano 用 `Statement` 记录 allocate/evict，commit 才写 cache/API，discard 逆序回滚；Kueue 的 preemption 先写 `Workload` 的 eviction 状态，再由控制器删除 Pod，失败时重新排队。两者的失败窗口不同：Volcano 在 session 内可以整体丢弃；Kueue 一旦发出 eviction，就要等 victim 真正退出。

### 5.2 优先级与 FIFO：strict、best-effort 与 traverse

三种"FIFO"要分开：

1. **原生 `PrioritySort`**：不是 FIFO，是 priority 降序 + 同优先级时间戳升序。原生没有显式的 FIFO 策略开关；队头 Pod 失败后会被移入 unschedulable/backoff（[`scheduling_queue.go` L1073-L1080](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/backend/queue/scheduling_queue.go#L1073-L1080)），队列继续处理下一个实体，所以它既不是严格 FIFO，也没有"队头优先"保证。
2. **Kueue `QueueingStrategy`**：`StrictFIFO` 队头阻塞；`BestEffortFIFO` 让等价的不可准入 Workload 让路。默认是 `BestEffortFIFO`。
3. **Volcano `Queue.spec.dequeueStrategy`**：API 定义 `fifo`（队头不可调度就不试后面的）与 `traverse`（跳过队头继续试），默认 `traverse`（[`types.go` L683-L695](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/staging/src/volcano.sh/apis/pkg/apis/scheduling/v1beta1/types.go#L683-L695)）。**但在这份 v1.16.1 的核心仓库里，`grep DequeueStrategy` 只找到 API 类型、转换和 `NamespaceQueue` 到 `Queue` 的映射，没有找到 scheduler 的消费点**；因此它目前更像"声明能力"，部署前必须在目标版本确认实际生效路径。

原生的抢占默认是 Pod 级：`DefaultPreemption` 只有在 `GenericWorkload` 开启时才实例化 PodGroup evaluator；即使如此，PodGroup 的 `preemptionPolicy` 字段还要 `PodGroupPreemptionPolicy` gate（Alpha 默认关闭）才会被读取，否则回退到组内 Pod 的策略（[`preemption/types.go` L44-L58](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/preemption/types.go#L44-L58)、[`kube_features.go` L1956-L1960](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1956-L1960)、[`types.go` L290-L300](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/scheduling/v1beta1/types.go#L290-L300)）。所以"gang 会按组策略整组抢占"不是默认能力。

队头阻塞与饥饿的差别：

- 队头阻塞是**顺序问题**：一个大 gang 在队头，后面的小作业即使放得下也进不来。StrictFIFO（以及 API 上声明的 `fifo`，如果目标版本确实生效）会放大它；`BestEffortFIFO`（以及 `traverse`，如果生效）会缓解它，但可能让大作业长期排不上（饥饿）。
- 饥饿是**分配问题**：即使每轮都跳过队头，大作业仍可能因为"永远有更小的作业填满空隙"而拿不到资源。Kueue 用 fair sharing/DRS + 优先级缓解；Volcano 用 `share`/`deserved` + `JobStarving` + preempt/reclaim 缓解；原生没有内建公平，只有优先级和抢占。

> [!WARNING]
> `BestEffortFIFO` 不是"公平"：它只保证队头不可准入时不阻塞后面，不保证落后的大作业最终能拿到份额。公平要看 share/DRS 和等待时间分布，不能只看"有没有跳过队头"。

### 5.3 公平的度量

至少四个口径，不能混：

- **队列 share**：Volcano 的 `max_r allocated_r/deserved_r`；Kueue 的 DRS 是"借用超出配额的部分 / 父 cohort 可出借量"，再除以 weight。两者分母不同，不能直接比数值。
- **DRS**：Kueue 的 dominant resource share，强调"最紧的那个资源"；适合判断谁在借用上占便宜。
- **等待时间分布**：按作业大小、队列、优先级分组的 P50/P95/P99；平均值会掩盖大作业的长尾。
- **分配率/利用率**：`allocated/deserved` 或 `allocated/capability`；高利用率不等于公平，也不等于没有碎片。

DRF 是另一套：Volcano 的 `drf` 插件按 dominant resource 的 `share/weight` 做队列/Job 排序（[`drf.go` L168-L181](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/drf/drf.go#L168-L181)），适合多资源形状差异大的批作业；它和 proportion 的 `share=allocated/deserved` 不是同一公式。aging 方面，原生没有内建 aging；Volcano 用 `JobStarving` + preempt/reclaim 缓解，Kueue 用 fair sharing/优先级/重试，但都不保证有界等待。

具体指标定义和同轨迹对比方法见 [调度正确性与优化证据](./scheduling-evidence.md)，这里不重复公式。

## 6. Gang：原子性的边界在哪里

### 6.1 原生 PodGroup：minCount + Permit，5 分钟超时

`GenericWorkload` 是 Beta 但默认关闭（[`kube_features.go` L1622-L1625](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1622-L1625)）。开启后，Pod 通过 `spec.schedulingGroup.podGroupName` 关联到 `PodGroup`；`GangSchedulingPolicy.minCount` 是准入门槛（[`types.go` L443-L460](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/scheduling/v1beta1/types.go#L443-L460)）。

执行分两段：

1. `PreEnqueue`：PodGroup 不存在，或 `AllPodsCount < minCount`，Pod 不进队列（[`gangscheduling.go` L204-L215](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/gangscheduling/gangscheduling.go#L204-L215)）。这里数的是"调度器已知的 Pod 数"，不是"能放下的 Pod 数"。
2. `Permit`：`ScheduledPodsCount`（assumed + assigned）达到 `minCount` 才允许；否则返回 `Wait`，超时 `5 * time.Minute`（[`gangscheduling.go` L38-L42](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/gangscheduling/gangscheduling.go#L38-L42)、[`gangscheduling.go` L396-L409](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/gangscheduling/gangscheduling.go#L396-L409)）。

超时不是"重新等 5 分钟"：`waitingPod` 的 timer 到期会 `Reject`（[`waiting_pods_map.go` L95-L106](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/runtime/waiting_pods_map.go#L95-L106)），`WaitOnPermit` 返回 rejected，绑定周期失败，`unreserveAndForget` 释放 assume 的资源，Pod 被写 `Unschedulable` 并回到不可调度池（[`schedule_one.go` L433-L447](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/schedule_one.go#L433-L447)）。所以 native gang 的"原子性"是**准入原子性**，不是绑定原子性：quorum 满足后会逐个 `Allow`，之后每个 Pod 各自 Bind；某个 Bind 失败不会回滚已经绑定的 Pod。

这部分细节在 [native-scheduler.md](./native-scheduler.md) 的绑定周期和失败矩阵里有更完整的时序，这里只保留策略含义。

### 6.2 Volcano：minMember / MinAvailable，提交时才提交

Volcano Job 的 `spec.minAvailable` 由 job controller 写进 PodGroup 的 `spec.minMember`（[`job_controller_actions.go` L851-L852](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/controllers/job/job_controller_actions.go#L851-L852)）；调度器侧 `JobInfo.MinAvailable` 在 `SetPodGroup` 里直接取 `MinMember`（[`job_info.go` L555-L558](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/api/job_info.go#L555-L558)）。`IsReady()` 的判定是 `ReadyTaskNum() + PendingBestEffortTaskNum() >= MinAvailable`（[`job_info.go` L1352-L1354](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/api/job_info.go#L1352-L1354)）。`PendingBestEffortTaskNum` 只数"没有普通请求也没有 DRA claim"的 Pending task（[`job_info.go` L1041-L1053](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/api/job_info.go#L1041-L1053)）——这意味着 BestEffort Pod 可以在没有被分配的情况下帮助 gang 达标，是一个容易忽略的语义变化。

`gang` 插件注册 `JobValid`（有效 task 数 < `MinAvailable` 就拒绝）、`Preemptable`/`Reclaimable`（victim 的 Job 已 ready 数必须大于 `MinAvailable` 才能抢）和 `JobReady`（[`gang.go` L57-L130](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/gang/gang.go#L57-L130)）。`allocate` action 只有在 `JobReady` 时才 `Commit` statement；没 ready 就 `Discard`，中间分配不落到 cache。这避免了"A、B 两个 gang 各占一部分资源、互相等对方"的死锁，但代价是**大 gang 在容量不足时不会部分占位**，它会一直等，直到 preempt/reclaim 或新容量出现。

### 6.3 Kueue：作业级准入不是 gang

Kueue 的 `Admit` 是 Workload 级的，粒度是"这个作业能不能开始"；它没有 Pod 级 `Permit`，也不保证同一 Workload 的 Pod 同时被放置。`waitForPodsReady` 这类配置可以让"上一个作业的 Pod 没 ready 就不放行下一个"，但那是**串行化**，不是**同时放置**。所以：

- Kueue + 原生 gang：Kueue 先准入，Pod 创建后由 kube-scheduler 的 `GangScheduling` 插件做 minCount/Permit。
- Kueue + Volcano：Kueue 管队列与准入，Volcano 管 PodGroup 的放置与 gang；两者不是替代关系。
- Kueue 单独：只有作业级队列，没有 gang 原子性。

### 6.4 JobSet / LWS / 训练作业

JobSet、LeaderWorkerSet 和训练 operator 本身通常只表达"副本、启动顺序、角色"，不提供调度器级的配额/原子准入；gang 语义取决于它们是否创建 PodGroup、以及集群里跑的是哪个调度器/插件。在提供调度集成的版本里，它们可能创建 PodGroup 并写入 minCount（例如 LWS 的 Volcano provider），但**最终能不能原子放置仍由调度器决定**。不要从"用了 JobSet/LWS"推断"一定有 gang"。具体工作负载形状见 [工作负载建模](../../AI_Infrastructure/Distributed_Training/workload-modeling.md)。

### 6.5 失败模式

| 失败模式 | 触发条件 | 后果 | 观测点 |
| --- | --- | --- | --- |
| 部分绑定 | quorum 满足后，个别 Pod Bind 失败 | 已绑定的 Pod 不会回滚，作业可能半跑 | Bind 错误、Pod 分布、Job 状态 |
| Permit 超时 | minCount 在 5 分钟内没达到 | 全部 assume 释放，Pod 变 Unschedulable | `FailedScheduling` 事件、Permit wait 指标 |
| 互等/自旋 | 多个 gang 各占一部分资源 | 最多等 5 分钟，之后超时释放；期间容量被占着 | 调度吞吐、Permit 等待时长 |
| 死锁（Volcano） | 多个 job 互相等，但 allocate 不提交 | 不会占住资源，但大 job 可能长期饥饿 | `JobStarving`、pending 时长 |
| 碎片导致放不下 | 总空闲够，但单个节点/域不够 | gang 整体 Pending | `FailedScheduling` 的节点分布、域内空闲 |

## 7. 回填：三种完全不同的东西

### 7.1 原生：没有内建 backfill

原生调度器没有"未来时间轴"和"reservation"对象。`PriorityQueue.Pop` 只取堆顶（[`scheduling_queue.go` L1335-L1338](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/backend/queue/scheduling_queue.go#L1335-L1338)），`schedulingAlgorithm` 只在当前 snapshot 上做 Filter/Score（[`schedule_one.go` L250-L260](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/schedule_one.go#L250-L260)）。没有"不放弃当前队头、先用空闲资源启动后面作业"的 reservation/backfill 逻辑，也没有"为高优先级作业预留未来时间窗"的机制；失败 Pod 会被移入 unschedulable/backoff，队列继续处理下一个实体，但那是重试/旁路，不是回填。

可用的替代不是 backfill，而是：

- `PreEnqueue`/`SchedulingGates`：把 Pod 挡在队列外，等外部控制器一起放行（常用于 gang 组队、数据就绪）。
- `nominatedNodeName` + 抢占：为 preemptor 提名一个节点，但这不是 reservation，victim 没退出前资源仍被占。
- Kueue 的 `BestEffortFIFO`：在**准入层**跳过队头，不是节点层的回填。

### 7.2 Volcano：v1.16.1 的 backfill 只处理 BestEffort

这是本页最需要按代码复核的一条。Volcano 默认 action 是 `enqueue, allocate, backfill`（[`util.go` L38-L51](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/util.go#L38-L51)），但 `pickUpPendingTasks` 里对每个 Pending/Pipelined task 都做了同一个过滤：

```go
// Backfill handles only tasks with neither ordinary requests nor DRA claims.
if task.HasSchedulingResourceRequests() {
    continue
}
```

（[`backfill.go` L137-L180](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/actions/backfill/backfill.go#L137-L180)）`HasSchedulingResourceRequests` 为真表示 task 有普通请求或有 `ResourceClaims`。也就是说，**带 requests 的小作业不会走 v1.16.1 的 backfill**，只有 BestEffort（无请求）Pod 会被捡起来做 first-fit + node order。它不检查 gang 是否 ready，也不为未来预留；它的价值是"把空隙用零请求 Pod 填上"，不是"让带 GPU 的小作业插队"。

> [!WARNING]
> 如果你的集群依赖"backfill 让带 requests 的小作业填满大作业留下的空隙"，请先在目标版本验证这条路径。这份代码的语义与很多旧文档/直觉不同。

### 7.3 Slurm：保守回填靠 reservation 证明"不延迟"

Slurm 的 `sched/backfill` 是另一种东西：它按优先级从高到低建立 `node_space` 时间切片，为高优先级作业在时间轴上预留资源，然后只启动那些"不会推迟任何已承诺 reservation"的低优先级作业。`bf_interval` 默认 30 秒，`bf_resolution` 默认 60 秒，`bf_max_job_test` 当前文档默认 500，`bf_max_time` 默认等于 `bf_interval`（[`slurm.conf`](https://slurm.schedmd.com/slurm.conf.html)、[`sched_config`](https://slurm.schedmd.com/sched_config.html)）；这些值随版本变化，旧资料常引用 100，部署时以本机文档为准。

"保守"的核心不是算法，而是**可证明性**：作业有 time limit，reservation 有明确的开始/结束时间，所以可以判断"低优先级作业在当前空闲上跑，会不会侵入高优先级作业的预留窗口"。没有 time limit / reservation 的系统，无法做这种证明。Kubernetes 的 Job 可以有 `activeDeadlineSeconds`，但它不是调度器承诺的结束时间，不能拿来当 Slurm 式 reservation。

| 系统 | 回填对象 | 是否看未来时间 | 是否保护 reservation | 主要风险 |
| --- | --- | --- | --- | --- |
| 原生 | 无内建 | 否 | 不适用 | 大作业队头阻塞；无绕过 |
| Volcano v1.16.1 | 仅 BestEffort task | 否 | 无 reservation 概念 | 带请求的小作业不被回填；大作业可能饥饿 |
| Slurm | 低优先级 pending job | 是（`node_space`） | 是 | 估算不准/上限触发时退化为不启动 |

回填对利用率/等待/碎片的影响要分开看：它提高短期利用率，但会把空闲资源切成更小的块，增加后续大作业的碎片和等待；保守回填用 reservation 保护高优先级作业，代价是低优先级作业可能被反复跳过。用同轨迹对比时，必须把"backfill 启动的小作业"和"被推迟的大作业"分开统计，否则利用率上升会掩盖大作业等待变差。

## 8. 碎片：容量够不等于放得下

### 8.1 三种碎片

- **资源碎片**：各维度总空闲都够，但没有一个节点能同时满足一个 Pod 的所有维度。例如总空闲 16 CPU/64GiB，但每个节点只剩 2 CPU/32GiB，一个要 4 CPU/8GiB 的 Pod 仍可能放不下（取决于节点分布）。
- **拓扑碎片**：总空闲跨多个域够，但 gang 要求所有 Pod 在同一个 rack/NVLink domain，单个域不够。TAS 和 Volcano hard topology 都会放大这种碎片。
- **设备碎片**：空闲 GPU 数量够，但型号/显存/MIG 组合不匹配。4 张空闲卡里 2 张 A100、2 张 H100，一个 4×A100 的请求就是不可行。

形式化地说：容量判断是 `∀r: Σ_nodes free_r >= demand_r`；放置判断是 `∃ assignment: 每个 Pod 的每个维度都满足，且拓扑/设备约束满足`。**后者为假、前者为真，就是碎片**。

### 8.2 binpack vs spread

- **binpack**：优先填满已用节点（`MostAllocated`、Volcano `binpack`、HAMi 节点 binpack）。它减少"半空节点"数量，降低资源碎片，但可能把负载集中到少数节点，放大故障域和热/网络争用。
- **spread**：优先空闲节点（`LeastAllocated`、`PodTopologySpread`、HAMi spread）。它提升故障隔离和带宽，但会把空闲资源打散，增加"总够但放不下大作业"的概率。

原生的 `NodeResourcesFit` 默认是 `LeastAllocated`（spread）（[`defaults.go` L232-L240](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/apis/config/v1/defaults.go#L232-L240)），可以切到 `MostAllocated`/`RequestedToCapacityRatio`；`NodeResourcesBalancedAllocation` 又会把 CPU/内存的平衡拉回来。Volcano 用 `nodeorder` 做常规打分，另有 `binpack` 插件给"已用节点"加权；两者是不同插件，不是同一个打分器。HAMi 的节点/设备策略见 [HAMi：Kubernetes 异构 AI 算力虚拟化与调度](../../AI_Infrastructure/Accelerators/hami.md)。

binpack 不是无脑更好：对 gang + 拓扑敏感的作业，binpack 可能把同一 gang 的 Pod 塞进一个域，反而降低跨域可用性；对延迟敏感的服务，spread 更合适。策略要按负载类型选，不能全局一个默认。

### 8.3 怎么判断"还有资源但放不下大作业"

按顺序做四件事：

1. **看总量**：`Σ free` 是否 >= 作业需求；如果总量都不够，是容量问题，不是碎片。
2. **看单节点/单域**：对每个候选节点/域，计算"能容纳的最大同形状 Pod 数"；如果 `max_domain_capacity < gang_size`，是拓扑/资源碎片。
3. **看设备属性**：按 DeviceClass/型号/显存分组统计空闲设备，而不是只数 `nvidia.com/gpu`。
4. **看失败原因分布**：`FailedScheduling` 里是 `Insufficient cpu`、`node(s) didn't match PodTopologySpread`、`resourceclaim not available`，还是 `must be in same topology domain`；不同原因对应不同层。

可定义的度量（不是实测值）：

```
fragmentation_index(r) = 1 - max_{feasible pod shape} size(r) / total_free(r)
unplaceable_ratio       = pending_large_job_demand / total_free_capacity
```

前者按维度看"最大可放置请求/总空闲"，后者看"放不下的大作业需求占比"。这两个指标都依赖"大作业"的定义，报告时必须写清楚阈值，否则不可比。

## 9. 异构卡型：从 nodeSelector 到设备属性

GPU 型号/显存/算力/MIG 不是一回事：

- **型号**：A100/H100/昇腾 910B……决定架构、算子兼容性、NVLink 拓扑。
- **显存**：80GB/40GB/24GB；决定 batch size、能否放下模型/激活。
- **算力**：同一型号的不同 SKU（如 80GB PCIe vs SXM）或不同代际；决定吞吐。
- **MIG**：一张物理卡切成多个 GPU instance；每个 instance 有独立显存/算力，资源名和调度方式取决于 device plugin/DRA driver。

把它们压缩成一个 `nodeSelector: gpu-type=a100` 会丢失三件事：节点上可能混插不同卡；Pod 需要的是"设备"而不是"节点"；同一节点上的多张卡可能属于不同 NUMA/NVLink 域。

三层设备选择：

1. **队列层**：Kueue `ResourceFlavor` 把"一类节点"映射成一个 flavor，配额按 flavor 记；Volcano 用 Queue 的 `capability`/`deserved` 按资源名（含 extended resource）做配额。这里决定"这个租户能用多少 A100"。
2. **节点层**：kube-scheduler 的 `NodeAffinity`/`NodeResourcesFit`/`PodTopologySpread` 选节点；Volcano `predicates`/`nodeorder` 选节点；HAMi 的节点策略也在此层。
3. **设备层**：device plugin 的整数计数、HAMi 的 device-level 调度、DRA 的 `DeviceClass`/CEL/`ResourceSlice` 选具体设备。

HAMi 的设备级调度是"节点内"的：它把每张卡注册成多个虚拟槽位，按 `gpumem`/`gpucores` 切分，支持 `use-gputype`/`nouse-gputype`、`mutex`、`topology-aware`、NUMA 绑定；节点级用分布式锁避免同一 PodGroup 的成员抢锁失败（详见 [HAMi 页面](../../AI_Infrastructure/Accelerators/hami.md)）。它解决的是"一张卡切给多个 Pod"和"选哪张卡"，不是队列公平。

DRA 把设备属性变成一等公民：

- `DeviceClass.spec.selectors` 是 CEL 表达式，按 `Device.attributes`/`capacity` 过滤（[`types.go` L2422-L2429](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/resource/v1/types.go#L2422-L2429)）；
- `ResourceSlice` 由 driver 发布，包含 pool、device、attributes、capacity、node 信息；
- `firstAvailable` 允许"优先 A100，退而求其次 H100"；
- 设备 taint/toleration、partitionable devices、consumable capacity 等是额外的可行性维度。

Kueue 的 `ResourceFlavor` 负责"把配额绑到一类节点/设备"；Kueue 的 DRA 集成进一步把 DRA-backed extended resource 从 flavor 的节点容量计算中**委托**出去，避免"节点上 `nvidia.com/gpu` 计数"和"DeviceClass 设备"双重计数（[`dra_flavorassigner.go` L31-L56](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/scheduler/flavorassigner/dra_flavorassigner.go#L31-L56)）。它不做设备选择；设备选择仍是 DRA allocator 的事。

## 10. 拓扑：约束、域与 gang 的交互

### 10.1 原生三件套

- `PodTopologySpread`：按 `topologyKey` 统计域内匹配 Pod 数，要求 `maxSkew` 不超过阈值；`whenUnsatisfiable: DoNotSchedule` 是硬约束，`ScheduleAnyway` 只影响打分；`minDomains` 防止"域太少导致 skew 失真"；`nodeAffinityPolicy`/`nodeTaintsPolicy` 决定哪些节点计入。Filter 在节点层执行（[`filtering.go` L318-L340](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/podtopologyspread/filtering.go#L318-L340)）。
- `InterPodAffinity`：required/preferred 的 Pod 亲和/反亲和，按 `topologyKey` 判断"同域"；required 不满足直接不可调度（`UnschedulableAndUnresolvable`）；它是全集群视角的，成本高，且与 spread 可能互相打架。
- `VolumeBinding`：`WaitForFirstConsumer` 把 PV 绑定推迟到 Pod 调度时；PreFilter 检查未绑定的 immediate PVC，Filter 检查节点拓扑与 PV 是否匹配（[`volume_binding.go` L351-L386](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/volumebinding/volume_binding.go#L351-L386)）。存储拓扑和计算拓扑在这里耦合：卷在 rack A，Pod 就不能去 rack B。

### 10.2 TAS（KEP-5732）：workload 级拓扑

`TopologyAwareWorkloadScheduling` 是 Alpha 默认关闭（[`kube_features.go` L2231-L2235](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L2231-L2235)）。PodGroup 的 `spec.schedulingConstraints.topology[0].key` 要求"组内所有 Pod 在同一域实例"（[`types.go` L846-L857](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/scheduling/v1beta1/types.go#L846-L857)）。`TopologyPlacement.GeneratePlacements` 按 topologyKey 把候选节点分成多个 `Placement`（每个域一个），如果已有 Pod 被调度，则只保留那个域（[`topology_placement.go` L60-L99](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/topologyaware/topology_placement.go#L60-L99)）。

与 gang 的交互：

- gang 的 `PlacementFeasible` 在**每个 Placement 内**检查 minCount；因此"集群总容量够、但没有任何一个域能容纳 minCount"时，整个 gang 不可调度。
- TAS 只支持单个 topology constraint（API 目前 `maxItems=1`），不要假设可以同时表达"同 rack + 同 NUMA"。
- TAS 没有"soft"模式；要降级只能关掉 TAS 或改用 `PodTopologySpread` 的 `ScheduleAnyway`，这是语义变化，不是无损降级。

### 10.3 Volcano network-topology-aware / HyperNode

Volcano 用 `HyperNode` CRD 表达网络拓扑树（tier、父节点、节点集合），Job 的 `networkTopology.mode` 是 `hard`/`soft`，`highestTierAllowed` 限制可跨的最高层（[`job.go` L124-L150](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L124-L150)）。`network-topology-aware` 插件注册 HyperNode 候选/排序回调，hard 模式把候选限制在允许的 tier 内（[`network_topology_aware.go` L271-L305](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/plugins/network-topology-aware/network_topology_aware.go#L271-L305)）。

两个限制要记住：

1. hard 模式下，如果某个 tier 内的资源不够整个 gang，作业不可调度；soft 模式允许跨域，但插件仍会对 HyperNode 打分（binpack 相关权重），不能保证"不跨"。
2. v1.16.1 的 `preempt` 明确跳过带 `networkTopology` 的 Job（[`preempt.go` L132-L137](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/scheduler/actions/preempt/preempt.go#L132-L137)）。也就是说，拓扑敏感的 gang 不能靠抢占腾位置；只能靠 reclaim（如果插件允许）或等资源。

拓扑约束的降级策略必须显式写进策略：`PodTopologySpread` 用 `ScheduleAnyway`，Volcano 用 `soft` 或提高 `highestTierAllowed`，TAS 只能关 gate/改约束。不要用"把 maxSkew 调大"来假装软约束——它仍然是硬 Filter，只是更容易满足。

## 11. DRA：把设备可行性做成一等公民

### 11.1 对象与分配流程

- `ResourceClaim`：Pod 引用；`ResourceClaimTemplate`：每个 Pod 从模板生成一个 claim；`DeviceClass`：driver + CEL selector + config；`ResourceSlice`：driver 发布的设备清单（pool/device/attributes/capacity/node）。
- DRA 的 GA 形态是 **structured parameters**：claim 写 `deviceClassName`/`selectors`/`count`，由调度器分配设备，而不是 driver 自定义的 opaque 分配；这也是"设备可行性可以进入调度器"的前提。
- `DynamicResourceAllocation` 在 v1.37 已 GA、默认开启（[`kube_features.go` L1579-L1585](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1579-L1585)）。`DRAPrioritizedList` 也已 GA（v1.36 起默认 true），所以 `firstAvailable` 是默认能力，不是 beta 惊喜。

调度器里的四段：

1. **PreFilter**：解析 Pod 的 claims/templates；已分配但不可 reserved 的 claim 直接 `Unschedulable`（"resourceclaim in use"）；检查 DeviceClass 是否存在；构建 allocator（[`dynamicresources.go` L575-L600](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/dynamicresources/dynamicresources.go#L575-L600)）。
2. **Filter**：对每个节点，先检查已分配 claim 的 node selector / binding conditions，再调用 `allocator.Allocate(node, claimsToAllocate)` 做试分配；成功结果缓存在 `state.nodeAllocations[node]`（[`dynamicresources.go` L936-L958](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/dynamicresources/dynamicresources.go#L936-L958)）。`ErrFailedAllocationOnNode` 是"这个节点不行"，可继续试别的节点；CEL 编译/运行时错误是 `Error`，会中止并重试。
3. **Reserve**：不写 API，只把 allocation 写进内存中的 claim 副本，并 `SignalClaimPendingAllocation` 记录 pending allocation；PodGroup 场景还会把 claim 记入 `pendingAllocations`，供同组后续 Pod 复用（[`dynamicresources.go` L1473-L1584](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/dynamicresources/dynamicresources.go#L1473-L1584)）。
4. **PreBind**：`bindClaim` 真正更新 `ResourceClaim.Status.Allocation` 和 `ReservedFor`；失败会触发 Unreserve（[`dynamicresources.go` L1664-L1695](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/scheduler/framework/plugins/dynamicresources/dynamicresources.go#L1664-L1695)）。`Unreserve` 负责撤销 pending allocation、恢复 assumed claim；如果这是最后一个引用者，allocation 才会被真正释放。

`Allocator` 的接口注释说得很清楚：`Allocate` 只针对一个节点算分配，失败返回 nil 表示"这个节点不行"，只有输入数据（例如 CEL）坏了才返回 fatal error（[`allocator.go` L92-L121](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/dynamic-resource-allocation/structured/allocator.go#L92-L121)）。这就是"试分配"的语义边界。

### 11.2 候选设备筛选

`isSelectable` 逐个 device 检查：feature gate、class selector、request selector、per-device node selection（[`allocator_stable.go` L1027-L1076](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/dynamic-resource-allocation/structured/internal/stable/allocator_stable.go#L1027-L1076)）。selector 是 CEL，`selectorsMatch` 编译并执行 `DeviceMatches`，把 device 的 attributes/capacity 传给表达式（[`allocator_stable.go` L1079-L1100](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/dynamic-resource-allocation/structured/internal/stable/allocator_stable.go#L1079-L1100)）。此外还会检查设备 taint、可用 counter、partitionable/consumable capacity。

因此 DRA 的可行性不是"节点有 N 张卡"，而是"存在一个设备集合，满足 class + request 的所有 CEL、数量、capacity、taint、拓扑、可用性约束"。这是组合问题，不能用一个标量比较替代。

### 11.3 PodGroup 级 claim（KEP-5729）

`DRAWorkloadResourceClaims` 是 Beta 默认关闭（[`kube_features.go` L1545-L1549](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1545-L1549)）。KEP-5729 允许 `PodGroup` 引用 `ResourceClaim`/`ResourceClaimTemplate`，claim 为整个 PodGroup 保留，而不是单个 Pod（[KEP-5729](https://github.com/kubernetes/enhancements/tree/master/keps/sig-scheduling/5729-resourceclaim-support-for-workloads)）。

与 native gang 的交互：同一个 PodGroup 的多个 Pod 可以共享一个 pending allocation；`PreFilter` 会复用 `podGroupState.pendingAllocations`（上面 `dynamicresources.go` 的 L665 附近），`Reserve` 记录，`PreBind` 只绑定一次。失败时 `Unreserve` 必须等所有共享者都释放才真正撤销——这是引用计数，不是单个 Pod 的清理。策略上要记住：**共享 claim 把"设备分配"和"gang 准入"绑得更紧，任何部分失败都会影响整组**。

### 11.4 Kueue 的 DRA 角色

Kueue 的 DRA 集成有两个不同的动作，不要混：

- **配额记账**：把 DeviceClass 映射成逻辑资源，让 `ClusterQueue` 能按设备类别/数量做配额与借用；partitionable/consumable capacity 有单独的 gate。
- **委托设备可行性**：`delegateDRABackedExtendedResources` 在 flavor assignment 时把 DRA-backed extended resource 清零，避免"节点容量"重复决定；是否在准入前做逐节点设备可行性检查由 `KueueDRADeviceFeasibility` 控制（[`kube_features.go` L653-L659](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/features/kube_features.go#L653-L659)）。它不替代 kube-scheduler 的 DRA allocator。

### 11.5 DRA 与 gang/拓扑/多集群

- **gang**：DRA 的试分配是 per-node 的；gang 需要"所有成员在同一节点/域都能拿到设备"，这只能由 gang 的 placement 检查 + DRA 的 Filter 共同保证。未启用 KEP-5729 的 PodGroup 共享 claim 时，DRA 分配是 per-Pod 的；即使启用，共享 claim 也只覆盖同一个 claim，不等于整组的所有设备一次性原子分配。
- **拓扑**：DeviceClass 的 CEL 可以按 `Device.attributes` 里的拓扑属性过滤；TAS 的 placement 域必须和 DRA 的 node selector 一致，否则一个说"同 rack"、一个说"设备只在另一 rack"。
- **多集群**：ResourceClaim 是集群内对象；MultiKueue 分发 Workload 时，worker 集群必须有自己的 DeviceClass/ResourceSlice/claim 模板。设备库存不同，不能在 manager 侧"预分配"。

## 12. 多集群：容量、数据、网络、配额、故障域

### 12.1 Kueue MultiKueue：分发，不是全局最优

MultiKueue 的分工是：manager 集群持有 `Workload` 和一个 `MultiKueue` AdmissionCheck；worker 集群各跑一套 Kueue；dispatcher 选择 worker，worker 的 Kueue 做准入，manager 同步状态。内置两种 dispatcher：

- `all-at-once`（默认）：把所有可用 worker 都提名，谁先接受就用谁；`NominatedClusterNames` 一次性写入（[`workload.go` L1262-L1288](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/controller/admissionchecks/multikueue/workload.go#L1262-L1288)）。
- `incremental`：先提名最多 3 个 worker，再按 `stepSize`（默认 3）扩展（[`configuration_types.go` L442-L449](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/config/v1beta2/configuration_types.go#L442-L449)）。
- 外部 dispatcher：通过 `DispatcherName` 指定，代码路径与 incremental 共用"读取已有提名"的分支。

失败回切：`WorkerLostTimeout` 默认 15 分钟（[`configuration_types.go` L394-L399](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/config/v1beta2/configuration_types.go#L394-L399)），在连接丢失期间保持 AC `Ready`；worker 上 Workload 被驱逐或 out-of-sync 时，把 AC 置 `Retry` 重新分发，并清理远端对象（[`workload.go` L650-L668](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/controller/admissionchecks/multikueue/workload.go#L650-L668)、[`workload.go` L729-L744](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/pkg/controller/admissionchecks/multikueue/workload.go#L729-L744)）。它不是"跨集群 gang"，也不搬运数据：数据集、镜像、PVC、网络连通都要预先就绪。

### 12.2 Volcano：有 HyperJob API，但没有生产级多集群调度器

Volcano 核心仓库有 `HyperJob` API（`training.volcano.sh/v1alpha1`），字段包括 `replicatedJobs`、`minAvailable`、`maxDomains`、`clusterNames`、`splitPolicy`（static/auto）（[`hyperjob.go` L37-L76](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/staging/src/volcano.sh/apis/pkg/apis/training/v1alpha1/hyperjob.go#L37-L76)）。设计文档明确把 **cluster federation / 网络 / 数据管理** 列为 out of scope，并说自动 split 是 future work。核心仓库里也没有 HyperJob controller 的实现；`Queue.spec.extendClusters` 触发 Job 的 forwarding 标记（annotation）（[`job_controller_actions.go` L394-L400](https://github.com/volcano-sh/volcano/blob/a2543678633b4e30fda413f8ad386fc34e10f8ae/pkg/controllers/job/job_controller_actions.go#L394-L400)），实际的跨集群投递/联邦不在核心调度器里，要靠外部系统。

所以结论要写清楚：**Volcano 核心仓库不含生产级多集群调度**；HyperJob 是 API/设计层的前瞻，不是一个开箱可用的全局调度器。

### 12.3 多集群可行性 = 容量 + 数据/镜像 + 网络 + 配额 + 故障域

不要简化成"选一个集群"。至少检查：

| 维度 | 要问的问题 | 失败表现 |
| --- | --- | --- |
| 容量 | 每个候选集群的 free/allocatable 是否满足作业形状（含 gang/拓扑/设备） | worker 准入失败，或 Pod Pending |
| 数据/镜像 | 数据集在不在？PVC 是否 RWX/可跨集群？镜像是否预热？ | 启动慢、挂载失败、重复拉取 |
| 网络 | 跨集群带宽/延迟/NCCL 拓扑是否满足训练通信？ | 训练吞吐下降，甚至超时 |
| 配额 | 每个集群的 Kueue/Volcano 配额是否允许？manager 的配额和 worker 的配额是否重复计算？ | 分发成功但 worker 拒绝准入 |
| 故障域 | 两个集群是否共享电源/网络/区域？故障是否相关？ | 同时失效，gang 全灭 |

MultiKueue 的 "first accepting wins" 只解决"哪里能跑"，不解决"哪里跑得最好"；它不做全局 binpack，也不做跨集群抢占。需要全局最优时，得在 manager 侧自己收集容量/数据/网络指标，做候选排序，再把结果表达成 worker 的提名/配额，而不是指望 MultiKueue 替你做。

## 13. 决策表与检查清单

| 负载 | 先看哪一层 | 关键对象/字段 | 首调手段 | 不要做什么 |
| --- | --- | --- | --- | --- |
| 单 Pod / 小作业 | 放置 | requests、NodeResourcesFit、nodeSelector | 调 requests/limits、节点池、score 策略 | 为它引入 gang/队列配额 |
| 多租户批作业 | 权益 + 准入 | Kueue CQ/cohort 或 Volcano Queue | nominal/borrowing、capability/deserved、FairSharing | 把 PriorityClass 当配额 |
| 大 gang 训练 | 准入 + gang + 拓扑 | `minCount`/`minMember`、Permit、TAS/hard topology | 先保证 gang 能整体放下，再谈利用率 | 把 Kueue 准入当 gang |
| 异构 GPU | 设备 + 队列 | DeviceClass/CEL、ResourceFlavor、HAMi 资源 | 按 flavor/DeviceClass 做配额，按设备属性选卡 | 只用 nodeSelector 选卡型 |
| 拓扑敏感 | 拓扑 | topologyKey、TAS、HyperNode | 先确认域内容量，再选 hard/soft | 用 maxSkew 假装软约束 |
| DRA 设备 | 设备 + 放置 | claim/template、DeviceClass、ResourceSlice | 用 CEL 表达属性，用 firstAvailable 兜底 | 把 DRA 当 extended resource 计数 |
| 多集群 | 容量 + 数据 + 网络 + 配额 | MultiKueue、worker 配额、存储/镜像 | 先做候选集群可行性矩阵 | 把 MultiKueue 当全局最优调度 |

检查清单（按顺序）：

- [ ] 需求是否按 PodSet 展开，gang size、拓扑、设备属性是否都进了需求？
- [ ] 权益用的是 nominal/borrowing、capability/deserved，还是只有一个 PriorityClass？
- [ ] 准入失败时，是 Workload 未 admit、PodGroup 未 Inqueue，还是 Pod 未入 activeQ？
- [ ] gang 的 `minCount`/`minMember` 与副本数、`maxReplicas`、`parallelism` 是否一致？
- [ ] 回填/抢占是否依赖了目标版本并不存在的语义（尤其是 Volcano backfill 只处理 BestEffort）？
- [ ] 碎片判断是否看了"总空闲"以外的单节点/单域/设备属性？
- [ ] 拓扑约束在不可满足时，降级是显式的吗？降级后 gang 的原子性还成立吗？
- [ ] DRA claim 的 `Reserve`/`PreBind`/`Unreserve` 失败是否有可观测的 condition/event？
- [ ] 多集群是否把数据、镜像、网络、配额、故障域都当成可行性条件，而不是只看 CPU/GPU 总数？

> [!WARNING]
> 常见反模式：把 Kueue 当 gang；把 Volcano `capacity` 当 Kueue `ClusterQueue`；用 nodeSelector 代替设备属性；用平均利用率证明"没有碎片"；把 MultiKueue 当全局最优；把 Volcano v1.16.1 的 backfill 当成"带请求的小作业回填"。这些都会让策略结论在真实负载下失效。

## 参考资料

### 官方文档

- Kubernetes：[Pod 优先级与抢占](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)、[Pod 拓扑分布约束](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)、[DRA](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)、[Gang Scheduling](https://kubernetes.io/docs/concepts/scheduling-eviction/gang-scheduling/)、[Topology Aware Scheduling](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-aware-scheduling/)、[ResourceQuota](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- Kueue：[ClusterQueue](https://kueue.sigs.k8s.io/docs/concepts/cluster_queue/)、[Cohort](https://kueue.sigs.k8s.io/docs/concepts/cohort/)、[Fair Sharing](https://kueue.sigs.k8s.io/docs/concepts/fair_sharing/)、[Preemption](https://kueue.sigs.k8s.io/docs/concepts/preemption/)、[MultiKueue](https://kueue.sigs.k8s.io/docs/concepts/multikueue/)、[DRA](https://kueue.sigs.k8s.io/docs/concepts/dynamic_resource_allocation/)、[ResourceFlavor](https://kueue.sigs.k8s.io/docs/concepts/resource_flavor/)、[AdmissionCheck](https://kueue.sigs.k8s.io/docs/concepts/admission_check/)
- Volcano：[Scheduler Overview](https://volcano.sh/docs/Scheduler/Overview/)、[Actions](https://volcano.sh/docs/Scheduler/Actions/)、[Queue](https://volcano.sh/docs/Concepts/Queue/)、[Gang](https://volcano.sh/docs/Scheduler/Plugins/gang/)、[Proportion](https://volcano.sh/docs/Scheduler/Plugins/proportion/)、[Network Topology Aware](https://volcano.sh/en/docs/network_topology_aware_scheduling/)
- Slurm：[sched_config](https://slurm.schedmd.com/sched_config.html)、[slurm.conf](https://slurm.schedmd.com/slurm.conf.html)

### KEP

- [KEP-4671 Gang Scheduling](https://github.com/kubernetes/enhancements/tree/master/keps/sig-scheduling/4671-gang-scheduling)
- [KEP-5710 Workload Aware Preemption](https://github.com/kubernetes/enhancements/tree/master/keps/sig-scheduling/5710-workload-aware-preemption)
- [KEP-5729 DRA ResourceClaim Support for Workloads](https://github.com/kubernetes/enhancements/tree/master/keps/sig-scheduling/5729-resourceclaim-support-for-workloads)
- [KEP-5732 Topology Aware Workload Scheduling](https://github.com/kubernetes/enhancements/tree/master/keps/sig-scheduling/5732-topology-aware-workload-scheduling)

### 源码（固定 commit）

- Kubernetes `c50e5395`：`pkg/features/kube_features.go`、`pkg/scheduler/framework/plugins/{queuesort,schedulinggates,gangscheduling,dynamicresources,topologyaware,podtopologyspread,volumebinding}`、`staging/src/k8s.io/api/scheduling/v1beta1/types.go`、`staging/src/k8s.io/dynamic-resource-allocation/structured/`
- Volcano `a2543678`：`pkg/scheduler/{util.go,api/job_info.go,actions/{allocate,backfill,preempt,reclaim},plugins/{proportion,capacity,gang,network-topology-aware,predicates}}`、`staging/src/volcano.sh/apis/pkg/apis/{scheduling/v1beta1,batch/v1alpha1,training/v1alpha1}`
- Kueue `be7dc9d`（main@2026-11-23，晚于 v0.20.8）：`apis/kueue/v1beta2/{clusterqueue,cohort,fairsharing}_types.go`、`pkg/cache/scheduler/{resource_node,fair_sharing}.go`、`pkg/scheduler/{scheduler.go,fair_sharing_iterator.go,preemption,flavorassigner}`、`pkg/controller/admissionchecks/multikueue/`

### 延伸阅读

- [kube-scheduler：对象、队列与调度主流程](./native-scheduler.md)
- [Scheduling Framework：扩展点、状态与并发语义](./scheduling-framework.md)
- [Volcano 调度器：Session、Action 与队列模型](./volcano-scheduler.md)
- [调度正确性与优化证据](./scheduling-evidence.md)

## 本 wiki 相关页面

- [调度器源码与策略：专题导读](./scheduling-overview.md)
- [kube-scheduler：对象、队列与调度主流程](./native-scheduler.md)
- [Scheduling Framework：扩展点、状态与并发语义](./scheduling-framework.md)
- [Volcano 调度器：Session、Action 与队列模型](./volcano-scheduler.md)
- [调度正确性与优化证据](./scheduling-evidence.md)
- [Kueue: Kubernetes 原生作业队列管理器](./kueue.md)
- [HAMi：Kubernetes 异构 AI 算力虚拟化与调度](../../AI_Infrastructure/Accelerators/hami.md)
- [Slurm: HPC 集群工作负载管理器](../../../Machine_Learning/High_Performance_Computing/slurm.md)
- [工作负载建模](../../AI_Infrastructure/Distributed_Training/workload-modeling.md)
