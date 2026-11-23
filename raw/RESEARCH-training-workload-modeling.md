# 云原生分布式训练编排：工作负载建模研究

> 研究问题：用 K8s 原生或生态原语表达分布式训练作业时，角色、资源、依赖、就绪/完成、服务暴露、卷、放置这七个维度分别能表达什么、不能表达什么。只读代码与官方文档；代码行号均按下方快照 SHA 核对。

## 0. 代码快照

| 仓库 | commit | commit 日期 | 本文用途 |
|---|---|---|---|
| kubernetes/kubernetes | `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` | 2026-10-27 | 原生 Job / StatefulSet / Deployment API |
| volcano-sh/volcano | `2006640ed881e632119eedb9d3fac82819402301` | 2026-11-23 | Volcano Job、PodGroup、gang、svc/env/框架插件 |
| kubernetes-sigs/jobset | `32c9ea3144095df1fbc778433505c35a53e5acfe` | 2026-11-18 | JobSet API 与成功/失败/网络语义 |
| kubernetes-sigs/lws | `51d7d5ad84f7badeee1466e4a7b846cacfdbc961` | 2026-11-23 | LWS 与 DisaggregatedSet |
| kubeflow/training-operator | `ae27d3faf401f627af88d451cab7092458083420` | 2026-11-21 | TrainJob / ClusterTrainingRuntime v2 |
| kubeflow/mpi-operator | `a057ca529cb7c3b831207d8bbd37f18136057e0f` | 2026-11-21 | MPIJob Launcher/Worker |
| kubernetes-sigs/kueue | `be7dc9d31470258dd324e5bd6d84f7eaf90f5f69` | 2026-11-23 | 队列/配额/准入边界；v1.9.4 vendored 代码 |

## 1. 一页结论

**原语选择不是“谁功能多”，而是“谁把 membership 建模出来”。** 这里 membership 指：一个逻辑作业包含哪些 Pod、每个 Pod 属于什么角色、角色内第几个成员、成员集合何时算“齐了”、失败时以 Pod 还是以组为单位重启。K8s 原生 Job 只把 Pod 集合建模成“completions 个同构副本”；Volcano Job 建模成“具名 Task 的集合”；JobSet 建模成“具名 ReplicatedJob 的集合”；LWS 建模成“leader + workers 的组”；MPIJob 建模成“launcher + worker 两种 ReplicaSpec”。

**三类负载的判别顺序**：先问“有没有终态成功/失败”，再问“角色是否异构”，再问“是否需要稳定 rank DNS”，再问“失败是否必须整组耦合”，最后才问“队列/quota”。没有终态的是常驻服务（Deployment/StatefulSet/LWS）；有终态的是终态任务（Job/Volcano Job/JobSet/TrainJob/MPIJob）；要求“要么全起、要么全不起”的是强同步进程组（gang + collective），但 gang 只解决准入原子性，不解决集合通信的 barrier。

**LWS 的位置**：它是“组优先”的长期运行原语，介于 StatefulSet 与 Job 之间。StatefulSet 给每个 Pod 稳定序号和 PVC，但没有“组”的概念；LWS 把 `replicas × size` 个 Pod 组织成 leader/worker 组，提供组级 DNS、组级失败重启和组级滚动更新。LWS 没有完成语义，因此不适合表达“训练结束后成功退出”的作业；DisaggregatedSet 则是在 LWS 之上再做多角色（prefill/decode/encode）的服务拓扑。

**三个最容易写错的边界**：

1. **Volcano `minAvailable` 不是完成门槛**。它是调度/运行门槛；完成门槛是 `minSuccess`。`minSuccess` 允许“训练 task 成功、常驻服务 task 仍 Running”时把 Job 置为 Completed 并回收服务 Pod。
2. **JobSet 的默认成功条件是 All，不是 Any**。webhook 默认 `successPolicy.operator=All` 且覆盖全部 ReplicatedJob；显式写 `Any` 会在任一目标 Job 成功时提前把 JobSet 置为 Completed，并在后续 reconcile 删除仍在运行的子 Job。
3. **“原生 Job 没有 gang”只在默认/稳定路径成立**。本 checkout 的 K8s v1.37.2 已含 alpha 的 `.spec.scheduling`（`WorkloadWithJob`，1.36 alpha、默认关闭）；JobSet/LWS 也有 alpha 的 Workload-Aware Scheduling。不能把这些 API 写成“不存在”，应写成“默认关闭/需要 feature gate”。

### 1.1 Membership 的五个问题

把“工作负载建模”拆成五个可判定问题，比背 API 字段更有用：

| 问题 | 要看什么 | 典型字段/机制 |
|---|---|---|
| 集合边界：谁属于这个作业？ | 控制器拥有的 Pod 集合 | Job 的 selector、Volcano 的 Job/task 标签、JobSet 的 `replicatedJobs`、LWS 的 `replicas × size` |
| 角色：成员是否同构？ | 是否有多个 Pod 模板 | Volcano `tasks[].template`、JobSet `replicatedJobs[].template`、LWS `leaderTemplate/workerTemplate` |
| 身份：第几个成员？ | 稳定序号/rank 来源 | K8s `JOB_COMPLETION_INDEX`、Volcano `VC_TASK_INDEX`、JobSet hostname/index、LWS `LWS_WORKER_INDEX`、MPI hostfile |
| 就绪：集合何时算齐？ | 准入门槛与 ready 判定 | `minAvailable`、gang `minCount`、`dependsOn`、LWS `startupPolicy` |
| 完成/失败：谁宣布终态？ | 成功条件与失败动作 | Job `completions`/`successPolicy`、Volcano `minSuccess`/`policies`、JobSet `successPolicy`/`failurePolicy`、MPIJob launcher |

一个原语只要明确回答这五个问题，就能判断它是否适合；反之，字段再多但回答不了“谁是成员、谁宣布完成”，就只是 Pod 模板的语法糖。

## 2. 七维对比大表

