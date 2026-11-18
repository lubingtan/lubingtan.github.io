# CRI 与 kubelet 调用链：代码级调研笔记

> 基线（本地 checkout，固定 tag）：`cri-api` v0.37.2 = `d279f3cbb9d18b653d5fab12e187589914329c77`；`kubernetes` v1.37.2 = `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32`；`cri-o` v1.37.4 = `c11d3e70365ab7a671894258601d54091ec384cf`；`containerd` v2.4.2 = `b7a25261e029d68978bbf290df0a62fc819b3c51`。
> 路径简写：`cri-api/`=`.repos/upstream/cri-api`，`k8s/`=`.repos/upstream/kubernetes`，`crio/`=`.repos/upstream/cri-o`，`ctd/`=`.repos/upstream/containerd`。行号可用 `sed -n` 复核；链接全部用 commit SHA 固定。

## 0. 一句话结论

CRI 是 **kubelet 与容器运行时之间的 gRPC 契约**（proto + kubelet 侧客户端），不是运行时实现。kubelet 只讲 CRI；真正建 pause 容器、拉镜像、建/起容器的是 containerd 内置 CRI plugin 或 CRI-O。

## 1. CRI 是什么：两组 gRPC service

**结论**：CRI 定义在独立 module `k8s.io/cri-api`，客户端在 `k8s.io/cri-client`（v1.37 已不在 `pkg/kubelet/cri/remote`）。只有 `RuntimeService`（Pod/容器/exec/stats）和 `ImageService`（镜像）两组服务。官方明确它不是通用容器运行时 API，只服务 kubelet 与 `crictl`。

```proto
// cri-api/pkg/apis/runtime/v1/api.proto L23-30
service RuntimeService {
    rpc Version(VersionRequest) returns (VersionResponse) {}
    // RunPodSandbox creates and starts a pod-level sandbox. Runtimes must ensure
    // the sandbox is in the ready state on success.
    rpc RunPodSandbox(RunPodSandboxRequest) returns (RunPodSandboxResponse) {}
```

固定链接：[api.proto L23-L30](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L23-L30)

| RPC | 行号 | 说明 |
| --- | --- | --- |
| `Version` | 26 | 版本协商 |
| `RunPodSandbox` / `StopPodSandbox` / `RemovePodSandbox` | 30 / 40 / 45 | sandbox 生命周期 |
| `PodSandboxStatus` / `ListPodSandbox` | 48 / 50 | sandbox 查询 |
| `CreateContainer` / `StartContainer` | 66 / 68 | 容器创建、启动（两步） |
| `StopContainer` / `RemoveContainer` / `ContainerStatus` | 74 / 79 / 97 | 容器生命周期与查询 |
| `ExecSync` | 109 | 同步执行，gRPC 一元调用 |
| `Exec` / `Attach` / `PortForward` | 111 / 113 / 115 | **只返回 streaming URL** |
| `ContainerStats` / `PodSandboxStats` | 119 / 139 | 指标 |
| `UpdateRuntimeConfig` / `Status` | 158 / 161 | PodCIDR 下发、运行时健康 |
| `GetContainerEvents` | 186 | 事件流 |

`ImageService` 在 L230：`ListImages` L232、`ImageStatus` L249、`PullImage` L251（带 `AuthConfig`）、`RemoveImage` L262、`ImageFsInfo` L265。
固定链接：[RuntimeService L24-L227](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L24-L227)、[ImageService L229-L265](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L229-L265)

kubelet 依赖的是 Go 接口，`RuntimeService` 被拆成 `RuntimeVersioner`+`ContainerManager`+`PodSandboxManager`+`ContainerStatsManager`：

```go
// k8s/staging/src/k8s.io/cri-api/pkg/apis/services.go L118-L127
type RuntimeService interface {
	RuntimeVersioner
	ContainerManager
	PodSandboxManager
	ContainerStatsManager

	// UpdateRuntimeConfig updates runtime configuration if specified
	UpdateRuntimeConfig(ctx context.Context, runtimeConfig *runtimeapi.RuntimeConfig) error
```

