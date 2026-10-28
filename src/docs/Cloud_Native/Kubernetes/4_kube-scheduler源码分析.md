# k8s scheduler 源码分析

## Scheduler 基本工作流程

### 配置初始化

#### 三种配置源

关键过程位于`pkg/scheduler/scheduler.go`

 ```Go
 func New(client clientset.Interface,
   informerFactory informers.SharedInformerFactory,
   recorderFactory profile.RecorderFactory,
   stopCh <-chan struct{},
   opts ...Option) (*Scheduler, error)
 ```


根据配置的`schedulerAlgorithmSource`不同，有三个分支，第一种就是用默认的provider，第二种是读取文件配置，第三种是读取configmap配置

 ```Go
   switch {
   case source.Provider != nil:
     // Create the config from a named algorithm provider.
     sc, err := configurator.createFromProvider(*source.Provider)
     if err != nil {
       return nil, fmt.Errorf("couldn't create scheduler using provider %q: %v", *source.Provider, err)
     }
     sched = sc
   case source.Policy != nil:
     // Create the config from a user specified policy source.
     policy := &schedulerapi.Policy{}
     switch {
     case source.Policy.File != nil:
       if err := initPolicyFromFile(source.Policy.File.Path, policy); err != nil {
         return nil, err
       }
     case source.Policy.ConfigMap != nil:
       if err := initPolicyFromConfigMap(client, source.Policy.ConfigMap, policy); err != nil {
         return nil, err
       }
     }
   } 
 ```


#### 默认配置

我们就直接看默认配置吧。

位于`pkg/scheduler/factory.go`的`createFromProvider`

 ```Go
 // createFromProvider creates a scheduler from the name of a registered algorithm provider.
 func (c *Configurator) createFromProvider(providerName string) (*Scheduler, error) {
   klog.V(2).InfoS("Creating scheduler from algorithm provider", "algorithmProvider", providerName)
   r := algorithmprovider.NewRegistry()
   defaultPlugins, exist := r[providerName]
   if !exist {
     return nil, fmt.Errorf("algorithm provider %q is not registered", providerName)
   }
 
   for i := range c.profiles {
     prof := &c.profiles[i]
     plugins := &schedulerapi.Plugins{}
     plugins.Append(defaultPlugins)
     plugins.Apply(prof.Plugins)
     prof.Plugins = plugins
   }
   return c.create()
 }
 ```


其中`profiles `是个`KubeSchedulerProfile`结构，其中有`SchedulerName`, `Plugins`， 如果没有指定`SchedulerName`默认等于`"default-scheduler"`

 ```Go
 type KubeSchedulerProfile struct {
   // SchedulerName is the name of the scheduler associated to this profile.
   // If SchedulerName matches with the pod's "spec.schedulerName", then the pod
   // is scheduled with this profile.
   SchedulerName string
 
   // Plugins specify the set of plugins that should be enabled or disabled.
   // Enabled plugins are the ones that should be enabled in addition to the
   // default plugins. Disabled plugins are any of the default plugins that
   // should be disabled.
   // When no enabled or disabled plugin is specified for an extension point,
   // default plugins for that extension point will be used if there is any.
   // If a QueueSort plugin is specified, the same QueueSort Plugin and
   // PluginConfig must be specified for all profiles.
   Plugins *Plugins
 
   // PluginConfig is an optional set of custom plugin arguments for each plugin.
   // Omitting config args for a plugin is equivalent to using the default config
   // for that plugin.
   PluginConfig []PluginConfig
 }
 
 ```


默认的`Plugins`配置位于`pkg/scheduler/algorithmprovider/registry.go`，这个配置相当长，具体有什么pulugin可以查看代码

 ```Go
 func getDefaultConfig() *schedulerapi.Plugins
 ```


#### Plugins是什么

plugins就是为了给pod分配节点，而创建的各种算法插件。

默认配置中主要配置了各种plugins，plugins可以分为这么几类（详情可以查看`pkg/scheduler/apis/config/types.go`中的`Plugins`结构体）：

1. **QueueSort**: 给pod排序的

2. **PreFilter**: 在filter之前执行一下

3. **Filter**: 过滤不可用的节点,

4. **PostFilter：**过滤后执行一下

5. **PreScore ：**打分前执行一下

6. **Score**：在给node排名时打分

7. **Reserve**：在node被分配给一个pod后执行，用来保留或取消保留某些资源

8. **Permit**：在执行bind node之前执行，用来组织或者延迟bind

9. **PreBind：**在执行bind node之前执行

10. **Bind：**执行bind（只有一个DefaultBinder实现了）

11. **PostBind**：bind成功后执行

`Pulgin`的`interface`定义位于`pkg/scheduler/framework/interface.go`，有上述提到的各种Plugin的接口定义

### 创建Scheduler

#### 生成SchedulingQueue