| 维度 | K8s Job | Volcano Job | JobSet | LWS | TrainJob (v2) | MPIJob |
|---|---|---|---|---|---|---|
| **角色** | `.spec.template` 单模板；`completionMode: Indexed` 给 `JOB_COMPLETION_INDEX`，无命名角色；所有 index 同镜像/资源/卷 | `.spec.tasks[].name/template` 任意具名角色，可不同镜像/资源/命令；`VC_TASK_INDEX` 给 task 内序号；框架插件再注入 rank | `.spec.replicatedJobs[].name/template`，角色=子 Job；每角色可有独立 completions/parallelism；Pod 内无命名 rank | `leaderTemplate`/`workerTemplate` 仅两角色；`subGroupPolicy` 只把同一模板的 worker 再分组，不产生新模板 | `spec.trainer` 只覆盖 runtime 中名为 trainer 的角色；角色集合由 `ClusterTrainingRuntime.template.spec.replicatedJobs` 决定，TrainJob 本身不能新增角色 | `mpiReplicaSpecs.Launcher/Worker` 两角色，各自 `replicas/template/restartPolicy` |
| **资源** | Pod `resources`；无 per-index 资源；整卡/切分取决于设备插件资源名或 DRA，Job API 不建模 | 每 Task 模板各自的 resources；`topologyPolicy` 表达 NUMA（none/best-effort/restricted/single-numa-node）；无 GPU 切分语义 | 每 ReplicatedJob 模板各自的 resources；无跨角色聚合资源字段 | leader/worker 模板可不同资源（CPU leader + GPU worker）；`scheduling...resourceClaims`/ComputeDomain 可表达 DRA 资源域 | `trainer.numNodes`、`resourcesPerNode`、`numProcPerNode` 对全部 trainer 节点同构；`resourceClaimsPerNode` 表达 DRA；无 per-role 资源 | 每 ReplicaSpec 模板各自的 resources；`slotsPerWorker` 是 MPI slot 数，不是 K8s 资源 |
| **依赖** | 无 Pod 间启动顺序，无 Job 间依赖；默认逐 Pod 调度；alpha `.spec.scheduling.schedulingPolicy.gang` 可做 gang | `tasks[].dependsOn` 支持 Ready/any/all；`policies` 按事件/退出码执行动作；PodGroup+gang 做准入原子性 | `replicatedJobs[].dependsOn` 支持 Ready/Complete（当前只支持单个依赖项）；`startupPolicy: InOrder` 已 deprecated；无 Job 内 Pod 顺序 | `startupPolicy: LeaderCreated/LeaderReady` 控制 worker StatefulSet 何时创建；`restartPolicy` 做组级失败耦合；无任意角色 DAG | 依赖写在 runtime 的 JobSet 模板（如 initializer→trainer、node Ready→launcher）；TrainJob 无 dependsOn 字段 | `launcherCreationPolicy: AtStartup/WaitForWorkersReady`；SSH Secret + hostfile ConfigMap 做启动准备；可选 PodGroup gang |
| **就绪/完成** | Pod ready=应用 probe；完成=`.spec.completions`；`successPolicy` 仅 Indexed；`podFailurePolicy`/`backoffLimit` 控制失败 | `minAvailable` 是调度门槛；`minSuccess` 是完成门槛；`policies`+`maxRetry` 控制重启/终止；阶段机 Pending→Running→Completing→Completed/Failed | webhook 默认 `successPolicy=All`；可设 `Any`+targets；`failurePolicy` 按 reason/message/target 选择 FailJobSet/RestartJobSet/RestartJob；无 minAvailable | **无完成态**；只有 Available/Progressing/UpdateInProgress/Degraded 条件和 `readyReplicas`；训练结束需外部判定 | `Complete`/`Failed` 直接映射 JobSet 条件；`activeDeadlineSeconds` 可超时失败；无自己的 successPolicy/cleanPodPolicy | launcher Job 成功=MPIJob 成功，launcher 失败=MPIJob 失败；worker 不决定作业成败；`RunPolicy` 管 cleanPod/backoff/ttl |
| **服务暴露** | 不自建 Service；Indexed + 用户自建 headless Service + `subdomain` 才有 `<job>-<index>.<subdomain>` 稳定 DNS；无 rank0 地址/端口注入 | `svc` 插件建 headless Service（名=Job 名），Pod `hostname=pod名`、`subdomain=Job名`；注入 `VC_<TASK>_HOSTS/NUM` 并挂 `/etc/volcano`；pytorch 插件注入 `MASTER_ADDR/PORT/WORLD_SIZE/RANK` | 默认建 headless Service（名=`network.subdomain`，缺省=JobSet 名）；FQDN `<jobset>-<rj>-<jobIdx>-<podIdx>.<subdomain>`；`coordinator` 把某个 Pod 的 FQDN 写进注解 | 建 headless Service（Shared 或 UniquePerReplica）；注入 `LWS_LEADER_ADDRESS`/`LWS_GROUP_SIZE`/`LWS_WORKER_INDEX`；leader 地址 `<pod>.<subdomain>.<ns>` | 通过 JobSet 网络；Torch runtime 注入 `PET_MASTER_ADDR=<trainjob>-node-0-0.<trainjob>`、`PET_NODE_RANK`、端口 29500 | 建 headless Service（名=MPIJob），launcher/worker Pod 的 `subdomain=MPIJob`；hostfile 对 OpenMPI 写 `<name>.<job>.<ns>.svc slots=N`，对 Intel/MPICH 写 `<name>...:N`；SSH Secret 挂载 |
| **卷** | 仅 Pod template `volumes`；无 `volumeClaimTemplates`，无 per-index PVC | `spec.volumes[]` 作业级共享 PVC（可自动创建，owner=Job）；Task 模板可另加 volume；无 per-replica PVC 模板 | `volumeClaimPolicies` 建共享 PVC，命名 `<claim>-<jobset>`，支持 `Retain/Delete`；无 per-rank PVC | `volumeClaimTemplates` 每 Pod 一个 PVC（StatefulSet 语义），支持 `persistentVolumeClaimRetentionPolicy`；`/dev/shm` 由模板的 emptyDir 表达 | runtime 模板的 volumes + initializer 数据/模型卷；`runtimePatches` 可改 PodSpec volumes；TrainJob 无 volumeClaimTemplates | 每角色模板各自的 volumes；hostfile/SSH 由控制器注入；无 PVC 管理 |
| **放置** | affinity/topologySpread/nodeSelector/tolerations；默认无 gang/queue；alpha gang 可设 minCount | PodGroup `minMember`/`minTaskMember` + gang 插件；`queue`；`networkTopology` hard/soft + highest tier；`partitionPolicy` 做子分组 | `alpha.jobset.sigs.k8s.io/exclusive-topology` 做 1:1 job→拓扑域；alpha `spec.scheduling` 生成 Workload/PodGroup；无 queue | `placementPolicy: ExclusiveTopology` 做 1:1 replica→拓扑域；alpha `spec.scheduling` 做 gang；组级 exclusive 与 gang 互斥 | runtime 的 `podGroupPolicy`（coscheduling/volcano）或 alpha `scheduling`；TrainJob 无 queue 字段 | `runPolicy.schedulingPolicy.minAvailable/queue` 生成 PodGroup（Volcano 或 scheduler-plugins）；其余靠 Pod 模板 affinity |

### 2.1 表的读法：区分“字段不存在”和“语义不建模”

所有 CRD 最终都把 Pod 模板下传给 K8s，因此 `resources`、`affinity`、`volumes`、`emptyDir` 这些 PodSpec 字段在六种原语里几乎都能写；**不能把“能写 PodSpec”误读成“原语建模了这个维度”**。例如：

