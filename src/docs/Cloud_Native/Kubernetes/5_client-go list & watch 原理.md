# client-go list & watch 原理


ListAndWatch设计到两个操作

List和Watch

List没啥好说的

看看Watch：

# Watch原理

## 概要

kube-apiserver与etcd之间有个长连接（GRPC stream），对资源进行watch

kube-apiserver与client-go之间有个长连接（websocket或Transfer-Encoding），作为etcd watch的代理

## API Server

### Watch接口

在`staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go`中，有个`ListResource`接口，其中实现了对资源的watch接口

 ```Go
 if opts.Watch || forceWatch {
   // 省略
   // ......
   metrics.RecordLongRunning(req, requestInfo, metrics.APIServerComponent, func() {
     serveWatch(watcher, scope, outputMediaType, req, w, timeout)
   })
   return
 } 
 // 省略 
 ```


我们继续往下看`serveWatch`中发生了什么

在`pkg/endpoints/handlers/watch.go`中有：

 ```Go
 server := &WatchServer{
     Watching: watcher,
     Scope:    scope,
 
     UseTextFraming:  useTextFraming,
     MediaType:       mediaType,
     Framer:          framer,
     Encoder:         encoder,
     EmbeddedEncoder: embeddedEncoder,
 
     Fixup: func(obj runtime.Object) runtime.Object {
       result, err := transformObject(ctx, obj, options, mediaTypeOptions, scope, req)
       if err != nil {
         utilruntime.HandleError(fmt.Errorf("failed to transform object %v: %v", reflect.TypeOf(obj), err))
         return obj
       }
       // When we are transformed to a table, use the table options as the state for whether we
       // should print headers - on watch, we only want to print table headers on the first object
       // and omit them on subsequent events.
       if tableOptions, ok := options.(*metav1.TableOptions); ok {
         tableOptions.NoHeaders = true
       }
       return result
     },
 
     TimeoutFactory: &realTimeoutFactory{timeout},
   }
 
   server.ServeHTTP(w, req)
 ```


可见WatcheServer是实现watch接口的关键组件，在`ServeHTTP`方法中，出现了两个分支

 ```Go
 if wsstream.IsWebSocketRequest(req) {
     w.Header().Set("Content-Type", s.MediaType)
     websocket.Handler(s.HandleWS).ServeHTTP(w, req)
     return
   }
 // ......省略
  // begin the stream
   w.Header().Set("Content-Type", s.MediaType)
   w.Header().Set("Transfer-Encoding", "chunked")
   w.WriteHeader(http.StatusOK)
   flusher.Flush()
   // ......省略 
 ```


可见如果WatchServer同时实现了`websocket`接口以及http的`Transfer-Encoding`接口（分块传输编码，http长连接，单向的？）。

而在传输数据的部分：

 ```Go
   ch := s.Watching.ResultChan()
   done := req.Context().Done()
 
   for {
     select {
     case <-done:
       return
     case <-timeoutCh:
       return
     case event, ok := <-ch:
       if !ok {
         // End of results.
         return
       }
 // ......省略 
 ```


这里`s.Watching`就是对etcd的资源watch的接口，`s.Watching.ResultChan`是资源watch event。

`s.Watching`其实是一个`watch.Interface`对象，它是从哪里来的

### Watcher对象

一路追查

位于`staging/src/k8s.io/apiserver/pkg/storage/etcd3/store.go`中的`Watch`以及`WatchList`接口创建了`watch.Interface`对象

 ```Go
 // Watch implements storage.Interface.Watch.
 func (s *store) Watch(ctx context.Context, key string, opts storage.ListOptions) (watch.Interface, error) {
   return s.watch(ctx, key, opts, false)
 }
 
 // WatchList implements storage.Interface.WatchList.
 func (s *store) WatchList(ctx context.Context, key string, opts storage.ListOptions) (watch.Interface, error) {
   return s.watch(ctx, key, opts, true)
 }
 
 func (s *store) watch(ctx context.Context, key string, opts storage.ListOptions, recursive bool) (watch.Interface, error) {
   rev, err := s.versioner.ParseResourceVersion(opts.ResourceVersion)
   if err != nil {
     return nil, err
   }
   key = path.Join(s.pathPrefix, key)
   return s.watcher.Watch(ctx, key, int64(rev), recursive, opts.ProgressNotify, opts.Predicate)
 }
 ```


位于`staging/src/k8s.io/apiserver/pkg/storage/etcd3/watcher.go`的`startWatching`函数，调用了etcd client的`watch`接口，关键代码：

 ```Go
 
 // startWatching does:
 // - get current objects if initialRev=0; set initialRev to current rev
 // - watch on given key and send events to process.
 func (wc *watchChan) startWatching(watchClosedCh chan struct{}) {
   // 省略......
   wch := wc.watcher.client.Watch(wc.ctx, wc.key, opts...)
   // 省略......
 }
 ```


