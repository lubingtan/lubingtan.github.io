# Kueue: Kubernetes 原生作业队列管理器

## What is Kueue

[Kueue](https://github.com/kubernetes-sigs/kueue)（发音 "cue-ay"）是一个 Kubernetes 原生的**作业队列管理器**，属于 `kubernetes-sigs` 组织。它作为作业级别的资源管理者，决定：

- 作业**何时被允许启动**（即 [Pod](../Kubernetes/1-1_k8s工作负载.md) 何时被创建），基于可用配额
- 作业**何时应停止**（即活跃 Pod 何时被删除）

Kueue 在标准 Kubernetes 调度之上提供公平共享、抢占和多租户资源管理能力，与 [kube-scheduler](../Kubernetes/4_kube-scheduler源码分析.md) 互补：scheduler 负责 Pod 的节点放置，Kueue 负责作业的准入控制与排队。

## 核心概念

### CRD 资源

| 资源 | 作用 |
|---|---|
| **Workload** | 基本工作单元，包含 PodSet、队列名、优先级、准入状态 |
| **ClusterQueue** | 集群级别的资源配额定义，支持多种 ResourceFlavor、配额借用、Cohort |
| **LocalQueue** | 命名空间级别的队列，指向某个 ClusterQueue，作业提交到 LocalQueue |
| **ResourceFlavor** | 定义资源的"口味"（如 spot vs on-demand、GPU 类型），关联节点标签和污点 |
| **Cohort** | 一组可以互相借用资源的 ClusterQueue |
| **AdmissionCheck** | 供内外部组件对工作负载准入进行把关的机制（如 provisioning 请求、MultiKueue 检查） |
| **WorkloadPriorityClass** | 定义工作负载的优先级 |

### 架构层次

Kueue 的架构分为三层：

**控制器层** (`pkg/controller/`) — 基于 controller-runtime，负责所有 CRD 的生命周期管理。包括核心控制器（Workload、ClusterQueue、LocalQueue 等）和作业框架（GenericJob 接口，支持集成任意作业类型）。

**调度器层** (`pkg/scheduler/`) — Kueue 的核心，负责：
- 查找待调度的工作负载
- 为每个 PodSet 选择合适的 ResourceFlavor（FlavorAssigner）
- 处理抢占逻辑（Preemptor），支持公平共享、层级抢占、Cohort 内抢占等策略

**缓存层** (`pkg/cache/`) — 内存状态跟踪，包括 ClusterQueue 缓存（资源使用、flavor、TAS 拓扑感知调度状态）和队列管理器（队列层级、不可准入工作负载跟踪）。

## 支持的作业类型

Kueue 通过 job framework 提供可扩展的作业集成，内置支持：

- Kubernetes Batch/Job 和 CronJob
- JobSet (`sigs.k8s.io/jobset`) — 批处理作业集
- LeaderWorkerSet (`sigs.k8s.io/lws`) — Leader-Worker 模式
- Ray — RayJob、RayCluster、RayService
- Kubeflow — 训练作业（Training Operator、Trainer v2）
- MPI Job
- Spark Application
- Deployment / StatefulSet（serving 类工作负载）
- AppWrapper
- 普通 Pod 和 Pod Group

## 关键特性

### 资源管理

- **多租户公平共享**：通过 ClusterQueue 和 Cohort 实现租户间的资源隔离与共享
- **资源配额借用**：同一 Cohort 内的 ClusterQueue 可以互相借用未使用的配额
- **抢占**：支持多种抢占策略，高优先级工作负载可抢占低优先级资源
- **ResourceFlavor**：同一资源（如 GPU）可以有多种"口味"，工作负载可指定偏好

### 拓扑感知调度 (TAS)

支持基于节点拓扑的多维度调度决策，确保工作负载在合适的拓扑域中运行。

### MultiKueue

多集群作业分发能力，是 2026 年的重点方向。支持跨集群工作负载调度、准入约束和弹性 RayJob 等。

### AdmissionCheck 机制

允许外部组件（如集群弹性伸缩、MultiKueue）对工作负载准入进行额外检查，实现可扩展的准入控制。

### 配套工具

- **kueuectl** — `kubectl kueue` 插件，管理 Kueue 资源
- **kueueviz** — Web 可视化仪表板，展示集群状态

## 关键依赖

- `controller-runtime` — Kubernetes 控制器框架
- Kubernetes 1.29+
- Prometheus — 监控指标
- cert-manager — Webhook 证书管理
- Ginkgo/Gomega — 测试框架

## 与 HAMi 的集成

Kueue 负责「作业级准入 + 队列配额」，HAMi 负责「Pod 级设备切分 + 设备感知放置」，两者是上下游关系：

- 通过 Kueue 的 **ResourceTransformation** 把 HAMi 的资源（如 `nvidia.com/gpumem`、`nvidia.com/gpucores`）映射成 Kueue 可配额的名义资源，从而在 ClusterQueue 里对「显存份额」做队列级配额与借用；
- 作业被 Kueue 准入后，Pod 仍由 HAMi 调度器（extender）完成 GPU 设备选择与绑定，Kueue 不关心具体落在哪张卡。

这与 Kueue + Volcano 的分工类似：队列层只决定「能不能开始」，设备层决定「用哪张卡、切多少」。详见 [HAMi](../AI_Infrastructure/hami.md)。

## 参考

- [Kueue GitHub](https://github.com/kubernetes-sigs/kueue)
- [Kueue 官方文档](https://kueue.sigs.k8s.io/)