- LWS 的 `size` 和 `replicas` 是成员关系，`resources` 只是组内 Pod 的资源；LWS 不会因为你给 worker 多卡就自动调整 rank 或 world size。
- Volcano 的 `spec.volumes` 是**作业级共享 PVC**，不是“每个 task 一个卷”；如果你要 per-rank 本地盘，得在 task 模板里自己写 `emptyDir`/`hostPath`，或换 LWS/StatefulSet。
- JobSet 的 `volumeClaimPolicies` 是**跨 ReplicatedJob 共享 PVC**，不是 per-Job 或 per-rank PVC；它的价值是 dataset/checkpoint 共享，不是本地 scratch。
- K8s Job 的 `completions/parallelism` 是**完成计数与并发度**，不是 gang 的 `minAvailable`；`parallelism` 小只意味着少起 Pod，不意味着“少一个就不许起”。

## 3. 三类负载映射与表达能力边界

### 3.1 常驻服务：Deployment / StatefulSet / LWS

- **Deployment** 只表达“N 个可互换副本 + 滚动更新”，没有稳定身份、没有组、没有完成；适合无状态 serving，不适合任何需要 rank 的训练。
- **StatefulSet** 补上稳定序号、`serviceName` 对应的 headless DNS 和 `volumeClaimTemplates` 的每 Pod PVC，但仍没有“这些 Pod 是一个组、要一起重启”的语义。它是最接近 LWS 的原语，也是 LWS 的实现底座（leader 用一个 StatefulSet，每个 leader 再挂一个 worker StatefulSet）。
- **LWS** 把“组”提升为一等公民：`replicas` 个组、每组 `size` 个 Pod、组内 leader 序号 0、worker 序号 1..size-1；leader/worker 可以是不同模板；`startupPolicy` 控制 worker 是随 leader 创建还是等 leader Ready；`restartPolicy` 控制单 Pod 失败是否升级为整组重建。代价是它**没有终态**：没有 Completed/Failed，只有 Available/Progressing/UpdateInProgress/Degraded 等条件和 `readyReplicas`。
- **DisaggregatedSet** 是本 checkout 中角色最丰富的 LWS 上层：`roles[]` 每个 role 有名字、自己的 LWS 模板、replicas、可选的 `subRoles` 和 `slices`。它面向 prefill/decode/encode 这类多角色 serving 拓扑，不是训练作业的完成语义。

### 3.2 终态任务：Job / Volcano Job / JobSet / TrainJob / MPIJob

- **K8s Job** 是“同构副本 + 完成计数”的最小模型。`Indexed` 给出 0..completions-1 的稳定序号（annotation、label、hostname、`JOB_COMPLETION_INDEX` 四种暴露方式），但所有 index 共用同一个 Pod 模板；要不同角色，只能在命令里用 index 分支，镜像/资源/卷无法按角色不同。它也不建 Service、不注入 rank/world size、不做 Job 间依赖。
- **Volcano Job** 是单对象内角色表达力最强的一档：`tasks[]` 可任意命名（master/worker/ps/chief/launcher），每个 task 有独立模板、副本、`minAvailable`、`maxRetry`、`policies`、`dependsOn`、`partitionPolicy`；`svc`/`env`/`ssh`/`pytorch`/`mpi`/`tensorflow`/`ray` 插件在 Pod 创建时补齐 DNS、hosts、rank、SSH。它把“作业级共享卷”和“作业级 gang”也放在同一个对象里。边界是：卷是作业级共享而非 per-rank；拓扑相关只有 networkTopology/partitionPolicy 这一层，没有 LWS 那种 1:1 拓扑域独占。
- **JobSet** 把角色提升为“子 Job”：每个 `ReplicatedJob` 是一个完整 Job 模板，因此角色之间可以不同镜像/资源/命令/completions，角色内还可以有多个 Job 副本。它用 `dependsOn` 表达 Job 级 DAG，用 `successPolicy`/`failurePolicy` 表达整个集合的终态。边界是：角色是 Job 级而不是 Pod 级；Pod 内没有命名 rank（要靠 hostname/index 或上层框架）；默认不建 gang（alpha `spec.scheduling` 才建）；没有 queue/quota。
- **TrainJob** 是“薄用户 API + 厚 runtime”：`spec.runtimeRef` 指向 `ClusterTrainingRuntime`，角色、镜像默认值、依赖、成功策略都在 runtime 的 JobSet 模板里；`spec.trainer` 只覆盖 trainer 角色的镜像/命令/资源/节点数/每节点进程数；`spec.initializer` 只覆盖 runtime 里已存在的 dataset/model initializer 角色。因此 TrainJob 本身不能定义新角色，也不能给不同角色不同镜像；那是 runtime 作者的工作。它也没有 v1 的 `runPolicy`/`successPolicy` 字段。
- **MPIJob** 把角色固定为 Launcher/Worker 两种 `ReplicaSpec`，各自可有不同模板、副本、`restartPolicy`；`runLauncherAsWorker` 把 launcher 也写进 hostfile。它的成功语义是 launcher 中心的：launcher Job Complete 即 MPIJob Succeeded，launcher Job Failed 即 MPIJob Failed；控制器不直接以 worker 的 Job/Pod 条件判定 MPIJob 成败，worker 是被 launcher 通过 SSH/hostfile 驱动的进程宿主。
- **v1 legacy 补充**：training-operator main 在本 checkout 已没有 `api/kubeflow.org/v1/` 的 Go 类型；PyTorchJob/TFJob 的 `RunPolicy` 可从 Kueue vendored 的 training-operator v1.9.4 核对：`cleanPodPolicy`、`ttlSecondsAfterFinished`、`activeDeadlineSeconds`、`backoffLimit`、`schedulingPolicy`、`suspend`、`managedBy`；每个 `ReplicaSpec` 有自己的 `restartPolicy`；TFJob 另有 `successPolicy: AllWorkers`。v2 把这些职责下放给 JobSet/Job 模板。

### 3.3 强同步进程组：gang + collective

强同步训练需要同时满足四件事：**成员集合固定**（world size/rank）、**成员一起被准入**（gang）、**成员互相可达**（稳定 DNS/端口）、**失败以组为单位恢复**（集合通信不能带病继续）。这四件事没有任何一个原语全部包办：

