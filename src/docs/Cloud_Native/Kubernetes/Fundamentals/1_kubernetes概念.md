

# **What** is Kubernetes

[官方文档](https://kubernetes.io/zh/docs/concepts/overview/what-is-kubernetes/)：

Kubernetes 是一个可移植的、可扩展的开源平台，用于管理容器化的工作负载和服务，可促进声明式配置和自动化。Kubernetes 拥有一个庞大且快速增长的生态系统。Kubernetes 的服务、支持和工具广泛可用。
# **Why** use Kubernetes
## **应用部署方式的发展历史**

传统应用发展到现在已经经历了多种部署架构：

![image-20210411153212606](https://i.loli.net/2021/04/12/OBgi7ILtbCcGv6F.png)

**传统部署时代**：

早期应用都是直接部署在物理服务器，无法为应用程序定义资源边界，从而引起多个应用之间的资源分配问题。 例如，如果在物理机上运行多个应用程序，由于其中一个应用程序占用了大部分资源， 导致其他应用程序性能下降。 有一个解决方案是，把每个应用程序放在不同的服务器上，其存在的问题是，在进行横向扩展时无法充分利用服务器资源， 并且维护多个物理机的成本很高。

**虚拟化部署时代**：

针对传统部署中出现的问题，引入了虚拟化解决方案。虚拟化技术允许在单个物理机的 上运行多个虚拟机（VM）。 虚拟化可以隔离位于不同 VM中的应用程序，并提供一定程度的安全，不同VM之间不能由应用程序直接访问。

虚拟化技术能够更好地利用物理服务器上的资源，并且由于可轻松地添加或更新应用程序，从而实现更好的可伸缩性，降低硬件成本等等。

每个 VM 是一台完整的计算机，在虚拟化硬件之上运行所有组件，包括其自己的操作系统。

**容器部署时代**：

容器类似于 VM，但是与VM相比隔离性较低，操作系统（OS）在应用程序之间是被共享的。 因此，容器被认为是轻量级的虚拟机。容器与 VM 类似，具有自己的文件系统、CPU、内存、进程空间等。 由于它们与基础架构分离，因此可以跨云和 OS 发行版本进行移植。

容器因具有许多优势而变得流行起来。下面列出的是容器的一些好处：

* 敏捷应用程序的创建和部署：与使用 VM 镜像相比，提高了容器镜像创建的简便性和效率。
* 持续开发、集成和部署：通过快速简单的回滚（由于镜像不可变性），支持可靠且频繁的容器镜像构建和部署。
* 关注开发与运维的分离：在构建/发布时而不是在部署时创建应用程序容器镜像， 从而将应用程序与基础架构分离。
* 可观察性：不仅可以观测OS级别的信息和指标，还可以显示应用程序的健康状态以及其它指标。
* 开发、测试以及生产环境的一致性：PC与云端保持统一的运行方式。
* 跨云和操作系统发行版本的可移植性：可在 Ubuntu、RHEL、CoreOS、本地、 Google Kubernetes Engine 和其他任何地方运行。
* 以应用程序为中心的管理：提高抽象级别，从在虚拟硬件上运行 OS 到使用逻辑资源在 OS 上运行应用程序。
* 松散耦合、分布式、弹性、解放的微服务：应用程序被分解成较小的独立部分，并且可以动态部署和管理，而不是在一台大型单机上整体运行。
* 资源隔离：可预测的应用程序性能。
* 资源利用：高效率和高密度。

## Kubernetes  提供的功能

Kubernetes 为你提供：

* **服务发现和负载均衡**：Kubernetes 可以通过DNS 或IP 地址的方式暴露容器。如果进入容器的流量很大， Kubernetes 可以负载均衡并分发网络流量，从而使部署稳定。
* **存储编排**：Kubernetes 允许你自动挂载你选择的存储系统，例如本地存储、公有云存储服务以及其它更多存储方式。
* **自动部署和回滚**：你可以使用 Kubernetes 描述已部署容器的所需状态，它可以以受控的速率将实际状态更改为期望状态。例如，你可以令Kubernetes自动化地为你的部署创建新容器，删除现有容器并将它们的所有资源用于新容器。
* **Automatic bin packing**：Kubernetes 允许你指定每个容器所需 CPU 和内存（RAM）。 当容器指定了资源请求时，Kubernetes 可以做出更好的决策来管理容器的资源。
* **自我修复**：Kubernetes 重新启动失败的容器、替换容器、杀死不响应用户定义的运行状况检查的容器，并且在准备好服务之前不将其通告给客户端。
* **密钥与配置管理**：Kubernetes 允许你存储和管理敏感信息，例如密码、OAuth 令牌和 ssh 密钥。 你可以在不重建容器镜像的情况下部署和更新密钥和应用程序配置，也无需在堆栈配置中暴露密钥。

## Kubernetes  不能提供的功能

Kubernetes 不是传统的、包罗万象的 PaaS（平台即服务）系统。 由于 Kubernetes 在容器级别而不是在硬件级别运行，它提供了 PaaS 产品共有的一些普遍适用的功能， 例如部署、扩展、负载均衡、日志记录和监视。 但是，Kubernetes 不是单体系统，默认解决方案都是可选和可插拔的。 Kubernetes 提供了构建开发人员平台的基础，但是在重要的地方保留了用户的选择和灵活性。

Kubernetes：

- 不限制支持的应用程序类型。 Kubernetes 旨在支持极其多种多样的工作负载，包括无状态、有状态和数据处理工作负载。 如果应用程序可以在容器中运行，那么它应该可以在 Kubernetes 上很好地运行。
- 不部署源代码，也不构建你的应用程序。 持续集成(CI)、交付和部署（CI/CD）工作流取决于组织的文化和偏好以及技术要求。
- 不提供应用程序级别的服务作为内置服务，例如中间件（例如，消息中间件）、 数据处理框架（例如，Spark）、数据库（例如，mysql）、缓存、集群存储系统 （例如，Ceph）。这样的组件可以在 Kubernetes 上运行，并且/或者可以由运行在 Kubernetes 上的应用程序通过可移植机制（例如， [开放服务代理](https://openservicebrokerapi.org/)）来访问。

- 不要求日志记录、监视或警报解决方案。 它提供了一些集成作为概念证明，并提供了收集和导出指标的机制。
- 不提供或不要求配置语言/系统（例如 jsonnet），它提供了声明性 API， 该声明性 API 可以由任意形式的声明性规范所构成。
- 不提供也不采用任何全面的机器配置、维护、管理或自我修复系统。
- 此外，Kubernetes 不仅仅是一个编排系统，实际上它消除了编排的需要。 **编排的技术定义**是**执行已定义的工作流程：首先执行 A，然后执行 B，再执行 C**。 相比之下，Kubernetes 包含一组独立的、可组合的控制过程， 这些过程连续地将当前状态驱动到所提供的所需状态。 如何从 A 到 C 的方式无关紧要，也不需要集中控制，这使得系统更易于使用 且功能更强大、系统更健壮、更为弹性和可扩展

# **How** Kubernetes works

当你部署完 Kubernetes, 即拥有了一个完整的集群。

一个 Kubernetes 集群由一组被称作节点的机器组成。这些节点上运行 Kubernetes 所管理的容器化应用。集群具有至少一个工作节点。

工作节点托管作为应用负载的组件的 Pod 。控制平面管理集群中的工作节点和 Pod 。 为集群提供故障转移和高可用性，这些控制平面一般跨多主机运行，集群跨多个节点运行。

本文档概述了交付正常运行的 Kubernetes 集群所需的各种组件。

这张图表展示了包含所有相互关联组件的 Kubernetes 集群。

![image-20210411160945780](https://i.loli.net/2021/04/13/Is3cyY1nM7ZVPm2.png)

## Kubernetes架构

### 控制面组件(Control Plane Components)

控制平面的组件对集群做出全局决策(比如调度)，以及检测和响应集群事件（例如，当不满足部署的 `replicas` 字段时，启动新的 [pod](https://kubernetes.io/docs/concepts/workloads/pods/pod-overview/)）。

控制平面组件可以在集群中的任何节点上运行。 然而，为了简单起见，设置脚本通常会在同一个计算机上启动所有控制平面组件，并且不会在此计算机上运行用户容器。 请参阅[构建高可用性集群](https://kubernetes.io/zh/docs/setup/production-environment/tools/kubeadm/high-availability/) 中对于多主机 VM 的设置示例。

#### kube-apiserver

apiserver是Kubernetes的控制面组件，它暴露了Kubernetes的API。apiserver也是Kubernetes的控制面前端。

Kubernetes API 服务器的主要实现是 [kube-apiserver](https://kubernetes.io/zh/docs/reference/command-line-tools-reference/kube-apiserver/)。 kube-apiserver 设计上考虑了水平伸缩，也就是说，它可通过部署多个实例进行伸缩。 你可以运行 kube-apiserver 的多个实例，并在这些**实例之间平衡流量**

#### etcd

etcd是拥有一致性以及高可用性的KV数据库，在kubernets中etcd被用于保存所有集群数据的后端存储。

在实际应用中，通常需要对etcd进行备份。

#### kube-scheduler

控制平面中调度器组件，负责监视新创建的、未指定运行[节点（node）](https://kubernetes.io/zh/docs/concepts/architecture/nodes/)的 [Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-overview/)，选择节点让 Pod 在上面运行。

调度决策考虑的因素包括，单个 Pod 和 Pod 集合的资源需求、硬约束/软约束/策略约束，亲和性和反亲和性spec、数据位置、工作负载间的干扰和最后时限。

#### kube-controller-manger

控制平面中的[控制器](https://kubernetes.io/zh/docs/concepts/architecture/controller/) 的组件。

从逻辑上讲，每个[控制器](https://kubernetes.io/zh/docs/concepts/architecture/controller/)都是一个单独的进程， 但是为了降低复杂性，它们都被编译到同一个可执行文件，并在一个进程中运行。

这些控制器包括:

- **节点控制器**（Node Controller）: 负责在节点出现故障时进行通知和响应
- **任务控制器**（Job controller）: 监测代表一次性任务的 Job 对象，然后创建 Pods 来运行这些任务直至完成
- **端点控制器**（Endpoints Controller）: 填充端点(Endpoints)对象(即加入 Service 与 Pod)
- **服务帐户和令牌控制器**（Service Account & Token Controllers）: 为新的命名空间创建默认帐户和 API 访问令牌

#### cloud-controller-manger

cloud-controller-manger是能够嵌入指定云的控制逻辑的组件，能够将自己的集群链接到云服务商。并且能够分离两种组件，两种组件分别是"与云服务交互的组件"，以及"与自己的集群交互的组件"。

`cloud-controller-manager` 仅用于特定云平台的控制回路。 如果你在自己的环境中运行 Kubernetes，或者在本地计算机中运行学习环境， 所部署的环境中不需要云控制器管理器。

与 `kube-controller-manager` 类似，`cloud-controller-manager` 将若干逻辑上独立的 控制回路组合到同一个可执行文件中，供你以同一进程的方式运行。 你可以对其执行水平扩容（运行不止一个副本）以提升性能或者增强容错能力。

下面的控制器都包含对云平台驱动的依赖：

- 节点控制器（Node Controller）: 用于在节点终止响应后检查云提供商以确定节点是否已被删除
- 路由控制器（Route Controller）: 用于在底层云基础架构中设置路由
- 服务控制器（Service Controller）: 用于创建、更新和删除云提供商负载均衡器

### 节点组件（Node Components）

#### kubelet

一个在集群中每个[节点（node）](https://kubernetes.io/zh/docs/concepts/architecture/nodes/)上运行的代理。 它保证[容器（containers）](https://kubernetes.io/zh/docs/concepts/overview/what-is-kubernetes/#why-containers)都 运行在 [Pod](https://kubernetes.io/docs/concepts/workloads/pods/pod-overview/) 中。

kubelet 接收一组通过各类机制提供给它的 PodSpecs，确保这些 PodSpecs 中描述的容器处于运行状态且健康。 kubelet 不会管理不是由 Kubernetes 创建的容器。

#### kube-proxy

[kube-proxy](https://kubernetes.io/zh/docs/reference/command-line-tools-reference/kube-proxy/) 是集群中每个节点上运行的网络代理， 实现 Kubernetes [服务（Service）](https://kubernetes.io/zh/docs/concepts/services-networking/service/) 概念的一部分。

kube-proxy 维护节点上的网络规则。这些网络规则允许从集群内部或外部的网络会话与 Pod 进行网络通信。

如果操作系统提供了数据包过滤层并可用的话，kube-proxy 会通过它来实现网络规则。否则，kube-proxy 仅转发流量本身。

#### 容器运行时（Container Runtime）

容器运行环境是负责运行容器的软件。

Kubernetes 支持多个容器运行环境: [Docker](https://kubernetes.io/zh/docs/reference/kubectl/docker-cli-to-kubectl/)、 [containerd](https://containerd.io/docs/)、[CRI-O](https://cri-o.io/#what-is-cri-o) 以及任何实现 [Kubernetes CRI (容器运行环境接口)](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-node/container-runtime-interface.md)。

### 插件（Addons）

插件使用 Kubernetes 资源（[DaemonSet](https://kubernetes.io/zh/docs/concepts/workloads/controllers/daemonset/)、 [Deployment](https://kubernetes.io/zh/docs/concepts/workloads/controllers/deployment/)等）实现集群功能。 因为这些插件提供集群级别的功能，插件中命名空间域的资源属于 `kube-system` 命名空间。

下面描述众多插件中的几种。有关可用插件的完整列表，请参见 [插件（Addons）](https://kubernetes.io/zh/docs/concepts/cluster-administration/addons/)

#### DNS

尽管其他插件都并非严格意义上的必需组件，但几乎所有 Kubernetes 集群都应该 有[集群 DNS](https://kubernetes.io/zh/docs/concepts/services-networking/dns-pod-service/)， 因为很多示例都需要 DNS 服务。

集群 DNS 是一个 DNS 服务器，和环境中的其他 DNS 服务器一起工作，它为 Kubernetes 服务提供 DNS 记录。

Kubernetes 启动的容器自动将此 DNS 服务器包含在其 DNS 搜索列表中。

#### Web界面（dashboard）

[Dashboard](https://kubernetes.io/zh/docs/tasks/access-application-cluster/web-ui-dashboard/) 是Kubernetes 集群的通用的、基于 Web 的用户界面。 它使用户可以管理集群中运行的应用程序以及集群本身并进行故障排除

#### 容器资源监控

[容器资源监控](https://kubernetes.io/zh/docs/tasks/debug-application-cluster/resource-usage-monitoring/) 将关于容器的一些常见的时间序列度量值保存到一个集中的数据库中，并提供用于浏览这些数据的界面。

#### 集群级别的日志

[集群层面日志](https://kubernetes.io/zh/docs/concepts/cluster-administration/logging/) 机制负责将容器的日志数据 保存到一个集中的日志存储中，该存储能够提供搜索和浏览接口。

## KubernetesAPI

Kubernetes [控制面](https://kubernetes.io/zh/docs/reference/glossary/?all=true#term-control-plane) 的核心是 [API 服务器](https://kubernetes.io/zh/docs/reference/command-line-tools-reference/kube-apiserver/)。 API 服务器负责提供 HTTP API，以供用户、集群中的不同部分和集群外部组件相互通信。

Kubernetes API 使你可以查询和操纵 Kubernetes API 中对象（例如：Pod、Namespace、ConfigMap 和 Event）的状态。

大部分操作都可以通过 [kubectl](https://kubernetes.io/zh/docs/reference/kubectl/overview/) 命令行接口或 类似 [kubeadm](https://kubernetes.io/zh/docs/reference/setup-tools/kubeadm/) 这类命令行工具来执行， 这些工具在背后也是调用 API。不过，你也可以使用 REST 调用来访问这些 API。

如果你正在编写程序来访问 Kubernetes API，可以考虑使用 [客户端库](https://kubernetes.io/zh/docs/reference/using-api/client-libraries/)之一。

### OpenAPI 规范

完整的 API 细节是用 [OpenAPI](https://www.openapis.org/) 来表述的。

Kubernetes API 服务器通过 `/openapi/v2` 末端提供 OpenAPI 规范。 你可以按照下表所给的请求头部，指定响应的格式：

| 头部               | 可选值                                                       | 说明                     |
| ------------------ | ------------------------------------------------------------ | ------------------------ |
| `Accept-Encoding`  | `gzip`                                                       | *不指定此头部也是可以的* |
| `Accept`           | `application/com.github.proto-openapi.spec.v2@v1.0+protobuf` | *主要用于集群内部*       |
| `application/json` | *默认值*                                                     |                          |
| `*`                | *提供*`application/json`                                     |                          |

Kubernetes 为 API 实现了一种基于 Protobuf 的序列化格式，主要用于集群内部通信。 关于此格式的详细信息，可参考 [Kubernetes Protobuf 序列化](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/api-machinery/protobuf.md) 设计提案。每种模式对应的接口描述语言（IDL）位于定义 API 对象的 Go 包中

### API变更

Kubernetes的[API废弃策略](https://kubernetes.io/zh/docs/reference/using-api/deprecation-policy/)

贡献者在变更API时可以参考[API变更](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api_changes.md#readme)

### API组和版本

Kubernetes 支持多个 API 版本， 每一个版本都在不同 API 路径下，例如 `/api/v1` 或`/apis/rbac.authorization.k8s.io/v1alpha1`。

### API扩展

有两种途径来扩展 Kubernetes API：

1. 你可以使用[自定义资源](https://kubernetes.io/zh/docs/concepts/extend-kubernetes/api-extension/custom-resources/) 来以声明式方式定义 API 服务器如何提供你所选择的资源 API。
2. 你也可以选择实现自己的 [聚合层](https://kubernetes.io/zh/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/) 来扩展 Kubernetes API。

## Kubernetes对象（Object）

### **What** is Kubernetes Object

Kubernetes Object可以理解为REST API中的*资源*。可以通过Kubernetes API对Object进行创建、修改、更新、删除等操作。

在Kubernetes 中，Kubernetes Object代表了对Kubernetes系统状态的描述，例如：

- 哪些容器化应用在运行（以及在哪些节点上）
- 可以被应用使用的资源
- 关于应用运行时表现的策略，比如重启策略、升级策略，以及容错策略

可以将Kubernetes 对象视为一种**声明式编程**，Kubernetes 对象描述了一种**目标**。创建对象的过程，本质上是在告知 Kubernetes 系统，用户所需要的工作负载看起来是什么样子的， 这就是 Kubernetes 集群的 **期望状态（Desired State）**。

### Kubernetes 对象的结构

每种 Kubernetes 对象都有自己的结构，举个例子，Deployment对象有如下结构（yaml格式）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
  namespace: default
  labels:
    environment: production
    app: nginx
  annotations:
    imageregistry: "https://hub.docker.com/"
spec:
  selector:
  matchLabels:
    component: redis
  matchExpressions:
    - {key: tier, operator: In, values: [cache]}
    - {key: environment, operator: NotIn, values: [dev]}
  replicas: 2 # tells deployment to run 2 pods matching the template
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
       image: nginx:1.14.2
        ports:
        - containerPort: 80
```

每个Kubernetes 对象都拥有如下字段。

#### apiVersion

对象的**分组**以及**版本**

#### kind

对象的种类

#### metadata

对象的**标识**，包括name、namespace、uid、labels等等

* **name**作为资源名称，name的命名规范需要 符合**DNS子域名**以及**DNS标签名**的规范（详见：[RFC-1123](https://tools.ietf.org/html/rfc1123)）。
  * 不能超过253个字符
  * 只能包含小写字母、数字，以及'-' 
  * 须以字母数字开头
  * 须以字母数字结尾

* **namespace**：名字空间为资源提供了一个**分组范围**。

  * 资源的名称需要在名字空间内是唯一的。 

  * 名字空间不能相互嵌套，每个 Kubernetes 资源只能在一个名字空间中。

  * 通过namespace可以划分资源（通过[资源配额](https://kubernetes.io/zh/docs/concepts/policy/resource-quotas/)）

  * 初始的四个空间：defaut、kube-node-lease、kube-system、kube-public

    > * `default` 没有指明使用其它名字空间的对象所使用的默认名字空间
    > * `kube-system` Kubernetes 系统创建对象所使用的名字空间
    > * `kube-public` 这个名字空间是自动创建的，所有用户（包括未经过身份验证的用户）都可以读取它。 这个名字空间主要用于集群使用，以防某些资源在整个集群中应该是可见和可读的。 这个名字空间的公共方面只是一种约定，而不是要求。
    > * `kube-node-lease` 此名字空间用于与各个节点相关的租期（Lease）对象； 此对象的设计使得集群规模很大时节点心跳检测性能得到提升

  * DNS支持：当创建一个[Service](https://kubernetes.io/zh/docs/concepts/services-networking/service/) 时， Kubernetes 会创建一个相应的 [DNS 条目](https://kubernetes.io/zh/docs/concepts/services-networking/dns-pod-service/)，该条目的形式是 `<服务名称>.<名字空间名称>.svc.cluster.local`

  * 有些资源没有namespace字段，如节点（Node）、持久化卷

* **labels**：资源上附加的KV键值对，可以作为自定义的**资源属性**。

  * **键的格式**：`<前缀段>/<名称段>`
    * **名称段**格式：名称段是必须有的，必须小于等于 63 个字符，以字母数字字符（`[a-z0-9A-Z]`）开头和结尾， 带有破折号（`-`），下划线（`_`），点（ `.`）和之间的字母数字。
    * **前缀段**格式：前缀必须符合 **DNS 子域格式**：由点（`.`）分隔的一系列 **DNS 标签**，总共不超过 253 个字符， 后跟斜杠（`/`）
    * **前缀段**可以省略：如果省略前缀，则默认该标签键是用户所私有。Kubernetes中的自动化组件（如scheduler、controller-manger以及第三方组件）**必须使用前缀**。另外，`kubernetes.io/` 前缀是为 Kubernetes 核心组件保留的。
  * **值的格式**：
    * 必须为 63 个字符或更少
    * 必须为空或以字母数字字符（`[a-z0-9A-Z]`）开头和结尾
    *  中间可以包含破折号（`-`）、下划线（`_`）、点（`.`）和字母或数字。

  * **Label选择器**：Kubernetes API（List、Watch）支持通过 label 选择运算符来对资源进行过滤，例如 `environment=production,app!=test`。支持的运算符有：`==`, `!=`, `in`, `notin`, `exists`

  * **资源Selector定义**：对于某些资源，它将视另外一些资源为子资源，进而进行管理（例如Deployment与Pod）。对于这些资源，也支持通过Label选择器来选择指定的子资源

* **annotations**：资源上附加的KV键值对，可以作为**资源元数据**。

  * 格式：**键的格式**与labels相同，值的格式没有限制。
  * 与labels不同，注解不用于标识和选择对象。 注解中的元数据，可以很小，也可以很大，可以是结构化的，也可以是非结构化的，能够包含标签不允许的字符。例如：指向日志、监控的地址，构建、发布的信息（时间戳、Git分支等），负责人的电话。

#### spec和status

spec 是对 Kubernetes Object **期望状态**的描述，status 是 Kubernetes Object **当前状态**的描述。

Kubernetes 的控制面会管理Object，使它的当前状态与期望状态相匹配。更多的可以查看 [Kubernetes API 约定](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md)

### Kubernetes对象的工作方式

#### 用户侧管理

* 可以使用 `kubectl` 命令行工具，支持多种不同的方式来创建和管理 Kubernetes 对象
* 可以使用sdk，如client-go

#### 控制面管理

* 控制平面
* 控制平面的扩展（第三方组件）