固定链接：[services.go L118-L127](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/cri-api/pkg/apis/services.go#L118-L127)
gRPC 实现在 `k8s/staging/src/k8s.io/cri-client/pkg/remote_runtime.go` / `remote_image.go`；`pkg/kubelet/` 下已无 `cri/` 目录。

## 2. PodSandbox：pod 级 namespace/cgroup 的载体

**结论**：Pod 在 CRI 里分两级——先 `RunPodSandbox` 得到 sandbox（运行时用 pause 容器实现），再在其中 `CreateContainer`。sandbox 承载 pod 级 cgroup parent、namespace、DNS、hostname、log 目录、port mapping；容器只承载进程。

**重要更正**：v0.37.2 中 **`PodSandboxConfig` 没有 `runtime_handler` 字段**（L578-L625 全文只有 metadata/hostname/log_directory/dns_config/port_mappings/labels/annotations/linux/windows）。handler 属于 `RunPodSandboxRequest`，由 kubelet 作为独立参数传入。

```proto
// cri-api/.../api.proto L627-636
message RunPodSandboxRequest {
    PodSandboxConfig config = 1;
    // If the runtime handler is unknown, this request should be rejected.  An
    // empty string should select the default handler...
    // See https://git.k8s.io/enhancements/keps/sig-node/585-runtime-class
    string runtime_handler = 2;
}
```

固定链接：[PodSandboxConfig L578-L625](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L578-L625)、[RunPodSandboxRequest L627-L636](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L627-L636)

| 方向 | 结构体.字段 | 行号 |
| --- | --- | --- |
| 写（kubelet 传入） | `RunPodSandboxRequest.runtime_handler = 2` | 635 |
| 读（状态回读） | `PodSandboxStatus.runtime_handler = 9` | 717 |
| 读（列表回读） | `PodSandbox.runtime_handler = 7` | 777 |
| 写（按 handler 拉镜像） | `ImageSpec.runtime_handler = 19` | 969 |

固定链接：[PodSandboxStatus L695-L718](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L695-L718)、[PodSandbox L759-L778](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L759-L778)、[ImageSpec L955-L973](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L955-L973)

kubelet 侧确实把 handler 当第二个参数传：

```go
// k8s/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go L59-L71
	runtimeHandler := ""
	if m.runtimeClassManager != nil {
		runtimeHandler, err = m.runtimeClassManager.LookupRuntimeHandler(pod.Spec.RuntimeClassName)
		if err != nil { ... }
	}
	podSandBoxID, err := m.runtimeService.RunPodSandbox(ctx, podSandboxConfig, runtimeHandler)
```

固定链接：[kuberuntime_sandbox.go L59-L71](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go#L59-L71)
`LookupRuntimeHandler` 实现：`k8s/pkg/kubelet/runtimeclass/runtimeclass_manager.go` L61-L78（nil/"" → 默认 handler `""`，否则返回 `rc.Handler`）。[链接](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/runtimeclass/runtimeclass_manager.go#L61-L78)

**sandbox 是 cgroup/namespace 载体**：`generatePodSandboxLinuxConfig` 把 `GetPodCgroupParent(pod)` 写进 `LinuxPodSandboxConfig.CgroupParent`（L167-L170），namespace 选项由 `NamespacesForPod` 写入 L202-L206；`generatePodSandboxConfig`（L82-L160）填 Metadata/Hostname/LogDirectory/DnsConfig/PortMappings。[链接](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go#L167-L172)

**sandbox 由运行时创建（pause 容器）**，kubelet 甚至没有 pause 镜像常量（`grep -rn "PodInfraContainerImage\|pause image" pkg/kubelet` 无结果）：

```go
// crio/server/sandbox_run_linux.go L615-637（截取）
	pauseImage, err := s.config.ParsePauseImage()
	...
	podContainer, err := runtimeSvc.CreatePodSandbox(s.config.SystemContext,
		sboxName, sboxID, pauseImage, s.config.PauseImageAuthFile,
		containerName, kubeName, sbox.Config().GetMetadata().GetUid(),
		namespace, attempt, idMappingsOptions, labelOptions, privileged,
	)
```

containerd 同构：默认镜像 `DefaultSandboxImage = "registry.k8s.io/pause:3.10.2"`（`ctd/internal/cri/config/config.go` L73-L75），`criService.RunPodSandbox` 在 `internal/cri/server/sandbox_run.go` L54。
固定链接：[sandbox_run_linux.go L615-L637](https://github.com/cri-o/cri-o/blob/c11d3e70365ab7a671894258601d54091ec384cf/server/sandbox_run_linux.go#L615-L637)、[containerd config.go L73-L75](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/config/config.go#L73-L75)

## 3. 版本协商与 RuntimeConfig

**结论**：kubelet 只认 CRI v1，API 版本串 `"0.1.0"` 且**严格相等**，不匹配返回 `ErrVersionNotSupported`；`VersionResponse` 四个字段必须非空。另有 `RuntimeConfig` RPC 供 kubelet 启动时读 cgroup driver。

```go
// k8s/pkg/kubelet/kuberuntime/kuberuntime_manager.go L299-312
	typedVersion, err := kubeRuntimeManager.getTypedVersion(ctx)
	...
	// Only matching kubeRuntimeAPIVersion is supported now
	if typedVersion.Version != kubeRuntimeAPIVersion {
		logger.Error(err, "This runtime api version is not supported", ...)
		return nil, nil, ErrVersionNotSupported
	}
```

`kubeRuntimeAPIVersion = "0.1.0"`（同文件 L82）；`getTypedVersion` 调 `m.runtimeService.Version(ctx, kubeRuntimeAPIVersion)`（L402-L408）。VersionResponse 定义在 `api.proto` L273-L284（version / runtime_name / runtime_version / runtime_api_version）。
固定链接：[kuberuntime_manager.go L299-L312](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L299-L312)、[api.proto L273-L284](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L273-L284)

```go
// k8s/cmd/kubelet/app/server.go L1466-1479
		runtimeConfig, err = kubeDeps.RemoteRuntimeService.RuntimeConfig(ctx)
		if err != nil {
			s, ok := status.FromError(err)
			if !ok || s.Code() != codes.Unimplemented {
				time.Sleep(time.Second * 2); continue
			}
			legacyregistry.MustRegister(kubeletmetrics.CRILosingSupport)
			kubeletmetrics.CRILosingSupport.WithLabelValues("1.38.0").Inc()
```

固定链接：[server.go L1466-L1479](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/cmd/kubelet/app/server.go#L1466-L1479)
对应 proto `RuntimeConfigResponse.linux.cgroup_driver`（`SYSTEMD`/`CGROUPFS`，L2362-L2383）。[链接](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L2362-L2383)

## 4. 流式接口：gRPC 只返回 URL，数据流由 kubelet 反代

**结论**：`Exec`/`Attach`/`PortForward` 的 gRPC 调用不传数据，只返回 `url`。真正的 streaming server 由**运行时**提供；kubelet 的 `/exec`、`/attach`、`/portForward` 只是 `proxy.NewUpgradeAwareHandler` 反代到该 URL。同步执行用 `ExecSync`。v1.37 kubelet 已不再自建 streaming server（`grep -rn "streaming.NewServer"` 仅命中测试），接口注释里的 "or nil if the Kubelet will serve it" 是历史措辞。

```proto
// cri-api/.../api.proto L1640-1664（截取）
message ExecRequest {
    string container_id = 1;
    repeated string cmd = 2;
    bool tty = 3;
    bool stdin = 4;
    bool stdout = 5;
    bool stderr = 6;
}
message ExecResponse {
    // Fully qualified URL of the exec streaming server.
    string url = 1;
}
```

固定链接：[api.proto L1640-L1664](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L1640-L1664)

```go
// k8s/pkg/kubelet/server/server.go L1176-1182
	url, err := s.host.GetExec(request.Request.Context(), podFullName, params.podUID, params.containerName, params.cmd, *streamOpts)
	if err != nil { streaming.WriteError(err, response.ResponseWriter); return }
	var handler http.Handler = proxy.NewUpgradeAwareHandler(url, nil, false, true, &responder{})
```

调用链：`Kubelet.GetExec`（`kubelet_pods.go` L2839-L2848）→ `kubeGenericRuntimeManager.GetExec`（`kuberuntime_container.go` L1320-L1336）→ `remoteRuntimeService.Exec`（`remote_runtime.go` L746-L773）→ gRPC。`ExtendWebSocketsToKubelet`（1.36 Beta 默认 true）时还会做 V5 websocket↔SPDY 翻译（`server.go` L1146-L1157）。
固定链接：[server.go L1176-L1182](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/server/server.go#L1176-L1182)

运行时侧实现在 CRI-O：`Exec` handler 从内嵌的 cri-streaming server 取 URL 直接返回：

```go
// crio/server/container_exec.go L17-34（截取）
func (s *Server) Exec(ctx context.Context, req *types.ExecRequest) (*types.ExecResponse, error) {
	c, err := s.GetContainerFromShortID(ctx, req.GetContainerId())
	...
	url, err := monitorStreamingURL(ctx, s.Runtime().RuntimeStreamWebsockets,
		s.getSandbox(ctx, c.Sandbox()).RuntimeHandler(), "exec", ...,
		func() (string, error) {
			return s.Runtime().ServeExecContainer(ctx, c, req.GetCmd(), req.GetTty(), req.GetStdin(), req.GetStdout(), req.GetStderr())
		})
```

`crio/server/server.go` L628 `streaming.NewServer(streamServerConfig, s.stream)` + L636 `Start(true)`；`getExec/getAttach/getPortForward` 薄封装在 L139-L152。
固定链接：[container_exec.go L17-L34](https://github.com/cri-o/cri-o/blob/c11d3e70365ab7a671894258601d54091ec384cf/server/container_exec.go#L17-L34)、[server.go L139-L152](https://github.com/cri-o/cri-o/blob/c11d3e70365ab7a671894258601d54091ec384cf/server/server.go#L139-L152)

**模块迁移**：`k8s/staging/src/k8s.io/cri-streaming/README.md` 写明 legacy 路径 `k8s.io/kubelet/pkg/cri/streaming` 已移到 `k8s.io/cri-streaming/pkg/streaming`，无兼容 shim；`go.mod` L97-L99/L241-L243 已作为独立 module 引入。该目录初始 sparse checkout 未包含，需 `git -C .repos/upstream/kubernetes sparse-checkout add staging/src/k8s.io/cri-streaming`（本次已添加）。

**v1alpha2 已移除**：`cri-api/pkg/apis/runtime/` 下只有 `v1`，不要写 CRI 还有 v1alpha2/v1beta1。

## 5. kubelet → CRI 的真实调用链

**主干调用栈**（每层都是真实代码位置）：

```
podWorkers (pkg/kubelet/pod_workers.go:1319 podSyncer.SyncPod)
 └─ Kubelet.syncPod → kl.containerRuntime.SyncPod          (pkg/kubelet/kubelet.go:2267)
     └─ kubeGenericRuntimeManager.SyncPod                 (kuberuntime_manager.go:1583)
         ├─ computePodActions                             (决定 kill/keep/create)
         ├─ createPodSandbox                              (kuberuntime_sandbox.go:42)
         │   ├─ generatePodSandboxConfig
         │   ├─ runtimeClassManager.LookupRuntimeHandler
         │   └─ runtimeService.RunPodSandbox(cfg, handler)     ← CRI
         ├─ runtimeService.PodSandboxStatus               ← CRI（取 pod IP）
         └─ startContainer                                (kuberuntime_container.go:200)
             ├─ imagePuller.EnsureImageExists             ← 触发 PullImage
             ├─ runtimeService.CreateContainer            ← CRI
             └─ runtimeService.StartContainer             ← CRI
```

**启动期创建 client**：

```go
// k8s/pkg/kubelet/kubelet.go L413-421
	useStreaming := utilfeature.DefaultFeatureGate.Enabled(features.CRIListStreaming)
	if kubeDeps.RemoteRuntimeService, err = remote.NewRemoteRuntimeServiceBuilder().
		WithEndpoint(kubeCfg.ContainerRuntimeEndpoint).
		WithConnectionTimeout(kubeCfg.RuntimeRequestTimeout.Duration).
		WithTracerProvider(kubeDeps.TracerProvider).
		WithUseStreaming(useStreaming).
		Build(ctx); err != nil { return err }
```

`NewMainKubelet`（L454）把两个 client 传给 `kuberuntime.NewKubeGenericRuntimeManager`（L802-L830），并 `klet.streamingRuntime = runtime`（L849）。默认 endpoint `unix:///run/containerd/containerd.sock`（`pkg/kubelet/apis/config/v1beta1/defaults.go` L303-L305）。
固定链接：[kubelet.go L413-L421](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kubelet.go#L413-L421)、[defaults.go L303-L305](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/apis/config/v1beta1/defaults.go#L303-L305)

**SyncPod 是期望状态对齐**（先 `computePodActions` 算差异，再 kill/keep/create）：

```go
// k8s/pkg/kubelet/kuberuntime/kuberuntime_manager.go L1585-1588 / L1732
	// Step 1: Compute sandbox and container changes.
	podContainerChanges := m.computePodActions(ctx, pod, podStatus, restartAllContainers)
	...
		podSandboxID, msg, err = m.createPodSandbox(ctx, pod, podContainerChanges.Attempt)
```

固定链接：[kuberuntime_manager.go L1585-L1588](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L1585-L1588)、[L1732](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L1732)

**CRI client 的超时/重试**：

```go
// k8s/staging/src/k8s.io/cri-client/pkg/remote_runtime.go L308-322
func (r *remoteRuntimeService) RunPodSandbox(ctx context.Context, config *runtimeapi.PodSandboxConfig, runtimeHandler string) (string, error) {
	// Use 2 times longer timeout for sandbox operation (4 mins by default)
	timeout := r.timeout * 2
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := r.runtimeClient.RunPodSandbox(ctx, &runtimeapi.RunPodSandboxRequest{
		Config: config, RuntimeHandler: runtimeHandler,
	})
```

普通 RPC 超时 = `RuntimeRequestTimeout`（默认 2m），RunPodSandbox 2 倍即 4m。连接 backoff：`baseBackoffDelay=100ms`、`maxBackoffDelay=3s`（L67-L68、L194-L202）；unix socket 用 `insecure.NewCredentials()` + `WithAuthority("localhost")`（L171-L175）。每次调用另有 metrics 包装 `instrumentedRuntimeService`（`instrumented_services.go`）。
固定链接：[remote_runtime.go L308-L322](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/cri-client/pkg/remote_runtime.go#L308-L322)

**容器创建与启动是两个 RPC**：

```go
// k8s/pkg/kubelet/kuberuntime/kuberuntime_container.go L215 / L277 / L292
	imageRef, msg, err := m.imagePuller.EnsureImageExists(ctx, ref, pod, container.Image, pullSecrets, podSandboxConfig, podRuntimeHandler, container.ImagePullPolicy)
	...
	containerID, err := m.runtimeService.CreateContainer(ctx, podSandboxID, containerConfig, podSandboxConfig)
	...
	err = m.runtimeService.StartContainer(ctx, containerID)
```

`CreateContainerRequest.sandbox_config` 注释明确是 "same config that was passed to RunPodSandboxRequest ... just for easy reference ... immutable"（`api.proto` L1390-L1400）。
固定链接：[kuberuntime_container.go L200-L297](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_container.go#L200-L297)、[api.proto L1390-L1400](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L1390-L1400)

**镜像 handler 默认不传**：`ToRuntimeAPIImageSpec` 把 handler 写进 `ImageSpec.RuntimeHandler`，但受 gate 控制：

```go
// k8s/pkg/kubelet/kuberuntime/convert.go L75-78
	if utilfeature.DefaultFeatureGate.Enabled(features.RuntimeClassInImageCriAPI) {
		spec.RuntimeHandler = imageSpec.RuntimeHandler
	}
```

`RuntimeClassInImageCriAPI` 自 1.29 起 Alpha、默认 false（`pkg/features/kube_features.go` L2087-L2089）。
固定链接：[convert.go L75-L78](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/convert.go#L75-L78)、[kube_features.go L2087-L2089](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L2087-L2089)

**其它真实调用点**：`UpdatePodCIDR` → `UpdateRuntimeConfig{NetworkConfig{PodCidr}}`（`kuberuntime_manager.go` L2309-L2322，proto L1826-L1834）；`GetPodStatus` → `ListPodSandbox`+`ListContainers`（`kuberuntime_container.go` L645/L649）；`ReopenContainerLog` 由日志轮转调用（`pkg/kubelet/logs/container_log_manager.go` L249）；`GetContainerEvents` 由 evented PLEG 消费（`pkg/kubelet/pleg/evented.go` L85）；`Status` 对应同名 RPC。

## 6. 历史与生态

**结论**：dockershim 是 kubelet **内嵌**的 Docker 的 CRI 适配层，让 kubelet 直接依赖 docker；KEP-2221 决定移除，v1.20 deprecated，**v1.24 正式移除**。今天两大 CRI 实现是 containerd 内置 CRI plugin（`ctd/internal/cri`）与 CRI-O（`crio/server`），都是独立进程、通过 unix socket 暴露 CRI。Docker 本身不是 CRI 实现，要走 CRI 需要 `cri-dockerd`。CRI 是 K8s 上游 API：`cri-api` 是 `kubernetes/staging/src/k8s.io/cri-api` 的只读发布镜像，开发仍在 kubernetes/kubernetes。

```go
// ctd/internal/cri/server/version.go L35-43
func (c *criService) Version(ctx context.Context, r *runtime.VersionRequest) (*runtime.VersionResponse, error) {
	return &runtime.VersionResponse{
		Version:           kubeAPIVersion,
		RuntimeName:       containerName,
		RuntimeVersion:    version.Version,
		RuntimeApiVersion: constants.CRIVersion,
	}, nil
}
```

固定链接：[containerd version.go L35-L43](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/version.go#L35-L43)

外部文档（非代码结论）：[KEP-2221: Removing dockershim from kubelet](https://www.kubernetes.dev/resources/keps/2221/)（SIG Node，v1.24 implemented）、[Dockershim Removal FAQ](https://kubernetes.io/blog/2022/02/17/dockershim-faq/)、[Kubernetes 1.24 release announcement](https://kubernetes.io/blog/2022/05/03/kubernetes-1-24-release-announcement/)、[CRI 官方文档](https://kubernetes.io/docs/concepts/containers/cri/)、[Introducing CRI（2016）](https://kubernetes.io/blog/2016/12/container-runtime-interface-cri-in-kubernetes/)、[CRI API version skew policy](https://kubernetes.dev/docs/code/cri-api-version-skew-policy/)。

## 7. 边界澄清：CRI ≠ containerd ≠ OCI

```
kubelet
  │  CRI (gRPC, k8s.io/cri-api)          ← 本文主题
  ▼
containerd / CRI-O                       ← CRI 实现（pause/sandbox、CNI、镜像）
  │  OCI runtime spec + runc/runsc/kata  ← namespace/cgroup/进程创建
  ▼
容器进程
```

- **CRI** = kubelet ↔ runtime 的接口，不是运行时，也不是容器/镜像规范。
- **containerd / CRI-O** = CRI 的实现，它们再调 OCI runtime（runc 等）。
- **OCI**（runtime-spec / image-spec）= 容器进程与镜像标准，CRI 不直接依赖它。
- kubelet **不直接调用 runc**：`grep -rn "opencontainers/runc" pkg/kubelet` 只命中注释里的 URL（如 `kuberuntime_sandbox.go` L376），无 import。

## 8. 1.36/1.37 的新变化（别当核心链路）

- **CRI list streaming（KEP-5825）**：`StreamPodSandboxes` L63、`StreamContainers` L94、`StreamImages` L245，规避大节点 List 的 gRPC 消息上限；`CRIListStreaming` gate **1.36 Alpha、默认 false**（`kube_features.go` L1394-L1396），client 在 `Recv()` 收到 `Unimplemented` 时自动回退 unary（`remote_runtime.go` L460-L468）。
- **cri-streaming 模块独立**：路径迁移见 §4。
- **RuntimeConfig 强制化**：不支持的运行时会命中 `CRILosingSupport`，label 为 `"1.38.0"`（`cmd/kubelet/app/server.go` L1476-L1479），即计划 1.38 收紧。
- `CheckpointPod` L175 / `RestorePod` L183 / `UpdatePodSandboxResources` L226 等较新 RPC 均非启动主干。

固定链接：[api.proto L51-L63](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L51-L63)、[kube_features.go L1394-L1396](https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/features/kube_features.go#L1394-L1396)

## 9. 最容易讲错的点

1. `PodSandboxConfig.runtime_handler` **不存在**；handler 是 `RunPodSandboxRequest` 字段 2，是 `RunPodSandbox()` 的第二个参数。
2. `ImageSpec.runtime_handler` **默认不填**（`RuntimeClassInImageCriAPI` 仍 Alpha 默认关）；"kubelet 总按 handler 拉镜像"是错的。
3. Exec/Attach/PortForward **不是 gRPC 双向流**：gRPC 只回 URL，数据流是 kubelet 反代到运行时的 HTTP(S) streaming server；`ExecSync` 才是 gRPC 同步调用。
4. pause 容器**不是 kubelet 创建的**，kubelet 连 pause 镜像常量都没有；它是 CRI 实现的配置。
5. sandbox 不只是"一个 pause 进程"，而是 pod 级 cgroup parent + namespace + DNS/hostname/log/portmapping 的载体。
6. `CreateContainerRequest.SandboxConfig` 不是"再配置一次沙箱"，是同一份 immutable 配置的引用。
7. **CRI 只剩 v1**，v1alpha2 已移除。
8. kubelet 不调用 runc/containerd 原生 API，只讲 CRI；containerd ≠ CRI（它内部有 CRI plugin）。
9. `SyncPod` 是期望状态 reconcile，不是"收到事件就建容器"。
10. `Stream*` RPC 默认关闭（Alpha），不能当 CRI 必选能力。

## 10. 关键结论（10 条）

1. CRI = `k8s.io/cri-api` 的 proto + `k8s.io/cri-client` 的 gRPC 客户端；只有 `RuntimeService`（L24）和 `ImageService`（L230）两个 service。
2. kubelet 在 `PreInitRuntimeService`（`kubelet.go` L407-L434）建 client，默认连 `unix:///run/containerd/containerd.sock`。
3. Pod 级抽象是 PodSandbox：先 `RunPodSandbox`，再 `CreateContainer`/`StartContainer`。
4. `runtime_handler` 属于 `RunPodSandboxRequest`（L635），不属于 `PodSandboxConfig`；回读在 `PodSandboxStatus`（L717）/`PodSandbox`（L777）。
5. RuntimeClass → handler 在 `kuberuntime_sandbox.go` L59-L71 解析并作为独立参数传给 `RunPodSandbox`。
6. 版本协商：kubelet 只接受 `"0.1.0"`（`kuberuntime_manager.go` L82/L307），VersionResponse 四字段必须非空。
7. 超时：普通 RPC 2m，RunPodSandbox 4m；gRPC 连接 backoff 100ms–3s。
8. Exec/Attach/PortForward 只返回 URL；kubelet 用 `proxy.NewUpgradeAwareHandler` 反代；streaming server 由运行时提供（CRI-O 内嵌 `k8s.io/cri-streaming`）。
9. dockershim v1.24 移除（KEP-2221）；现由 containerd CRI plugin / CRI-O 实现 CRI，Docker 需 `cri-dockerd`。
10. CRI ≠ containerd ≠ OCI；kubelet 不直接调 runc，OCI runtime 由 CRI 实现调用。

## 11. 待核实

- containerd CRI plugin 的 streaming server 实现细节未逐行核对（本次只核到 `Version`/`RunPodSandbox`/默认 pause 镜像）。待核实：containerd 是复用 `k8s.io/cri-streaming` 还是自研。
- `RuntimeConfig` 的"1.38 强制"仅见日志/指标字符串（`CRILosingSupport` label），未见 KEP 文本；待核实废弃计划。
- `Kubelet.GetExec` 的 doc 注释仍写 "or nil if the Kubelet will serve it"，与 v1.37 无自建 streaming server 的现状不一致，未找到删注释的 PR；待核实是否有边缘路径仍期望 nil。