- **gang 只是准入原子性**。Volcano 的 gang 插件在调度时检查 `ValidTaskNum() >= MinAvailable`；K8s 1.37 alpha 的 `schedulingPolicy.gang.minCount` 只在 Pod 绑定前要求整组可调度；Kueue 的 all-or-nothing 是配额准入 + `waitForPodsReady` 超时驱逐，文档明确说它是 heuristic、不阻止部分调度。它们都不保证 NCCL/MPI 的 collective 已经建好。
- **启动顺序不是 barrier**。Volcano `dependsOn` 的 Ready 判定是“Pod Running 且所有 containerStatuses.Ready”或“Pod Succeeded”；JobSet `dependsOn` 的 Ready 是子 Job 的 Ready+Succeeded+Failed 计数等于 replicas；LWS `LeaderReady` 等的是 leader 的 readiness probe。它们等到的都是 **Pod ready**，不是“训练进程已进入 rendezvous”。真正的 barrier 只能由应用自己（torchrun/c10d rendezvous、`MPI_Init`、NCCL 初始化）或外部队列/barrier 服务提供。
- **失败耦合只有 LWS 做得最彻底**：`RecreateGroupOnPodRestart` 在任一 Pod 重建/容器重启时重建整组；`RecreateGroupAfterStart` 只在全组都已启动（无 Pending）时才重建，避免启动期抖动；`None` 退化为 StatefulSet 式单 Pod 重启。Volcano 用 `policies`（如 PodEvicted→RestartJob）和 `maxRetry` 做作业级重启；JobSet 用 `failurePolicy` 做 Job 级或 JobSet 级重启；MPIJob 以 launcher 成败为准。它们都不如 LWS 的“组”语义细。
- **rank DNS 各不相同**：Volcano svc 给 `<pod>.<job>.<ns>`，pytorch 插件再把 master 地址固定为 `<job>-<master>-0.<job>`；JobSet 给 `<jobset>-<rj>-<jobIdx>-<podIdx>.<subdomain>`；LWS 的 leader 给 `<lws>-<group>.<lws>`，worker 再加一层序号，并统一注入 `LWS_LEADER_ADDRESS`；MPIJob 给 `<job>-launcher`/`<job>-worker-i`；TrainJob 的 Torch runtime 给 `PET_MASTER_ADDR`。原生 Job 只有在你手动建了 headless Service 并设置 `subdomain` 时才有等价能力。

### 3.4 每个原语“不能表达什么”

| 原语 | 主要不能表达 |
|---|---|
| K8s Job | 命名角色与每角色不同镜像/资源；Job 间依赖；默认 gang；自动 Service/rank 环境变量；per-rank PVC；训练级 readiness |
| Volcano Job | per-rank PVC/本地盘模板；每角色独立 Service；1:1 拓扑域独占；DRA 的一等建模（仍走 PodSpec）；插件行为不是 API 合约 |
| JobSet | 默认 gang；Pod 级命名 rank；per-rank PVC；queue/quota；Job 内 Pod 启动顺序；训练级 readiness |
| LWS | 终态成功/失败；超过 leader/worker 的第三角色（需 DisaggregatedSet）；任意角色 DAG；组级 exclusive 与 gang 同时使用 |
| TrainJob | 新增角色或 per-role 镜像/资源；runPolicy/successPolicy；queue/quota；直接改 Pod 模板（只能 runtimePatches） |
| MPIJob | 超过 Launcher/Worker 的角色；successPolicy；per-rank PVC；1:1 拓扑域独占；非 MPI 框架的 rank 约定 |

### 3.5 选型决策树

```text
这个负载有终态吗？
├─ 没有 → 需要稳定 rank/组语义吗？
│         ├─ 是 → LWS（leader/worker 组）或 StatefulSet（仅单 Pod 身份）
│         └─ 否 → Deployment
└─ 有 → 角色同构吗？
          ├─ 是 → K8s Job（Indexed 足够；要 gang 再加 Volcano/Kueue/WAS）
          └─ 否 → 角色边界在哪一层？
                    ├─ 同一对象内的 Pod 角色 → Volcano Job（tasks[]）
                    ├─ 子 Job 角色 + DAG → JobSet
                    ├─ 框架 runtime 固定角色 → TrainJob
                    └─ MPI launcher/worker → MPIJob
```

补两条现实约束：一是**gang 和 quota 往往来自外部层**（Volcano/Kueue/WAS），不是 workload CRD 本身；二是**完成语义必须选一个“终态所有者”**——Volcano Job 的 `minSuccess`、JobSet 的 `successPolicy`、MPIJob 的 launcher、K8s Job 的 `completions` 都在回答“谁宣布成功”，LWS 则故意不回答。

### 3.6 分层：谁负责什么

| 层 | 负责 | 不负责 |
|---|---|---|
| kube-scheduler | 单 Pod 的节点绑定、affinity/topologySpread | 成员集合是否齐、角色语义 |
| Volcano gang / K8s WAS gang | 准入时整组可调度 | 集合通信 barrier、训练 ready |
| Kueue | 队列/quota/抢占/准入；Workload 的 podSets 可命名角色 | 创建 Pod、DNS、rank、完成语义 |
| Workload controller（Job/Volcano/JobSet/LWS/TrainJob/MPIJob） | 成员集合、角色模板、完成/失败、Service/卷 | 框架内部 rendezvous、collective 健康 |
| 应用/框架（torchrun、mpirun、NCCL） | rank 分配、rendezvous、collective、checkpoint | 集群级 quota、节点放置 |

这张表解释了为什么 Kueue 可以和 JobSet/Job 这类 workload 控制器叠加：Kueue 负责“何时允许创建 Pod”，控制器负责“创建哪些 Pod、如何算完成”。但也要小心重叠——Kueue 的 all-or-nothing 与 Volcano gang 都在做“整组准入”，如果同时使用 Volcano Job 和 Kueue，需要先确认 Kueue 对该 CRD 的集成路径，并明确谁是主准入者，避免双重队列/双重 gang 语义。

### 3.7 失败恢复的粒度

| 粒度 | 典型原语/字段 | 触发条件 | 代价 |
|---|---|---|---|
| 单 Pod | StatefulSet 默认、LWS `restartPolicy: None`、MPIJob worker Pod | 容器/Pod 失败 | 其余成员继续跑，集合通信可能已经断裂 |
| 单个子 Job | JobSet `failurePolicy` 的 `RestartJob` | 目标 ReplicatedJob 的某个子 Job 失败 | 只重建该 Job，其他角色不受影响 |
| 整个进程组 | LWS `RecreateGroupOnPodRestart`/`RecreateGroupAfterStart` | 组内任一 Pod 重建/容器重启 | 组内所有成员一起重启，适合强同步训练 |
| 整个作业 | Volcano `policies`（如 PodEvicted→RestartJob）、Volcano `maxRetry` | 事件/退出码/重试耗尽 | 所有 task 一起重启，服务型 task 也被回收 |
| 整个 JobSet | JobSet `failurePolicy` 的 `RestartJobSet`、`maxRestarts` | 任一匹配规则的子 Job 失败 | 所有子 Job 重建，代价最大但语义最干净 |

选型时不要只问“失败后重不重启”，要问“重启的边界是否等于集合通信的边界”。如果 NCCL 组跨 8 个 Pod，而原语只重启 1 个 Pod，剩下 7 个进程大概率会卡在 collective 或超时；反过来，如果任务本身可以断点续训，整组重启就是浪费。

### 3.8 资源与卷的两个细节

