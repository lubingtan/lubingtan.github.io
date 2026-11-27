# Wiki Index

## Distributed Systems

- [Apache Mesos](./Distributed_Systems/mesos.md) — 分布式系统内核：两级调度、DRF 分配器、Offer 资源供应、框架化多租户、与 Slurm/Kueue 对比

## Cloud Native

### Kubernetes

#### Fundamentals

- [Kubernetes 概念](./Cloud_Native/Kubernetes/Fundamentals/1_kubernetes概念.md) — Kubernetes 是什么、为什么需要它，以及容器部署的发展历史
- [K8s 工作负载](./Cloud_Native/Kubernetes/Fundamentals/1-1_k8s工作负载.md) — Pod 的概念、原理及工作负载资源类型
- [RBAC](./Cloud_Native/Kubernetes/Fundamentals/rbac.md) — 基于角色的访问控制：用户创建、证书签名请求、权限绑定

#### Control Plane

- [kube-apiserver：原理、生产故障与参数调优](./Cloud_Native/Kubernetes/Control_Plane/2_kubernetes-api-server.md) — 三层 server 与请求链路、写入/读取路径与 watch cache（1.37 B-tree/快照/RangeStream）、12 类生产故障模式、apiserver 与 etcd 参数调优、1.33–1.37 重要特性（WatchList、VAP/MAP、混合版本代理等）
- [API Priority and Fairness：FlowSchema 与 PriorityLevelConfiguration](./Cloud_Native/Kubernetes/Control_Plane/flowschema.md) — APF 的请求分类与并发隔离：FlowSchema 规则与匹配优先级、PriorityLevelConfiguration 的份额/队列/借还、内置 mandatory 与 suggested 策略、自定义与调参方法
- [Kubernetes 控制面高可用方案](./Cloud_Native/Kubernetes/Control_Plane/控制面高可用方案.md) — 控制面三个独立的 HA 问题（apiserver 无状态多副本 / etcd quorum / 选主组件）、stacked/external/托管拓扑对比、VIP/LB 入口与健康检查、Lease 选主与 15–17s 切换、失效域矩阵（含全控制面 down 时的数据面行为）、APF 与滚动升级
- [Kubernetes 控制面灾备与恢复](./Cloud_Native/Kubernetes/Control_Plane/控制面灾备与恢复.md) — RPO/RTO 与 11 类保护对象、etcd 快照/多成员 restore、quorum 丢失双路径（restore vs --force-new-cluster）、全集群重建与 Cluster API pivot、Velero 边界、多集群 DR 与恢复演练
- [Kubernetes 控制面事故处理手册](./Cloud_Native/Kubernetes/Control_Plane/控制面事故处理手册.md) — 事故分级与处理原则、SLO/指标/告警基线、症状→层决策树、13 个分场景 runbook（etcd/证书/webhook/APF/选主/磁盘/误删/升级/apiserver 延迟升高）、事故流程与复盘
- [大规模多集群 K8s 版本升级](./Cloud_Native/Kubernetes/Control_Plane/大规模多集群版本升级.md) — 多集群升级规划：支持窗口/版本 skew/API 生命周期、依赖兼容矩阵、波次与门禁、kubeadm/CAPI/托管集群执行顺序、常见故障处理与回滚边界

#### Node Runtime

- [Kubelet 原理](./Cloud_Native/Kubernetes/Node_Runtime/kubelet原理.md) — kubelet 创建 Pod 的完整流程：syncLoop、PLEG、容器运行时
- [PLEG](./Cloud_Native/Kubernetes/Node_Runtime/k8s之pleg.md) — Pod Lifecycle Event Generator 的原理与僵尸进程排查
- [容器运行时全链路：OCI、CRI、containerd、shim 与 RuntimeClass](./Cloud_Native/Kubernetes/Node_Runtime/容器运行时.md) — 从 kubelet 到容器进程：五个概念的边界、代码级调用链、shim 生命周期与 RuntimeClass handler 解析

#### Scheduling

