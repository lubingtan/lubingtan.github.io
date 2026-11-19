# Wiki Index

## Distributed Systems

- [Apache Mesos](./Distributed_Systems/mesos.md) — 分布式系统内核：两级调度、DRF 分配器、Offer 资源供应、框架化多租户、与 Slurm/Kueue 对比

## Cloud Native

### Kubernetes

- [Kubernetes 概念](./Cloud_Native/Kubernetes/1_kubernetes概念.md) — Kubernetes 是什么、为什么需要它，以及容器部署的发展历史
- [K8s 工作负载](./Cloud_Native/Kubernetes/1-1_k8s工作负载.md) — Pod 的概念、原理及工作负载资源类型
- [Kubernetes API Server](./Cloud_Native/Kubernetes/2_kubernetes-api-server.md) — kube-apiserver 的证书认证、SSL/TLS 与架构分析
- [kube-scheduler 源码分析](./Cloud_Native/Kubernetes/4_kube-scheduler源码分析.md) — scheduler 的工作流程、配置初始化与调度算法源码解读
- [client-go list & watch 原理](./Cloud_Native/Kubernetes/5_client-go%20list%20&%20watch%20原理.md) — client-go 中 List-Watch 机制的实现原理
- [Service 相关](./Cloud_Native/Kubernetes/6_service相关.md) — Kubernetes Service 的概念、类型及其实现原理
- [CNI 详解](./Cloud_Native/Kubernetes/cni详解.md) — 容器网络接口的实现：IP 分配、network namespace、veth pair、bridge
- [FlowSchema](./Cloud_Native/Kubernetes/flowschema.md) — kube-apiserver 的流量控制与 API 优先级机制
- [PLEG](./Cloud_Native/Kubernetes/k8s之pleg.md) — Pod Lifecycle Event Generator 的原理与僵尸进程排查
- [Kubelet 原理](./Cloud_Native/Kubernetes/kubelet原理.md) — kubelet 创建 Pod 的完整流程：syncLoop、PLEG、容器运行时
- [容器运行时全链路：OCI、CRI、containerd、shim 与 RuntimeClass](./Cloud_Native/Kubernetes/容器运行时.md) — 从 kubelet 到容器进程：五个概念的边界、代码级调用链、shim 生命周期与 RuntimeClass handler 解析
- [Kubernetes 高可用](./Cloud_Native/Kubernetes/kubernetes_ha.md) — stacked etcd 与 external etcd 两种 HA 拓扑方案
- [RBAC](./Cloud_Native/Kubernetes/rbac.md) — 基于角色的访问控制：用户创建、证书签名请求、权限绑定
- [Kueue](./Cloud_Native/Kubernetes/kueue.md) — Kubernetes 原生作业队列管理器：配额管理、公平共享、抢占与多集群调度

### AI Infrastructure

- [Agent Substrate](./Cloud_Native/AI_Infrastructure/agent-substrate.md) — CNCF 高密度 Agent 沙箱 Runtime（v1.0.0）：Actor/Worker 多路复用、VOLUMES/ROOTFS/MEMORY 快照、PostgreSQL+OpenFGA 控制面、SPIFFE 身份与 egress 网关
- [Agent Sandbox](./Cloud_Native/AI_Infrastructure/agent-sandbox.md) — K8s 原生沙箱执行环境：WarmPool 预热池、SandboxClaim 生命周期、7 层安全隔离、Router 请求路由与认证
- [kagent](./Cloud_Native/AI_Infrastructure/kagent.md) — CNCF K8s 原生 AI Agent 框架：声明式 CRD、Agent Controller、A2A Handler Mux、MCP 工具生态、ADK Runtime
- [Cordis](./Cloud_Native/AI_Infrastructure/cordis.md) — 时空可组合性元框架：可逆副作用（effect）+ 响应式依赖（coeffect）、Fiber 生命周期状态机、声明式 Loader、HMR；DeepSeek Harness 的插件内核
- [Cordis Hello World](./Cloud_Native/AI_Infrastructure/cordis-hello-world.md) — ~70 行可运行 demo：effect/inject/provide 的「上手即跑」演示（服务消失/恢复自动停用/复活、LIFO 回收、箭头函数插件踩坑）
- [HAMi](./Cloud_Native/AI_Infrastructure/hami.md) — CNCF 异构 AI 算力虚拟化与调度：extender 选点、设备级策略链、14 家加速器后端、与 MIG/MPS/GPU Operator 的边界
- [HAMi-core](./Cloud_Native/AI_Infrastructure/hami-core.md) — 容器内 CUDA 劫持实现：ld.so.preload / dlsym / cuGetProcAddress 三路接管、显存账本、算力令牌桶