- **GPU 切分不是 workload API 的语义**。Volcano TaskSpec、JobSet JobTemplate、LWS PodTemplate、TrainJob `resourcesPerNode` 最终都落到 Pod 的 `resources`；整卡、MIG、MPS、time-slicing 的区别由设备插件资源名（如 `nvidia.com/mig-*`）或 DRA `ResourceClaim` 决定。LWS 的 `auto-compute-domain` 是 NVIDIA DRA ComputeDomain（NVLink/NVSwitch 域），不是 GPU 切分。
- **checkpoint 卷的生死要和作业解耦**。Volcano 自动创建的 PVC owner 是 Job，Job 删除时 PVC 会被 GC；要保留 checkpoint，应使用预先存在的 `volumeClaimName`。JobSet 的 `volumeClaimPolicies` 支持 `retentionPolicy.whenDeleted: Retain`，适合跨 JobSet 复用。LWS 的 `volumeClaimTemplates` 是每 Pod 一个 PVC，适合 per-rank 本地 checkpoint；它沿用 StatefulSet 的 `persistentVolumeClaimRetentionPolicy`，`whenDeleted`/`whenScaled` 默认都是 `Retain`，要随缩容清理必须显式设 `Delete`。

## 4. 四个最小 YAML（只保留体现角色的字段）

### 4.1 Volcano Job：具名 task + 每角色资源 + minAvailable/minSuccess

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: vc-pytorch
spec:
  minAvailable: 3          # 调度门槛：3 个 Pod 必须同时可调度
  minSuccess: 3            # 完成门槛：3 个 Pod 成功才 Completed
  queue: default
  plugins:
    svc: []                # headless Service + <pod>.<job> DNS
    env: []                # VC_TASK_INDEX
    pytorch: ["--master=master", "--worker=worker", "--port=23456"]
  tasks:
  - name: master
    replicas: 1
    template:
      spec:
        containers:
        - {name: trainer, image: train:latest, resources: {limits: {nvidia.com/gpu: 8}}}
  - name: worker
    replicas: 2
    template:
      spec:
        containers:
        - {name: trainer, image: train:latest, resources: {limits: {nvidia.com/gpu: 4}}}
```

体现：`tasks[]` 是角色边界；`minAvailable` 与 `minSuccess` 是两个不同门槛；`svc`/`env`/`pytorch` 插件把 DNS、task 序号、rank/world size 注入 Pod。

### 4.2 JobSet：ReplicatedJob=角色，dependsOn + Any 成功策略

```yaml
apiVersion: jobset.x-k8s.io/v1alpha2
kind: JobSet
metadata:
  name: js-pytorch
spec:
  network: {enableDNSHostnames: true}
  successPolicy:
    operator: Any
    targetReplicatedJobs: [leader]
  replicatedJobs:
  - name: workers
    replicas: 1
    template:
      spec:
        completions: 2
        completionMode: Indexed
        template:
          spec:
            containers:
            - {name: worker, image: train:latest, resources: {limits: {nvidia.com/gpu: 8}}}
  - name: leader
    dependsOn:
    - {name: workers, status: Ready}
    template:
      spec:
        completions: 1
        template:
          spec:
            containers:
            - {name: leader, image: train:latest, command: ["python", "train.py"]}
```

体现：每个 ReplicatedJob 是独立 Job 模板（可不同镜像/资源/completions）；`dependsOn` 只保证 leader 在 workers Ready 后创建；`successPolicy Any` 让 leader 成功即整个 JobSet 完成，随后控制器删除仍在运行的 workers。

### 4.3 LWS：replicas × size，leader/worker 模板 + 组级放置

```yaml
apiVersion: leaderworkerset.x-k8s.io/v1
kind: LeaderWorkerSet
metadata:
  name: lws-pytorch
spec:
  replicas: 1
  startupPolicy: LeaderReady
  leaderWorkerTemplate:
    size: 4
    restartPolicy: RecreateGroupOnPodRestart
    leaderTemplate:
      spec:
        containers:
        - {name: leader, image: train:latest, resources: {limits: {cpu: "16"}}}
    workerTemplate:
      spec:
        containers:
        - {name: worker, image: train:latest, resources: {limits: {nvidia.com/gpu: 8}}}
  placementPolicy:
    type: ExclusiveTopology
    topology: topology.kubernetes.io/rack
```

体现：`replicas × size` 是组成员关系；leader 可以是 CPU 节点、worker 是 GPU 节点；`LeaderReady` 等 leader ready 后才建 worker StatefulSet；`ExclusiveTopology` 让整组独占一个 rack；LWS 不提供 Completed 条件。

### 4.4 TrainJob：薄 API，角色由 ClusterTrainingRuntime 决定

```yaml
apiVersion: trainer.kubeflow.org/v1alpha1
kind: TrainJob
metadata:
  name: tj-pytorch
spec:
  runtimeRef:
    apiGroup: trainer.kubeflow.org
    kind: ClusterTrainingRuntime
    name: torch-distributed
  trainer:
    numNodes: 2
    numProcPerNode: 8
    image: train:latest
    command: ["torchrun", "train.py"]
    resourcesPerNode:
      limits:
        nvidia.com/gpu: 8
```

体现：`runtimeRef` 指向的 runtime 内部是 JobSet（本 checkout 的 `torch-distributed` runtime 只有一个 `node` ReplicatedJob）；`trainer.numNodes` 改的是 trainer 角色的 Pod 数；`image/command/resourcesPerNode` 只作用于 trainer 角色；`PET_MASTER_ADDR/PET_NODE_RANK` 由 Torch 插件按 JobSet 的 index/hostname 注入。

### 4.5 四个 YAML 的对照

| 例子 | 角色表达 | 完成语义 | 稳定身份/地址 |
|---|---|---|---|
| Volcano Job | `tasks[].name/template`，任意角色 | `minSuccess` 或全 task 完成 | `svc` 插件 + pytorch 插件 `MASTER_ADDR` |
| JobSet | `replicatedJobs[].name/template`，角色=子 Job | `successPolicy`（默认 All，可 Any） | 默认 headless Service + Indexed hostname |
| LWS | `leaderTemplate`/`workerTemplate`，仅两角色 | 无 | headless Service + `LWS_LEADER_ADDRESS` |
| TrainJob | runtime 的 `replicatedJobs`，TrainJob 只改 trainer | 继承 JobSet 条件 | 继承 JobSet + `PET_MASTER_ADDR` |

## 5. 证据清单

每条给出 commit-pinned GitHub 链接与 commit 日期；行号以 `#Lx-Ly` 标注。Volcano 的 API group 是 `batch.volcano.sh`，不是 `volcano.sh`（见 register.go）。

