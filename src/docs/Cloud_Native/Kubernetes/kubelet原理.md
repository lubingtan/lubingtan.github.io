# Kubelet 原理

## 创建Pod过程

### 1. syncLoop循环监听管道信息

监听多个 channel （file，http，apiserver，pleg），当发现任何一个 channel 有数据就交给 handler 去处理，在 handler 中通过调用 dispatchWork 分发任务

syncLoopIteration 根据pod 的不同事件，执行不同的逻辑

### 2. HandlePodAdditions处理pod

HandlePodAdditions主要任务是：

1. 按照创建时间给pods进行排序；
2. 将pod添加到pod管理器中，如果有pod不存在在pod管理器中，那么这个pod表示已经被删除了；
3. 校验pod 是否能在该节点运行，如果不可以直接拒绝；
4. 调用dispatchWork把 pod 分配给给 worker 做异步处理,创建pod；
5. 将pod添加到probeManager中，如果 pod 中定义了 readiness 和 liveness 健康检查，启动 goroutine 定期进行检测；

### 3. dispatchWork

dispatchWork会封装一个UpdatePodOptions结构体丢给podWorkers.UpdatePod去执行

### 4. UpdatePod

这个方法会加锁之后获取podUpdates数组里面数据，如果不存在那么会创建一个channel然后执行一个异步协程。

### 5. managePodLoop

这个方法会遍历channel里面的数据，然后调用syncPodFn方法并传入一个syncPodOptions，kubelet会在执行NewMainKubelet方法的时候调用newPodWorkers方法设置syncPodFn为Kubelet的syncPod方法。

### 6. syncPod

该方法主要是为创建pod前做一些准备工作。主要准备工作如下：

1. 校验该pod能否运行，如果不能运行，那么回写container的等待原因，然后更新状态管理器中的状态；
2. 如果校验没通过或pod已被删除或pod跑失败了，那么kill掉pod，然后返回；
3. 校验网络插件是否已准备好，如果没有，直接返回；
4. 如果该pod的cgroups不存在，那么就创建cgroups（cgroup paraent后面会作为参数传给 createPodSandbox）；
5. 为静态pod创建镜像；
6. 创建pod的文件目录，等待volumes attach/mount；
7. 拉取这个pod的Secret；
8. 调用containerRuntime.SyncPod真正创建pod；

### 7. containerRuntime.SyncPod

1. 首先会调用computePodActions计算一下有哪些pod中container有没有变化，有哪些container需要创建,有哪些container需要kill掉；
2. kill掉 sandbox 已经改变的 pod；
3. 如果有container已改变，那么需要调用killContainer方法kill掉ContainersToKill列表中的container；
4. 调用pruneInitContainersBeforeStart方法清理同名的 Init Container；
5. 调用createPodSandbox方法，创建需要被创建的Sandbox，关于Sandbox我们再下面说到；
6. 如果开启了临时容器Ephemeral Container，那么需要创建相应的临时容器，临时容器可以看这篇：https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/；
7. 获取NextInitContainerToStart中的container，调用startContainer启动init container；
8. 获取ContainersToStart列表中的container，调用startContainer启动containers列表；

### 8. computePodActions

computePodActions方法主要做这么几件事：

1. 检查PodSandbox有没有改变，如果改变了，那么需要创建PodSandbox；
2. 找到需要运行的Init Container设置到NextInitContainerToStart字段中；
3. 找到需要被kill掉的Container列表ContainersToKill；
4. 找到需要被启动的Container列表ContainersToStart；

### 9. Sandbox

Sandbox沙箱是一种程序的隔离运行机制，其目的是限制不可信进程的权限。k8s 中每个 pod 共享一个 sandbox定义了其 cgroup 及各种 namespace，所以同一个 pod 的所有容器才能够互通，且与外界隔离。我们在调用createPodSandbox方法创建sandbox的时候分为如下几步：

![image-20200926163420747](./kubelet原理.assets/20200926201151.png)

### 10. startContainer

1. 拉取镜像；
2. 计算一下Container重启次数，如果是首次创建，那么应该是0；
3. 生成Container config，用于创建container；
4. 调用CRI接口CreateContainer创建Container；
5. 在启动之前调用PreStartContainer做预处理工作；
6. 调用CRI接口StartContainer启动container；
7. 调用生命周期中设置的钩子 post start；


## 延伸阅读

- [容器运行时全链路：OCI、CRI、containerd、shim 与 RuntimeClass](./容器运行时.md) —— 本文只讲到 `containerRuntime.SyncPod` 这一层；CRI 的 gRPC 接口定义、containerd 如何把 CRI 请求翻译成 OCI spec、shim 如何持有容器进程、RuntimeClass 的 handler 如何一路传到运行时，见该页。
- [控制面高可用方案](./控制面高可用方案.md) —— 控制面全部不可用时 kubelet 为什么还能维持存量 Pod（static pod 的文件来源、node lease 与 NotReady 时序），见该页的失效域矩阵。
- [控制面事故处理手册](./控制面事故处理手册.md) —— kubelet 证书过期、节点 NotReady、磁盘压力等现场处置（R6/R10）。
- [CNI 详解](./cni详解.md) —— 本文的 `createPodSandbox` 讲到 CRI 为止；netns 由 containerd 创建、CNI 插件如何被调用、veth/bridge/路由/NAT 实际发生在哪，见该页。
