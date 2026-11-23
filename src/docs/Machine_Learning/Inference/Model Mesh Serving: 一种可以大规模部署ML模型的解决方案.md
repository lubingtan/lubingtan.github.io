#  Model Mesh Serving: 一种可以大规模部署ML模型的解决方案

## What Is Model Mesh Serving

### 背景: Inference Service in MLOps

作为一个算法工程师/Data scientist, 往往希望在训练结束后, 能够快速的把模型部署在服务器中, 这样就能让模型很方便的接收外部请求并返回预测结果.

基于这种需求, [Tensorflow Serving](https://github.com/tensorflow/serving), [TorchServe](https://github.com/pytorch/serve), [Triton Inference Server](https://github.com/triton-inference-server/server), [ONNX Runtime Server](https://github.com/microsoft/onnxruntime/blob/master/docs/ONNX_Runtime_Server_Usage.md) 等各种 model inference server 开始出现. 

不过随着技术以及业务规模的发展, 我们的需求也变得更多, 我们不仅希望把模型部署在服务器上, 更希望能够非常简单的集成**日志/监控/服务发现/负载均衡**等功能, 以及能够非常方便的进行**金丝雀发布/滚动更新**等各种运维操作.

这里有两种思路:

- 第一种思路就是, 把 model server 当作是一种普通的后端服务: 

  在这种方案中, AI 工程师需要了解大量和以上功能相关的知识, 或者也可以将模型交付给后端工程师. 然而不管那种方式, 显然都增加了大量的时间以及沟通成本. 并且公司内不同的团队使用不同的框架/接口协议, 这些都会造成额外的接入成本.

- 另一种思路是, 把 model server 当作一种特殊的后端服务:

  由 AI 工程师以及后端工程师共同组成一支团队,  建设一个专门用于模型部署的平台. 对于所有模型都以一种标准化的方式进行管理, 并且提供一系列工具对于模型的部署/更新/优化等操作进行封装及简化. 利用这些平台工具, 不同团队的AI工程师都可以非常方便的对于模型进行发布. 这样就可以大大较少模型交付以及迭代的成本.

基于第二种思路, 当前已经出现了一些可用于构建推理平台的开源项目, 例如 [kfserving](https://github.com/kserve/kserve) (已经改名为 kserve, 并从 kubeflow 独立出来), [Seldon Core](https://github.com/SeldonIO/seldon-core). 

关于这些方案, 具体细节这里就不再赘述了, 感兴趣的同学可以到 github 上进一步了解.

> 不过, 笔者认为它们并非是完美的方案, 它们的底层都使用了 trtion, tfserving 等这些 model server, 但是并没有发挥出这些 model server 的全部特性.

### IBM 开源的方案: Model Mesh Serving

[Model Mesh Serving](https://github.com/kserve/modelmesh-serving) 是IBM开源的模型推理方案, 据说已经在内部平稳运行多年了, 现在已经开源, 并作为一个子项目加入了 kserve.

Model Mesh Serving  旨在解决 'one model one server' 模式 (也是kserve和seldon采用的方案) 的弊端:

- 无法最大限度的有效利用资源
- 节点上的 Pod 数量是有限的 (100+)
- 集群的 IP 数量是有限的, 从而导致模型的数量也是有限的

Model Mesh Serving  提供了以下一些 feature:

- Scalability: 使用 multi-model server, 能够以少量 pod 加载大量模型
  
- Cache managerment and HA 
  
  - 管理模型的机制类似于 LRU cache, 动态的加载/卸载模型, 如果某个模型的访问负载很高, 就将它copy到多个 server 实例 (pod)
  
  - 在模型的 copies 之间做 负载均衡/路由转发
  - retrying/rerouting failed requests
  
- Intelligent placement and loading
  - 加载模型时, 在多个 pod 之间做均衡: 把负载高的模型放到负载小的 pod 中

- Resiliency
  - 加载模型失败时, 会在其他 pod 上做重试

- Operational simplicity:

  - 模型可以进行滚动更新, 对于 requests 无感

Model Mesh Serving 包含的组件

- `ServingRuntime`: Triton, MLServer, etc
- `ModelMesh`: Mesh Layer
- `Runtime Adapters`: Adapters to different runtimes
- `ModelMesh Serving`: Controller for mesh , runtime , predictor



![0.2.0-highlevel.png](../../images/modelmesh/0.2.0-highlevel.png)



![rt-builtin.png](../../images/modelmesh/rt-builtin.png)



> 参考: [ModelMesh and KServe bring eXtreme scale standardized model inferencing on Kubernetes – IBM Developer](https://developer.ibm.com/blogs/kserve-and-watson-modelmesh-extreme-scale-model-inferencing-for-trusted-ai/)



## How Model Mesh Works

### Model Mesh Layer

Model Mesh 的核心就是实现了以下几个 rpc 接口:

```protobuf
service ModelMesh {
  // Creates a new vmodel id (alias) which maps to a new or existing
  // concrete model, or sets the target model for an existing vmodel
  // to a new or existing concrete model
  rpc setVModel (SetVModelRequest) returns (VModelStatusInfo) {}

  // Deletes a vmodel, optionally deleting any referenced concrete
  // models at the same time
  rpc deleteVModel (DeleteVModelRequest) returns (DeleteVModelResponse) {}

  // Gets the status of a vmodel, including associated target/active model ids
  // If the vmodel is not found, the returned VModelStatusInfo will have empty
  // active and target model ids and an active model status of NOT_FOUND
  rpc getVModelStatus (GetVModelStatusRequest) returns (VModelStatusInfo) {}
}
```

下面介绍 modelmesh 中的几个关键概念以及实现.

#### VModel (virtual model) 是什么? 

- 可以把 VModel 理解为某一类模型 (例如 人脸识别模型/bert 模型等等), 同时 Model 是具体的某一个模型 (每个具体的模型有不同的参数以及对应的模型文件)
  - model mesh 通过 model id 标记 VModel , 通过 target id 标记 Model. 也就是说 VModel 下所属的每个 Model 都有相同的 model id, 但是有不同的 target id

- model mesh 通过对 VModel + Model 的管理, 实现了模型的发布管理 (有点像 k8s 中的 deployment)

#### 模型是如何被加载的?

调用stack:

1. ModelMeshAPI 暴露 setVModel 接口
2. setVModel 中, 调用了 VModelMananger 的 updateVModel, updateVModel 修改 etcd 上的 Model 记录
3. ModelMesh watch 到 Model Update Event, 执行 VModelManager 的 processVModel
4. processVModel 中执行 ensureLoaded →  internalOperation → invokeModel →
      - invokeLocalModel → 本地执行 model runtime client
        - model runtime client 是一个 GRPC client, 执行同一个 pod 的 runtime 容器
        - 把请求缓存到一个 `loadingQueue`中 (loadingQueue 是一个优先队列)
        - 默认异步执行, 如果需要同步执行, 提高优先级, 并等待.
      - invokeRemote → 执行  remoteClient 或 cacheMissClient (远程 model mesh)
        - runtimeClient  负载均衡策略:  选择很久没用过的节点 (last recently used 最小的)
        - cacheMissClient 的 lb 策略: 从 prefer 的 instance 中随机选择一个
      - forwardInvokeModel → 执行 directClient (远程 model mesh)
        - directClient 是一个 Thrift RPC client, 指向上次 (runtimeClient/cacheMissClient) 选择的 model mesh 实例.

invokeModel 的逻辑 (非常复杂):

1. 如果设置了 Local  flag, 在本地执行, 如果模型不在本地, 会抛出错误
2. 如果请求有 copy 的 flag, 说明需要复制模型, 加上 unbalanced flag, 递归执行 invokeModel 
3. 根据 exclude 参数 (从请求的 context 里获取的), 过滤所有 instance
4. 如果存在可选的 instance, 则根据各种参数判断 需要在本地执行还是远程执行 (比如请求已经被 balaced 了, 则在本地执行)
5. 如果不存在可选的 instance, 说明出现了 cache miss
   1. 如果来自集群外部的请求, 使用  cacheMissClient  执行.
   2. 如果不是, 则在本地执行



#### 如何对 inference 请求进行路由转发的?

- model mesh 中实现了一个 grpc 代理, 对于带有特定 metadata 的请求进行转发

  > [run-inference.md](https://github.com/kserve/modelmesh-serving/blob/main/docs/predictors/run-inference.md): you should include an additional metadata parameter `mm-balanced = true`. 

- 服务启动: NettyServerBuilder → addService → new ServerInterceptor

- 接口调用stack: interceptCall →  startCall → ModelMesh.callModel → SidecarModelMesh.callModel → **invokeModel**

### Model Runtime Adapters

Model Runtime Adapters 实现了`ModelRuntime` 的接口, 并且适配真正的 ModelServer (例如 triton, mlserver, tfserving)

```protobuf
service ModelRuntime {
  rpc loadModel (LoadModelRequest) returns (LoadModelResponse) {}

  rpc unloadModel (UnloadModelRequest) returns (UnloadModelResponse) {}

  // Predict size of not-yet-loaded model - must return almost immediately.
  // Should not perform expensive computation or remote lookups.
  // Should be a conservative estimate.
  rpc predictModelSize (PredictModelSizeRequest) returns (PredictModelSizeResponse) {}

  // Calculate size (memory consumption) of currently-loaded model
  rpc modelSize (ModelSizeRequest) returns (ModelSizeResponse) {}
  rpc runtimeStatus (RuntimeStatusRequest) returns (RuntimeStatusResponse) {}
}
```

实现逻辑非常简单, 以  `model-mesh-triton-adapter`为例:

LoadModel:

1. 下载模型(同步)
2. 根据模型类型, 重新设置模型文件名以及路径 (比如 triton 就有些特殊要求, onnx 模型的名字为 model.onnx)
3. 向 model server 发送请求 (triton 的load 接口: RepositoryModelLoad)
4. 返回结果

### Model Mesh Seving

Model Mesh Serving 就是 ModelMesh 的controller plane, 它控制了两个 CRD: Predictor 以及 ServingRuntime.

它的功能有:

1. Watch ServiceRuntime, 创建带有 Model Mesh container 的 Deployment
2. Watch predictor, 访问 Model Mesh 实例, 发送 setVModel/deleteVModel/getVModelStatus 请求
3. Watch Etcd 中对应 VModel/Model 的 key-value, 转换为 predictor 的 name, 塞进 predictor controller 中处理.
4. 维护 ModelMesh client 以及对应的 grpc resolver

## Conclusion

感觉 ModelMesh 的想法非常好, 这才是**AI推理服务**的 Serverless !

不过, 感觉这个项目目前还不太成熟.

- 只能支持单个 namespace 的 model mesh, 每扩展一个namespace 就要操作一把, 非常不友好.
- 需要一个额外的 etcd (在 k8s 之外), 这一点让人感觉非常别扭, 也增加了维护成本.
- ModelMesh 作为最重要的组件居然是用 java 写的 (其他都是go), 而且用了一个 IBM 自己的 java 框架 (根本没人用). 可以理解, 但是作为开源项目, 感觉对项目的推广非常不友好.

总的来说, 感觉这个项目还是值得一看的. 另外看到matainer也在积极推进项目的发展 (比如说支持多namespace), 希望能早日到达生产可用的状态.