### Cluster Lifecycle

- [Cluster API](./Cloud_Native/Cluster_Lifecycle/cluster-api.md) — 声明式集群生命周期管理：provider 契约、资源层级、集群创建流程、自定义 provider 示例

### CICD

- [DevOps 理念与实践](./Cloud_Native/CICD/devops-thinking.md) — CI/CD pipeline 设计原则：Pipeline as Code、可复用性、性能与可靠性指标、开发环境可复现

### Linux Container

- [容器知识备忘录](./Cloud_Native/Linux_Container/容器知识备忘录.md) — Linux Namespace、Cgroups、UnionFS 等容器核心技术总结
- [OverlayFS 与镜像层：从联合挂载到 OCI 分层](./Cloud_Native/Linux_Container/OverlayFS与镜像层.md) — overlayfs 四要素/copy-up/whiteout 内核语义、OCI layer 的 tar changeset 与 diffID、containerd content store 与 unpack 全链路
- [镜像快照器（Snapshotter）：containerd 如何把层变成 rootfs](./Cloud_Native/Linux_Container/镜像快照器snapshotter.md) — Active/Committed/View 三态、overlay 驱动 lowerdir 组装、chainID 与 GC、内置驱动对比
- [镜像懒加载：stargz、Nydus、SOCI 与 OverlayBD](./Cloud_Native/Linux_Container/镜像懒加载.md) — remote snapshotter 协议、eStargz TOC/footer、RAFS、SOCI index、OverlayBD 块设备，以及选型与排障

### Virtualization

- [沙箱与虚拟化技术全景：KVM、QEMU、Firecracker、Kata、gVisor](./Cloud_Native/Virtualization/沙箱与虚拟化技术全景.md) — 三种隔离边界（共享内核/用户态内核/硬件虚拟化）、KVM→VMM→运行时分层、五技术对比矩阵与选型决策树

## Machine Learning

### High Performance Computing

- [ompi架构介绍](./Machine_Learning/High_Performance_Computing/ompi架构介绍.md) — Open MPI 架构介绍
- [Slurm](./Machine_Learning/High_Performance_Computing/slurm.md) — HPC 集群工作负载管理器：job/step 概念、job 生命周期、多因子优先级、保守回填、cons_tres 选择、抢占算法

### Inference

- [Model Mesh Serving](./Machine_Learning/Inference/Model%20Mesh%20Serving:%20一种可以大规模部署ML模型的解决方案.md) — 大规模 ML 模型部署方案：ModelMesh 的原理与架构
- [vLLM Production Stack 实战](./Machine_Learning/Inference/vLLM%20Production%20Stack实战.md) — vLLM 生产环境搭建实战：硬件准备、LWS 部署、benchmark

## Operation

### Development Environment

- [Docker 环境配置](./Operation/Development_Environment/Docker环境配置.md) — Docker 在 Ubuntu/WSL 中的安装与镜像加速配置
- [Windows 开发环境配置](./Operation/Development_Environment/WIndows开发环境配置.md) — WSL 安装、版本切换与 Windows 开发环境搭建

### Linux

- [Bash 及命令行工具技巧集合](./Operation/Linux/Bash以及命令行工具技巧集合.md) — 网络诊断、磁盘管理、Bash 脚本等实用命令行技巧