- [kube-scheduler 源码分析](./Cloud_Native/Kubernetes/Scheduling/4_kube-scheduler源码分析.md) — scheduler 的工作流程、配置初始化与调度算法源码解读
- [Kueue](./Cloud_Native/Kubernetes/Scheduling/kueue.md) — Kubernetes 原生作业队列管理器：配额管理、公平共享、抢占与多集群调度

#### Networking

- [Kubernetes 网络全链路：Pod、Service、LoadBalancer 与 DNS](./Cloud_Native/Kubernetes/Networking/k8s-network-path.md) — 四张地址表与五层数据面、L2/L3/L4/L7 与 overlay/underlay 术语、Pod→Pod/Service/外部入口/DNS/egress 的完整路径、iptables/IPVS/nftables/eBPF 差异、抓包证据地图与分层排障决策树
- [Service、kube-proxy 与 LoadBalancer](./Cloud_Native/Kubernetes/Networking/6_service相关.md) — Service 语义与默认值、EndpointSlice/readiness、kube-proxy 三种模式的链布局与规则生成、conntrack、ETP/ITP/拓扑、MetalLB L2/BGP、Ingress/Gateway API
- [CNI 详解：从 kubelet 到 veth、bridge 与 overlay](./Cloud_Native/Kubernetes/Networking/cni详解.md) — CNI 规范与调用链、运行时库 vs 插件二进制 vs 完整方案、配置组合/meta/main-IPAM 三层定制与自定义插件骨架、接口拓扑/封装/路由/数据面的分类轴、containerd 创建 netns/pause、bridge/host-local/portmap/bandwidth、ptp/ipvlan/macvlan、PodCIDR 与路由、overlay MTU、IPAM、NAT 与 NetworkPolicy 数据面、kind 多 CNI 实验（kindnet/flannel/Calico/Cilium）
- [多集群网络互联：发现、访问、成员地址与 NAT 穿透](./Cloud_Native/Kubernetes/Networking/multicluster-networking.md) — 四种连通模型、成员集群/成员地址、地址冲突与 Globalnet、MCS-API、Submariner 隧道与端口、Cilium ClusterMesh、跨集群 DNS 与排障

#### Extensibility

- [client-go List/Watch 原理](./Cloud_Native/Kubernetes/Extensibility/client-go-list-watch.md) — 从 resourceVersion/410/bookmark 语义、watch cache 与 etcd watch，到 Reflector、DeltaFIFO、SharedInformer 与自定义 watch 的完整链路
- [生产级 Kubernetes Operator](./Cloud_Native/Kubernetes/Extensibility/production-operator.md) — 从 CRD/schema/CEL/版本转换、API Server 请求路径、List/Watch 与 Informer/Workqueue，到 spec/status 与 conditions 设计、Reconcile 收敛、幂等与外部副作用、OwnerRef/Finalizer 清理、并发分片、CRD/控制器/OLM 升级的完整生产指南

### AI Infrastructure

#### Agents

- [Agent Substrate](./Cloud_Native/AI_Infrastructure/Agents/agent-substrate.md) — CNCF 高密度 Agent 沙箱 Runtime（v1.0.0）：Actor/Worker 多路复用、VOLUMES/ROOTFS/MEMORY 快照、PostgreSQL+OpenFGA 控制面、SPIFFE 身份与 egress 网关
- [Agent Sandbox](./Cloud_Native/AI_Infrastructure/Agents/agent-sandbox.md) — K8s 原生沙箱执行环境：WarmPool 预热池、SandboxClaim 生命周期、7 层安全隔离、Router 请求路由与认证
- [kagent](./Cloud_Native/AI_Infrastructure/Agents/kagent.md) — CNCF K8s 原生 AI Agent 框架：声明式 CRD、Agent Controller、A2A Handler Mux、MCP 工具生态、ADK Runtime

#### Frameworks