1. **K8s Job 的 Indexed 身份**：`Indexed` 的 index 从 annotation/label/hostname/`JOB_COMPLETION_INDEX` 暴露，Pod hostname 为 `<job>-<index>`。 [`batch/v1/types.go#L420-L442`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L420-L442)、[`indexed_job_utils.go#L35`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/job/indexed_job_utils.go#L35)、[`indexed_job_utils.go#L452-L476`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/job/indexed_job_utils.go#L452-L476)、[`job_controller.go#L1916`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/controller/job/job_controller.go#L1916)（`c50e539`，2026-10-27）
2. **K8s Job 的成功/失败策略**：`successPolicy` 只对 Indexed 生效；`podFailurePolicy` 有 FailJob/Ignore/Count/FailIndex；`backoffLimit` 默认 6。 [`batch/v1/types.go#L259-L300`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L259-L300)、[`#L341-L356`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L341-L356)、[`#L123-L143`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L123-L143)（`c50e539`，2026-10-27）
3. **K8s Job 的 alpha gang**：`.spec.scheduling` 是 alpha，`WorkloadWithJob` 1.36 引入、默认 false；`JobSchedulingConfiguration` 含 schedulingPolicy/schedulingConstraints/disruptionMode。 [`batch/v1/types.go#L484-L530`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/batch/v1/types.go#L484-L530)、[`kube_features.go#L2308-L2310`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L2308-L2310)（`c50e539`，2026-10-27）
4. **StatefulSet 与 Deployment 的边界**：StatefulSet 有 `serviceName`、`podManagementPolicy`、`volumeClaimTemplates`，PVC 的 `whenDeleted`/`whenScaled` 默认都是 `Retain`；Deployment 只有 `replicas`/selector/template。 [`apps/v1/types.go#L148-L190`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/apps/v1/types.go#L148-L190)、[`#L200-L262`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/apps/v1/types.go#L200-L262)、[`#L416-L420`](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/apps/v1/types.go#L416-L420)（`c50e539`，2026-10-27）
5. **Volcano Job API group 与字段**：group 是 `batch.volcano.sh`；JobSpec 含 `minAvailable`、`minSuccess`、`maxRetry`、`queue`、`tasks`、`policies`、`volumes`；TaskSpec 含 `replicas`、`minAvailable`、`template`、`dependsOn`、`partitionPolicy`。 [`register.go#L32-L36`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/register.go#L32-L36)、[`job.go#L55-L122`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L55-L122)、[`job.go#L239-L282`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L239-L282)（`2006640`，2026-11-23）
6. **Volcano 的阶段机与生命周期策略**：阶段含 Pending/Running/Completing/Completed/Failed/Aborted/Terminated/Restarting；`LifecyclePolicy` 按 event/exitCode/timeout 执行动作。 [`job.go#L307-L329`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L307-L329)、[`job.go#L199-L225`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L199-L225)、[`mutate_job.go#L161-L183`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/webhooks/admission/jobs/mutate/mutate_job.go#L161-L183)（`2006640`，2026-11-23）
7. **Volcano 的 minSuccess 完成语义**：`Succeeded >= minSuccess` 直接置 Completed；全部 task 结束后再按 `minAvailable`、task `minAvailable`、`minSuccess` 判 Completed/Failed。 [`running.go#L62-L104`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/state/running.go#L62-L104)、[`minsuccess.md#L1-L30`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/docs/design/minsuccess.md#L1-L30)（`2006640`，2026-11-23）
8. **Volcano dependsOn 的 Ready 判定**：依赖 task 的 Pod 必须 Running 且所有 container Ready，或 Succeeded，并达到依赖 task 的 `minAvailable`；`Iteration=any/all`。 [`job_controller_actions.go#L682-L760`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/job_controller_actions.go#L682-L760)、[`job.go#L464-L475`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/batch/v1alpha1/job.go#L464-L475)（`2006640`，2026-11-23）
9. **Volcano PodGroup 与 gang**：PodGroup 有 `minMember`/`minTaskMember`/`queue`/`priorityClassName`/`minResources`；控制器把 task minAvailable 写入 `minTaskMember`；gang 插件要求 `ValidTaskNum() >= MinAvailable`。 [`scheduling/v1beta1/types.go#L174-L212`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/staging/src/volcano.sh/apis/pkg/apis/scheduling/v1beta1/types.go#L174-L212)、[`job_controller_actions.go#L850-L900`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/job_controller_actions.go#L850-L900)、[`gang.go#L58-L85`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/scheduler/plugins/gang/gang.go#L58-L85)（`2006640`，2026-11-23）
10. **Volcano svc 插件**：Pod `hostname=pod.Name`、`subdomain=job.Name`；headless Service 名=Job 名、selector 为 job-name/job-namespace；ConfigMap 提供 `<task>.host`，env 为 `VC_<TASK>_HOSTS/NUM`，挂载 `/etc/volcano`。 [`svc.go#L80-L95`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/svc/svc.go#L80-L95)、[`svc.go#L228-L245`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/svc/svc.go#L228-L245)、[`svc.go#L310-L345`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/svc/svc.go#L310-L345)、[`const.go#L21-L29`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/svc/const.go#L21-L29)（`2006640`，2026-11-23）
11. **Volcano pytorch/env 插件的 rank**：pytorch 插件 `MASTER_ADDR` 指向 `<job>-<master>-0.<job>`，并注入 `MASTER_PORT/WORLD_SIZE/RANK`；env 插件注入 `VK_TASK_INDEX`/`VC_TASK_INDEX`。 [`pytorch.go#L56-L64`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/distributed-framework/pytorch/pytorch.go#L56-L64)、[`pytorch.go#L293-L307`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/distributed-framework/pytorch/pytorch.go#L293-L307)、[`env.go#L45-L56`](https://github.com/volcano-sh/volcano/blob/2006640ed881e632119eedb9d3fac82819402301/pkg/controllers/job/plugins/env/env.go#L45-L56)（`2006640`，2026-11-23）
12. **JobSet 的 spec 与角色/网络/成功/失败/协调者/卷**：`replicatedJobs`、`network`、`successPolicy`、`failurePolicy`、`coordinator`、`volumeClaimPolicies` 都是一等字段；`DependsOn` 的 status 只有 Ready/Complete。 [`jobset_types.go#L123-L164`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L123-L164)、[`#L218`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L218)、[`#L369-L403`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L369-L403)、[`#L428-L444`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L428-L444)、[`#L573-L582`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L573-L582)、[`#L525-L544`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L525-L544)、[`#L608-L618`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L608-L618)、[`#L756-L773`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/api/jobset/v1alpha2/jobset_types.go#L756-L773)（`32c9ea3`，2026-11-18）
13. **JobSet 默认值**：webhook 默认 `successPolicy=All`、每个 ReplicatedJob 的 `completionMode=Indexed`、`restartPolicy=OnFailure`、`network.enableDNSHostnames=true`、`publishNotReadyAddresses=true`。 [`jobset_webhook.go#L112-L142`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/webhooks/jobset_webhook.go#L112-L142)（`32c9ea3`，2026-11-18）
14. **JobSet 成功/失败语义**：`numJobsExpectedToSucceed` 对 Any 返回 1、对 All 返回目标 ReplicatedJob 的 replicas 总和；默认无 FailurePolicy 时任一子 Job 失败即 JobSet Failed，有规则则按 reason/message 匹配后执行动作。 [`success_policy.go#L51-L64`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/success_policy.go#L51-L64)、[`jobset_controller.go#L1205-L1210`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/jobset_controller.go#L1205-L1210)、[`failure_policy.go#L49-L70`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/failure_policy.go#L49-L70)（`32c9ea3`，2026-11-18）
15. **JobSet 完成后的清理**：JobSet 一旦 Completed/Failed，会删除仍在运行的子 Job；`successPolicy Any` 的提前完成也会触发这条路径。 [`jobset_controller.go#L180-L190`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/jobset_controller.go#L180-L190)（`32c9ea3`，2026-11-18）
16. **JobSet 的 dependsOn 与 DNS**：`dependencyReachedStatus` 对 Complete 要求 Succeeded==replicas，对 Ready 要求 Ready+Succeeded+Failed==replicas；headless Service 名=`subdomain`，Job Pod `subdomain=GetSubdomain`；`CoordinatorEndpoint` 生成 `<jobset>-<rj>-<jobIdx>-<podIdx>.<subdomain>`。 [`depends_on.go#L9-L29`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/depends_on.go#L9-L29)、[`jobset_controller.go#L1069-L1100`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/jobset_controller.go#L1069-L1100)、[`#L1250`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/jobset_controller.go#L1250)、[`#L1692-L1694`](https://github.com/kubernetes-sigs/jobset/blob/32c9ea3144095df1fbc778433505c35a53e5acfe/pkg/controllers/jobset_controller.go#L1692-L1694)（`32c9ea3`，2026-11-18）
17. **LWS 的组模型与两角色**：`replicas` 是组数，`size` 是组内 Pod 数；leader 序号 0、worker 1..size-1；`leaderTemplate` 与 `workerTemplate` 可不同；`volumeClaimTemplates` 每 Pod 一个 PVC。 [`leaderworkerset_types.go#L195-L238`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L195-L238)、[`#L428-L490`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L428-L490)（`51d7d5a`，2026-11-23）
18. **LWS 的启动/重启/子组/网络/放置**：`startupPolicy` 有 LeaderCreated/LeaderReady；`restartPolicy` 有 RecreateGroupOnPodRestart/RecreateGroupAfterStart/None；`subGroupPolicy` 只分组不改模板；`networkConfig.subdomainPolicy` 有 Shared/UniquePerReplica；`placementPolicy` 有 ExclusiveTopology，且组级 exclusive 不能与 gang 同用。 [`#L719-L757`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L719-L757)、[`#L533-L568`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L533-L568)、[`#L624-L650`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L624-L650)、[`#L575-L621`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L575-L621)、[`topology-placement#L40`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/site/content/en/docs/concepts/leaderworkerset/topology-placement/_index.md#L40)（`51d7d5a`，2026-11-23）
19. **LWS 的 leader 地址与组环境变量**：`AddLWSVariables` 注入 `LWS_LEADER_ADDRESS`、`LWS_GROUP_SIZE`、`LWS_WORKER_INDEX`；leader 地址由 `hostname.subdomain.namespace` 组成；headless Service 的 `ClusterIP=None` 且 `publishNotReadyAddresses=true`。 [`pod_utils.go#L163-L192`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/pkg/utils/pod/pod_utils.go#L163-L192)、[`pod_controller.go#L422`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/pkg/controllers/pod_controller.go#L422)、[`controller_utils.go#L36-L60`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/pkg/utils/controller/controller_utils.go#L36-L60)（`51d7d5a`，2026-11-23）
20. **LWS 没有完成态**：条件只有 Available/Progressing/UpdateInProgress/Degraded/WorkloadSchedulingCreated，状态用 `readyReplicas/updatedReplicas/replicas`，没有 Completed/Failed。 [`leaderworkerset_types.go#L791-L818`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/leaderworkerset/v1/leaderworkerset_types.go#L791-L818)（`51d7d5a`，2026-11-23）
21. **DisaggregatedSet 的多角色**：`spec.roles[]` 每个 role 有 name、subRoles、scaling、内嵌的 LWS 模板；`slices` 是整套角色拓扑的副本数。 [`disaggregatedset_types.go#L226-L273`](https://github.com/kubernetes-sigs/lws/blob/51d7d5ad84f7badeee1466e4a7b846cacfdbc961/api/disaggregatedset/v1/disaggregatedset_types.go#L226-L273)（`51d7d5a`，2026-11-23）
22. **TrainJob 的薄 API**：`runtimeRef` + `initializer` + `trainer` + `runtimePatches`；`trainer` 只有 image/command/args/env/numNodes/resourcesPerNode/resourceClaimsPerNode/numProcPerNode；没有 runPolicy/successPolicy。 [`trainjob_types.go#L102-L152`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/apis/trainer/v1alpha1/trainjob_types.go#L102-L152)、[`#L247-L306`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/apis/trainer/v1alpha1/trainjob_types.go#L247-L306)（`ae27d3f`，2026-11-21）
23. **TrainJob 的 Torch rank/端口**：`PET_NNODES`、`PET_NPROC_PER_NODE`、`PET_NODE_RANK`（取 job-completion-index）、`PET_MASTER_ADDR=<trainjob>-node-0-0.<trainjob>`、`PET_MASTER_PORT=29500`。 [`torch.go#L136-L230`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/runtime/framework/plugins/torch/torch.go#L136-L230)、[`constants.go#L71-L72`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/constants/constants.go#L71-L72)、[`constants.go#L222-L232`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/constants/constants.go#L222-L232)（`ae27d3f`，2026-11-21）
24. **TrainJob 把状态映射到 JobSet**：TrainJob 的 `Complete`/`Failed` 条件直接来自 JobSet 的 `JobSetCompleted`/`JobSetFailed`；`TrainingRuntimeSpec.Template` 就是 JobSet 模板。 [`jobset.go#L635-L655`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/runtime/framework/plugins/jobset/jobset.go#L635-L655)、[`trainingruntime_types.go#L114-L137`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/pkg/apis/trainer/v1alpha1/trainingruntime_types.go#L114-L137)（`ae27d3f`，2026-11-21）
25. **TrainJob 的 MPI runtime 角色**：官方迁移文档的 MPI runtime 用 `replicatedJobs: node + launcher`，`launcher` 依赖 `node` 的 `Ready`，`successPolicy: All` 只针对 `launcher`。 [`migration.md#L140-L190`](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/operator-guides/migration.md#L140-L190)（`ae27d3f`，2026-11-21）
26. **v1 legacy RunPolicy**：training-operator v1.9.4（Kueue vendor）`RunPolicy` 有 cleanPodPolicy/ttlSecondsAfterFinished/activeDeadlineSeconds/backoffLimit/schedulingPolicy/suspend/managedBy；ReplicaSpec 有独立 restartPolicy；TFJob 有 `successPolicy: AllWorkers`。 [`common_types.go#L194-L239`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/vendor/github.com/kubeflow/training-operator/pkg/apis/kubeflow.org/v1/common_types.go#L194-L239)、[`tensorflow_types.go#L69-L99`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/vendor/github.com/kubeflow/training-operator/pkg/apis/kubeflow.org/v1/tensorflow_types.go#L69-L99)、[`go.mod#L15`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/go.mod#L15)（`be7dc9d`，2026-11-23）
27. **MPIJob 的 Launcher/Worker 与 RunPolicy**：`mpiReplicaSpecs` 的 key 只有 Launcher/Worker；每角色有 replicas/template/restartPolicy；RunPolicy 有 cleanPodPolicy/ttl/activeDeadlineSeconds/backoffLimit/schedulingPolicy/suspend。 [`types.go#L104-L130`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L104-L130)、[`#L168-L198`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L168-L198)、[`#L207-L214`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L207-L214)、[`#L348-L361`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L348-L361)（`a057ca5`，2026-11-21）
28. **MPIJob 的 launcher 中心成功语义**：launcher Job 结束即 MPIJob 结束；launcher Succeeded 时 MPIJob Succeeded，launcher Failed 时 MPIJob Failed。 [`mpi_job_controller.go#L649-L650`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L649-L650)、[`#L1121-L1130`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1121-L1130)（`a057ca5`，2026-11-21）
29. **MPIJob 的 headless Service 与 hostfile**：Service 名=MPIJob、`ClusterIP=None`；hostfile 对 OpenMPI 写 `<name>.<job>.<ns>.svc[.clusterDomain] slots=N`，对 Intel/MPICH 写 `<name>...:N`；worker 名为 `<job>-worker-<i>`、launcher 为 `<job>-launcher`；Pod `subdomain=MPIJob`。 [`mpi_job_controller.go#L1337-L1361`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1337-L1361)、[`#L1418-L1437`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1418-L1437)、[`#L1513`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1513)、[`#L1608`](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1608)（`a057ca5`，2026-11-21）
30. **Kueue 的边界**：Workload 是准入单位，`podSets` 可命名角色但只是资源/模板描述，`queueName` 指向 LocalQueue；all-or-nothing 由配额准入、TAS、waitForPodsReady 组合，文档明确说 waitForPodsReady 是 heuristic。 [`workload_types.go#L28-L52`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/workload_types.go#L28-L52)、[`#L631-L656`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/apis/kueue/v1beta2/workload_types.go#L631-L656)、[`all_or_nothing.md#L14-L66`](https://github.com/kubernetes-sigs/kueue/blob/be7dc9d31470258dd324e5bd6d84f7eaf90f5f69/site/content/en/docs/concepts/all_or_nothing.md#L14-L66)（`be7dc9d`，2026-11-23）

### 5.1 官方文档交叉核对（非 commit-pinned）

- Kubernetes Job 文档：Indexed 的四种 index 暴露方式、`successPolicy` 仅 Indexed、`podFailurePolicy`、`backoffLimit` 默认值：<https://kubernetes.io/docs/concepts/workloads/controllers/job/>；Pod 间通信与 headless Service：<https://kubernetes.io/docs/tasks/job/job-with-pod-to-pod-communication/>。
- Volcano 文档：`svc` 插件的 headless Service/`VC_%s_HOSTS`、`minSuccess` 的“服务 task 仍 Running 也可完成”语义：`docs/user-guide/how_to_use_svc_plugin.md`、`docs/design/minsuccess.md`（仓库内，已在上方代码链接旁引用）。
- JobSet 文档：DNS 的 FQDN 格式、VolumeClaimPolicies 的共享 PVC/Retention、FailurePolicy 的默认 `RestartJobSet`：<https://jobset.sigs.k8s.io/docs/concepts/>、<https://jobset.sigs.k8s.io/docs/tasks/volume_claim_policies/>、<https://jobset.sigs.k8s.io/docs/tasks/failure_policy/>。
- LWS 文档：`LeaderReady` 等待 readiness probe、`RecreateGroupOnPodRestart`/`RecreateGroupAfterStart`/`None` 的差异、`ExclusiveTopology` 的 1:1 语义：<https://lws.sigs.k8s.io/docs/concepts/leaderworkerset/startup-policy/>、<https://lws.sigs.k8s.io/docs/concepts/leaderworkerset/failure-handling/>、<https://lws.sigs.k8s.io/docs/concepts/leaderworkerset/topology-placement/>。
- Kubeflow Trainer 文档：v1→v2 迁移、MPI runtime 的 node+launcher/successPolicy：<https://trainer.kubeflow.org/en/latest/operator-guides/migration.html>。

## 6. 不确定 / 需复核

1. **K8s alpha gang 的门槛**：本文按 checkout 的 v1.37.2 代码写 `WorkloadWithJob` 为 1.36 alpha、默认 false；官方文档页面已出现 `scheduling` 与 gang 示例，但不同发行版的 feature gate/`--runtime-config` 可能不同，落地前需按目标集群核对。
2. **JobSet/LWS 的 Workload-Aware Scheduling**：两者都依赖 `scheduling.k8s.io` 的 Workload/PodGroup API 和各自的 feature gate；JobSet 文档明确要求 K8s 1.37+，LWS 的具体版本要求见其 installation。本文只确认了 API 与代码路径，未启动集群验证 alpha 行为。
3. **training-operator v1 的字段级证据**：upstream main 已删除 `kubeflow.org/v1` Go 类型；本文的 v1 `RunPolicy` 来自 Kueue vendored 的 v1.9.4，不是 upstream main。若要引用 v1 的默认值与控制器行为，应另取 training-operator `release-1.9` 分支核对。
4. **TFJob `successPolicy: AllWorkers` 的控制器语义**：本文只核对了 API 常量（Default/AllWorkers），未逐行跟踪 v1 TFJob 控制器如何用它判定成功，需复核。
5. **LWS `Available` 的“最小可用组”如何计算**：本文只确认了条件类型与 `readyReplicas`，没有完整追踪 `Available` 的判定函数；不要把它当成 `minAvailable` 字段。
6. **MPIJob 的 worker 失败语义**：本文确认了“launcher 成功/失败决定 MPIJob 成败”，但未完整追踪 worker Pod 失败后控制器是否重建、以及 `CleanPodPolicy` 对 worker 的具体清理路径。
7. **GPU 整卡 vs 切分**：本文只确认所有 workload API 最终都把资源下传给 Pod `resources`；MIG/MPS/time-slicing 的具体行为取决于设备插件/DRA 驱动版本，未在这 7 个仓库内逐一核对。
8. **Volcano `svc` 的 `publishNotReadyAddresses` 默认 false**：如果 master 的 readiness 又依赖 worker，可能出现 DNS 解析死锁；本文只引了默认值，没有构造实验验证这一组合。