## Client-Go

### 创建`SharedInformerFactory`

 ```Go
 func NewFilteredSharedInformerFactory(client kubernetes.Interface, defaultResync time.Duration, namespace string, tweakListOptions internalinterfaces.TweakListOptionsFunc) SharedInformerFactory {
   return NewSharedInformerFactoryWithOptions(client, defaultResync, WithNamespace(namespace), WithTweakListOptions(tweakListOptions))
 }
 ```


### 创建PodInformer

创建了SharedIndexInformer接口

ListWatch结构保存了ListFunc和WatchFunc

 ```Go
 func NewFilteredPodInformer(client kubernetes.Interface, namespace string, resyncPeriod time.Duration, indexers cache.Indexers, tweakListOptions internalinterfaces.TweakListOptionsFunc) cache.SharedIndexInformer {
   return cache.NewSharedIndexInformer(
     &cache.ListWatch{
       ListFunc: func(options metav1.ListOptions) (runtime.Object, error) {
         if tweakListOptions != nil {
           tweakListOptions(&options)
         }
         return client.CoreV1().Pods(namespace).List(context.TODO(), options)
       },
       WatchFunc: func(options metav1.ListOptions) (watch.Interface, error) {
         if tweakListOptions != nil {
           tweakListOptions(&options)
         }
         return client.CoreV1().Pods(namespace).Watch(context.TODO(), options)
       },
     },
     &corev1.Pod{},
     resyncPeriod,
     indexers,
   )
 }
 ```


### SharedIndexInformer

SharedIndexInformer接口定义了诸如AddEventHandler、Run、HasSynced等方法

结构体的一些关键成员：

- **processor**：实现了对object的watch

- **indexer**：一个本地缓存，保存list & watch得到的结构体，当object被删掉时，本地缓存也会删掉

- **listerWatcher**：制定了对哪个对象类型进行list & watch

 ```Go
 func NewSharedIndexInformer(lw ListerWatcher, exampleObject runtime.Object, defaultEventHandlerResyncPeriod time.Duration, indexers Indexers) SharedIndexInformer {
   realClock := &clock.RealClock{}
   sharedIndexInformer := &sharedIndexInformer{
     processor:                       &sharedProcessor{clock: realClock},
     indexer:                         NewIndexer(DeletionHandlingMetaNamespaceKeyFunc, indexers),
     listerWatcher:                   lw,
     objectType:                      exampleObject,
     resyncCheckPeriod:               defaultEventHandlerResyncPeriod,
     defaultEventHandlerResyncPeriod: defaultEventHandlerResyncPeriod,
     cacheMutationDetector:           NewCacheMutationDetector(fmt.Sprintf("%T", exampleObject)),
     clock:                           realClock,
   }
   return sharedIndexInformer
 }
 ```


### SharedIndexInformer::Run过程

1. 创建一个Controller（包含了FINO Queue，ListWatcher），将SharedIndexInformer的HandleDeltas方法注入给Controller的Process

2. Controller Run， processor Run

### Controller

Controller其实就是负责对资源的list & watch，每当获取到一个object就调用一下Process

Controller中的几个重要成员

1. **FIFO Queue**：Controller会对Queue进行轮询，当有新的object pop出来时，就调用Process方法。

2. **Reflector**：真正调用ListWatcher的地方，Reflector有个Store成员，其实就是Controller的`FIFO Queue`。在`Reflector::Run`房中法中，首先进行List把所有object保存到store中，然后调用ListWatcher的watch方法，当收到event时，就对store进行update.这里应该就是所谓的**二级缓存**，watch得到的event先保存在一个ratelimit queue中，然后再对store进行更新。

### sharedProcessor

sharedProcessor添加了一个processorListener结构，processorListener包含了HandlerFunc

具体嗲用handlerFunc的过程：

1. 在Informer的HandleDeltas方法中，调用了sharedProcessor的distribute方法对每个object进行处理

2. 在distribute方法中调用了listener的add方法, add 方法中将object传给一个channel

3. 在add方法中，会传给nextCh成员

4. 在run方法中，接受nextCh，并调用handler

## 延伸阅读

- [Kubernetes 控制面高可用方案](./控制面高可用方案.md) —— client-go 的 Lease 选主（`leaderelection` 包）如何实现 KCM/scheduler/kube-vip 的热备切换；多 apiserver 入口为什么必须靠 VIP/LB，而不是 client-go 自己做故障转移。
- [Kubernetes 控制面事故处理手册](./控制面事故处理手册.md) —— watch/list 重连风暴、informer 全量 list 对 apiserver 与 etcd 的冲击，以及 APF 429 的处置（R8）。