- [Cordis](./Cloud_Native/AI_Infrastructure/Frameworks/cordis.md) — 时空可组合性元框架：可逆副作用（effect）+ 响应式依赖（coeffect）、Fiber 生命周期状态机、声明式 Loader、HMR；DeepSeek Harness 的插件内核
- [Cordis Hello World](./Cloud_Native/AI_Infrastructure/Frameworks/cordis-hello-world.md) — ~70 行可运行 demo：effect/inject/provide 的「上手即跑」演示（服务消失/恢复自动停用/复活、LIFO 回收、箭头函数插件踩坑）

#### Accelerators

- [HAMi](./Cloud_Native/AI_Infrastructure/Accelerators/hami.md) — CNCF 异构 AI 算力虚拟化与调度：extender 选点、设备级策略链、14 家加速器后端、与 MIG/MPS/GPU Operator 的边界
- [HAMi-core](./Cloud_Native/AI_Infrastructure/Accelerators/hami-core.md) — 容器内 CUDA 劫持实现：ld.so.preload / dlsym / cuGetProcAddress 三路接管、显存账本、算力令牌桶

#### Distributed Training

- [云原生分布式训练：编排与稳定性专题](./Cloud_Native/AI_Infrastructure/Distributed_Training/overview.md) — 三层 membership（编排/框架/通信）总纲：角色建模、故障自愈、Checkpoint 与 RL 接入的统一框架
- [工作负载建模：从 Pod 到可恢复的成员组](./Cloud_Native/AI_Infrastructure/Distributed_Training/workload-modeling.md) — 七维建模（角色/资源/依赖/就绪完成/服务暴露/卷/放置）、Volcano Job/JobSet/LWS/TrainJob/MPIJob 对比与选择树
- [训练失败与自愈：首发原因、恢复单元与失败预算](./Cloud_Native/AI_Infrastructure/Distributed_Training/failure-self-healing.md) — 启动/join/hang/单 rank 退出/节点/设备故障分层、首发归因、各编排器恢复语义、预算模型与诊断 runbook
- [Checkpoint 与抢占恢复：状态、恢复点与成员重建](./Cloud_Native/AI_Infrastructure/Distributed_Training/checkpoint-preemption.md) — DCP/FSDP/torchtitan 的状态与原子性、进度损失公式、跨拓扑恢复、加载验证与 SIGTERM/抢占 runbook
- [RL 后训练与业务接入：阶段、版本与失败域](./Cloud_Native/AI_Infrastructure/Distributed_Training/rl-post-training.md) — actor/rollout/reward/eval/weight sync 的阶段图、verl 结构、staleness、失败域与平台能力沉淀决策表

### Cluster Lifecycle

- [Cluster API](./Cloud_Native/Cluster_Lifecycle/cluster-api.md) — 声明式集群生命周期管理：provider 契约、资源层级、集群创建流程、自定义 provider 示例

### Platform Engineering

- [DevOps 理念与实践：从 CI/CD 到平台工程](./Cloud_Native/Platform_Engineering/devops-thinking.md) — 基础篇：Three Ways、Pipeline as Code、可复用构建块、一次构建多次部署、效率/可靠性指标、可复现环境与平台工程演进
- [Agent 时代的 DevOps：从交付流水线到交付系统](./Cloud_Native/Platform_Engineering/agent-era-devops.md) — AI 作为放大器、验证税与瓶颈迁移、人机双模平台、五面一核架构、成熟度模型与四层度量
- [平台工程：把工程能力变成可复用的产品](./Cloud_Native/Platform_Engineering/platform-as-a-product.md) — 平台即产品、TVP、能力契约、黄金路径、AI 能力平台化、Agent-ready 接口与反模式
- [CI/CD 与自动化质量保障](./Cloud_Native/Platform_Engineering/ci-cd-quality-gates.md) — 一次构建多次部署、供应链证据链、测试分层、LLM eval、风险分级门禁、发布回滚与 agentic CI
- [环境即服务：云原生资源自助交付与治理](./Cloud_Native/Platform_Engineering/environment-as-a-service.md) — 环境分类、隔离模型、自助交付流水线、环境契约、TTL 回收、配额成本、容量与故障模式
- [可观测性与稳定性：从监控到可运营系统](./Cloud_Native/Platform_Engineering/observability-and-sre.md) — OTel 信号模型、GenAI/agent 可观测性、SLO 错误预算、性能容量、事故管理、权限审计与恢复
- [平台落地：协作、规范与效果评估](./Cloud_Native/Platform_Engineering/platform-adoption.md) — 团队拓扑、责任边界、规范生命周期、工具选型、AI 治理、DORA/DX 度量与四阶段路线图