SchedulingQueue接收了lessFn（也就是排序函数），在SchedulingQueue中会实现pod的排序。后面的NextPod也是调用了SchedulingQueue的Pop方法

 ```Go
   lessFn := profiles[c.profiles[0].SchedulerName].QueueSortFunc()
   podQueue := internalqueue.NewSchedulingQueue(
     lessFn,
     c.informerFactory,
     internalqueue.WithPodInitialBackoffDuration(time.Duration(c.podInitialBackoffSeconds)*time.Second),
     internalqueue.WithPodMaxBackoffDuration(time.Duration(c.podMaxBackoffSeconds)*time.Second),
     internalqueue.WithPodNominator(nominator),
     internalqueue.WithClusterEventMap(clusterEventMap),
   )
 ```


#### Framework接口

从profiles生成profile map，关键代码位于`pkg/scheduler/factory.go`

 ```Go
 // create a scheduler from a set of registered plugins.
 func (c *Configurator) create() (*Scheduler, error) {
 // ......
   profiles, err := profile.NewMap(c.profiles, c.registry, c.recorderFactory,
     frameworkruntime.WithClientSet(c.client),
     frameworkruntime.WithInformerFactory(c.informerFactory),
     frameworkruntime.WithSnapshotSharedLister(c.nodeInfoSnapshot),
     frameworkruntime.WithRunAllFilters(c.alwaysCheckAllPredicates),
     frameworkruntime.WithPodNominator(nominator),
     frameworkruntime.WithCaptureProfile(frameworkruntime.CaptureProfile(c.frameworkCapturer)),
     frameworkruntime.WithClusterEventMap(clusterEventMap),
     frameworkruntime.WithParallelism(int(c.parallellism)),
   )
 // ......
   return &Scheduler{
     SchedulerCache:  c.schedulerCache,
     Algorithm:       algo,
     Profiles:        profiles,
     NextPod:         internalqueue.MakeNextPodFunc(podQueue),
     Error:           MakeDefaultErrorFunc(c.client, c.informerFactory.Core().V1().Pods().Lister(), podQueue, c.schedulerCache),
     StopEverything:  c.StopEverything,
     SchedulingQueue: podQueue,
   }, nil
 } 
 ```


其中profiles是个map （`type Map map[string]framework.Framework`），从`KubeSchedulerProfile`结构生成`framework.Framework`的关键代码位于`pkg/scheduler/profile/profile.go`

 ```Go
 // newProfile builds a Profile for the given configuration.
 func newProfile(cfg config.KubeSchedulerProfile, r frameworkruntime.Registry, recorderFact RecorderFactory,
   opts ...frameworkruntime.Option) (framework.Framework, error) {
   recorder := recorderFact(cfg.SchedulerName)
   opts = append(opts, frameworkruntime.WithEventRecorder(recorder))
   fwk, err := frameworkruntime.NewFramework(r, &cfg, opts...)
   if err != nil {
     return nil, err
   }
   return fwk, nil
 }
 ```


Framework接口的定义位于`pkg/scheduler/framework/interface.go`

#### 生成Plugins接口

关键过程位于`pkg/scheduler/framework/runtime/framework.go`

 ```Go
 // NewFramework initializes plugins given the configuration and the registry.
 func NewFramework(r Registry, profile *config.KubeSchedulerProfile, opts ...Option) (framework.Framework, error)
 ```


其中的参数`Registry`是个PluginFactory map

 ```Go
 type Registry map[string]PluginFactory
 ```


根据Registry可以生成pluginsMap，

 ```Go
 pluginsMap := make(map[string]framework.Plugin)
 ```


通过反射，将plugin注入到framework中的各种plugins

 ```Go
   for _, e := range f.getExtensionPoints(profile.Plugins) {
     if err := updatePluginList(e.slicePtr, e.plugins, pluginsMap); err != nil {
       return nil, err
     }
   }
 ```


`getExtensionPoints`以及`updatePluginList`的定义：

 ```Go
 func (f *frameworkImpl) getExtensionPoints(plugins *config.Plugins) []extensionPoint {
   return []extensionPoint{
     {plugins.PreFilter, &f.preFilterPlugins},
     {plugins.Filter, &f.filterPlugins},
     {plugins.PostFilter, &f.postFilterPlugins},
     {plugins.Reserve, &f.reservePlugins},
     {plugins.PreScore, &f.preScorePlugins},
     {plugins.Score, &f.scorePlugins},
     {plugins.PreBind, &f.preBindPlugins},
     {plugins.Bind, &f.bindPlugins},
     {plugins.PostBind, &f.postBindPlugins},
     {plugins.Permit, &f.permitPlugins},
     {plugins.QueueSort, &f.queueSortPlugins},
   }
 }
 
 func updatePluginList(pluginList interface{}, pluginSet config.PluginSet, pluginsMap map[string]framework.Plugin) error {
   plugins := reflect.ValueOf(pluginList).Elem()
   pluginType := plugins.Type().Elem()
   set := sets.NewString()
   for _, ep := range pluginSet.Enabled {
     pg, ok := pluginsMap[ep.Name]
     if !ok {
       return fmt.Errorf("%s %q does not exist", pluginType.Name(), ep.Name)
     }
 
     if !reflect.TypeOf(pg).Implements(pluginType) {
       return fmt.Errorf("plugin %q does not extend %s plugin", ep.Name, pluginType.Name())
     }
 
     if set.Has(ep.Name) {
       return fmt.Errorf("plugin %q already registered as %q", ep.Name, pluginType.Name())
     }
 
     set.Insert(ep.Name)
 
     newPlugins := reflect.Append(plugins, reflect.ValueOf(pg))
     plugins.Set(newPlugins)
   }
   return nil
 }
 ```