### Linux Container

- [容器知识备忘录](./Cloud_Native/Linux_Container/容器知识备忘录.md) — Linux Namespace、Cgroups、UnionFS 等容器核心技术总结
- [OverlayFS 与镜像层：从联合挂载到 OCI 分层](./Cloud_Native/Linux_Container/OverlayFS与镜像层.md) — overlayfs 四要素/copy-up/whiteout 内核语义、OCI layer 的 tar changeset 与 diffID、containerd content store 与 unpack 全链路
- [镜像快照器（Snapshotter）：containerd 如何把层变成 rootfs](./Cloud_Native/Linux_Container/镜像快照器snapshotter.md) — Active/Committed/View 三态、overlay 驱动 lowerdir 组装、chainID 与 GC、内置驱动对比
- [镜像懒加载：stargz、Nydus、SOCI 与 OverlayBD](./Cloud_Native/Linux_Container/镜像懒加载.md) — remote snapshotter 协议、eStargz TOC/footer、RAFS、SOCI index、OverlayBD 块设备，以及选型与排障

### Virtualization

- [沙箱与虚拟化技术全景：KVM、QEMU、Firecracker、Kata、gVisor](./Cloud_Native/Virtualization/沙箱与虚拟化技术全景.md) — 三种隔离边界（共享内核/用户态内核/硬件虚拟化）、KVM→VMM→运行时分层、五技术对比矩阵、选型决策树，以及可运行的 KVM 最小 VMM 实验

## Machine Learning

### High Performance Computing

- [ompi架构介绍](./Machine_Learning/High_Performance_Computing/ompi架构介绍.md) — Open MPI 架构介绍
- [Slurm](./Machine_Learning/High_Performance_Computing/slurm.md) — HPC 集群工作负载管理器：job/step 概念、job 生命周期、多因子优先级、保守回填、cons_tres 选择、抢占算法
- [GPU 算力/显存池化：从 CUDA 单卡视角到跨节点透明调度](./Machine_Learning/High_Performance_Computing/gpu-cluster-pooling.md) — 六类「应用视角单卡」方案（UVM/VMM、MNNVL+IMEX+fabric memory、API remoting、显存池化/CXL、库内并行、编排层）、透明性光谱、横向对比矩阵与选型决策树

### Distributed Training

- [训练启动与通信：rank、rendezvous 与第一个 collective](./Machine_Learning/Distributed_Training/startup-communication.md) — torchrun/TF_CONFIG/MPI 的角色与成员组织、rank/world size 来源、NCCL 初始化与首个 step 的失败窗口

### Inference

- [Model Mesh Serving](./Machine_Learning/Inference/Model%20Mesh%20Serving:%20一种可以大规模部署ML模型的解决方案.md) — 大规模 ML 模型部署方案：ModelMesh 的原理与架构
- [vLLM Production Stack 实战](./Machine_Learning/Inference/vLLM%20Production%20Stack实战.md) — vLLM 生产环境搭建实战：硬件准备、LWS 部署、benchmark

## Operation

### Development Environment

- [Docker 环境配置](./Operation/Development_Environment/Docker环境配置.md) — Docker 在 Ubuntu/WSL 中的安装与镜像加速配置
- [Windows 开发环境配置](./Operation/Development_Environment/WIndows开发环境配置.md) — WSL 安装、版本切换与 Windows 开发环境搭建

### Linux

- [Bash 及命令行工具技巧集合](./Operation/Linux/Bash以及命令行工具技巧集合.md) — 网络诊断、磁盘管理、Bash 脚本等实用命令行技巧