这样子Framework就拥有了各种plugins

### Scheduler执行过程

主函数就是`scheduleOne`这个方法。其余过程就不看了，主要看下那些plugins是怎么执行的。

#### 创建了CycleState

 ```Go
 state := framework.NewCycleState()
 ```


这个`CycleState`位于`pkg/scheduler/framework/cycle_state.go`，它主要记录一些key值

 ```Go
 type CycleState struct {
   mx      sync.RWMutex
   storage map[StateKey]StateData
   // if recordPluginMetrics is true, PluginExecutionDuration will be recorded for this cycle.
   recordPluginMetrics bool
 }
 ```


#### 执行调度过程

 ```Go
 scheduleResult, err := sched.Algorithm.Schedule(schedulingCycleCtx, fwk, state, pod)
 ```

`Algorithm`实际实现的地方位于`pkg/scheduler/core/generic_scheduler.go`中的这个结构体`genericScheduler`

首先进行 snapshot，获取集群信息

 ```Go
   if err := g.snapshot(); err != nil {
     return result, err
   }
 ```


##### 获取合适的节点

 ```Go
 feasibleNodes, diagnosis, err := g.findNodesThatFitPod(ctx, fwk, state, pod)
 ```


###### PreFilter

 ```Go
 s := fwk.RunPreFilterPlugins(ctx, state, pod)
 ```


###### Filter

用plugin进行Filter 

 ```Go
 status := fwk.RunFilterPluginsWithNominatedPods(ctx, state, pod, nodeInfo)
 ```


用extender进行Filter

 ```Go
 feasibleNodes, err = g.findNodesThatPassExtenders(pod, feasibleNodes, diagnosis.NodeToStatusMap)
 ```


##### 优先节点

###### PreScore

 ```Go
 preScoreStatus := fwk.RunPreScorePlugins(ctx, state, pod, nodes)
 ```


###### Score

 ```Go
 scoresMap, scoreStatus := fwk.RunScorePlugins(ctx, state, pod, nodes)
 ```


##### 选择节点

选择最高分的节点

 ```Go
 host, err := g.selectHost(priorityList)
 ```


##### Bind之前

###### Assume

 ```Go
 err = sched.assume(assumedPod, scheduleResult.SuggestedHost)
 ```


###### Reserve

 ```Go
 sts := fwk.RunReservePluginsReserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost);
 ```


###### Permit

 ```Go
 runPermitStatus := fwk.RunPermitPlugins(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
 ```


###### Unreserve

 ```Go
 fwk.RunReservePluginsUnreserve(schedulingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
 ```


##### 异步执行Bind

###### PreBind

 ```Go
 preBindStatus := fwk.RunPreBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
 ```


###### Bind

 ```Go
 go func() {
   // ......
   err := sched.bind(bindingCycleCtx, fwk, assumedPod, scheduleResult.SuggestedHost, state)
   // ......
 } 
 ```


###### PostBind

 ```Go
 fwk.RunPostBindPlugins(bindingCycleCtx, state, assumedPod, scheduleResult.SuggestedHost)
 ```

## Scheduler Extender（扩展点）

除了 Framework 插件，kube-scheduler 还支持通过 **Extender** 把调度决策外置给一个 HTTP 服务（`KubeSchedulerConfiguration.extenders`）。Extender 可以参与三个环节：

| 环节 | HTTP 端点 | 作用 |
|---|---|---|
| Filter | `/filter` | 在默认 Filter 之后进一步剔除节点（请求体含 Pod 与候选节点） |
| Prioritize | `/prioritize` | 给节点打分；分数按 extender 的 `weight` 叠加到默认打分上 |
| Bind | `/bind` | 由 extender 代替调度器执行绑定（常用于需要自定义分配结果的场景） |

典型配置字段：`urlPrefix`、`filterVerb`、`prioritizeVerb`、`bindVerb`、`nodeCacheCapable`、`httpTimeout`、`weight`、`managedResources`。Extender 是**进程外扩展**，因此排队、缓存与超时都由自己负责；`httpTimeout` 必须覆盖内部重试时间。

一个有意思的工程实践是 [HAMi](../AI_Infrastructure/hami.md)：它在 `/filter` 中自己完成设备级 `Fit` 与节点打分，然后**只返回一个节点名**，相当于把选点决策提前到 Filter（因为标准调度器只认识整数卡数，看不到显存/算力/GPU 拓扑）；`/bind` 则负责加节点锁、写入设备分配注解并完成 Binding。这也是 extender 模式「用 Filter 做选择」的典型变体。

