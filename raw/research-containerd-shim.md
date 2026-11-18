# containerd 架构 / CRI plugin / shim v1-v2 调研笔记

> 上游（本地 clone 固定 tag）：containerd `v2.4.2` = `b7a25261e029d68978bbf290df0a62fc819b3c51`；runc `v1.5.3` = `46365c62967c76a765a5e347f48f0c7b3b571fe9`；cri-api `kubernetes-1.37.2` = `d279f3cbb9d18b653d5fab12e187589914329c77`。链接格式 `https://github.com/containerd/containerd/blob/<sha>/<path>#Lx-Ly`，行号均以本地 `nl -ba`/`grep -n` 核对。
> **布局提醒**：2.x 与 1.x/旧博客不同——shim 客户端在 `core/runtime/v2/`（1.x 为 `runtime/v2/`），runc shim 在 `cmd/containerd-shim-runc-v2/`，CRI 在 `plugins/cri/` + `internal/cri/`。

## 0. 一页速览

| 层 | 组件 | 职责 | 调用方 |
|---|---|---|---|
| 编排 | kubelet | 决定 Pod/容器，调 CRI | — |
| CRI 实现 | containerd 内 CRI plugin | CRI 语义 → pause 容器、CNI、镜像、运行时选择 | kubelet |
| 守护进程 | containerd | 内容/镜像/快照/metadata 管理，把"跑容器"派给 shim | CRI / ctr / nerdctl |
| 伴生进程 | `containerd-shim-runc-v2` | 持有 stdio、当容器父进程与 reaper、提供 ttrpc Task API | containerd |
| OCI 运行时 | runc | 按 OCI spec 建 namespace/cgroup 并 exec 容器进程 | shim（一次性） |

**一句话**：containerd 管"容器之外的一切 + 编排"，shim 管"容器进程本身"，runc 只负责把进程按 OCI spec 造出来。

## 1. containerd 是什么

### 1.1 节点守护进程，本身不是 OCI 运行时

**结论**：containerd 是单机容器守护进程，负责镜像传输/存储、快照、执行与监督；它不直接实现隔离，而把执行层委托给 runc 这类 runtime engine，所以 containerd ≠ runc。网络与日志持久化也刻意划在 containerd 之外。

**证据**：`docs/runtime-v2.md:5-11`

```text
containerd, the daemon, does not directly launch containers. Instead, it acts as a higher-level manager
or hub for coordinating the activities of containers and content, that lower-level
programs, called "runtimes", actually implement to start, stop and manage containers,
either individual containers or groups of containers, e.g. Kubernetes pods.
...
For example, containerd will retrieve container image config and its content as layers, use the snapshotter to lay it out on disk, set up
the container's rootfs and config, and then launch a runtime that will create/start/stop the container.
```

[🔗 docs/runtime-v2.md#L5-L11](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L5-L11)

边界见 [SCOPE.md#L42-L45](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/SCOPE.md#L42-L45)：networking/logging 为 out of scope，容器 STDIO 交给客户端（这正是 shim 持有 stdio 的原因）；定位见 [README.md#L11-L15](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/README.md#L11-L15)。

### 1.2 plugin 架构：一切能力都是 plugin

**结论**：containerd 按 "type + id" 注册 plugin，完整 ID 为 `io.containerd.<area>.v<api>.<id>`。content store、snapshotter、metadata、task service、event service、shim manager 都是可替换 plugin；CRI 也只是其中一个 gRPC plugin。

**证据**：`plugins/types.go:25-35`

```go
const (
	InternalPlugin plugin.Type = "io.containerd.internal.v1"
	RuntimePlugin plugin.Type = "io.containerd.runtime.v1"
	RuntimePluginV2 plugin.Type = "io.containerd.runtime.v2"
	ServicePlugin plugin.Type = "io.containerd.service.v1"
	GRPCPlugin plugin.Type = "io.containerd.grpc.v1"
```

（为省行数去掉了逐行注释，原文见链接）

[🔗 plugins/types.go#L25-L35](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/types.go#L25-L35)

对应注册处：content（[plugins/content/local](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/content/local)）、snapshotter（[plugins/snapshots/overlay](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/snapshots/overlay)）、metadata（[plugins/metadata](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/metadata)）、task（[plugins/services/tasks](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/services/tasks)）、event（[plugins/services/events](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/services/events)）、shim manager（[core/runtime/v2/shim_manager.go](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/shim_manager.go)）。`docs/PLUGINS.md:9-14` 的 "smart client" 模式（容器 spec/registry 交互放客户端，daemon 只给原语）见 [链接](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/PLUGINS.md#L9-L14)。

### 1.3 namespace：多租户逻辑分区

**结论**：所有 containerd API 都带 namespace；镜像内容按 digest 共享，名字与 metadata 按 namespace 隔离。CRI 固定用 `k8s.io`，所以 `ctr` 不加 `-n k8s.io` 看不到 Kubernetes 的容器。

**证据**：`docs/namespaces.md:3-7`

```text
containerd offers a fully namespaced API so multiple consumers can all use a single containerd instance without conflicting with one another.
Namespaces allow multi-tenancy within a single daemon. This removes the need for the common pattern of using nested containers to achieve this separation.
Consumers are able to have containers with the same names but with settings and/or configurations that vary drastically.
For example, system or infrastructure level containers can be hidden in one namespace while user level containers are kept in another.
Underlying image content is still shared via content addresses but image names and metadata are separate per namespace.
```

[🔗 docs/namespaces.md#L3-L7](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/namespaces.md#L3-L7)（"不是安全边界"见 [#L9](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/namespaces.md#L9)）；CRI 硬编码 `k8s.io` 见 [constants.go#L19-L23](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/constants/constants.go#L19-L23)。

## 2. containerd 的 CRI plugin

### 2.1 架构：kubelet → CRI plugin → containerd internals

**结论**：containerd 的 CRI 只是它的一个 plugin（gRPC 服务）：建 netns 并用 CNI 配置、起 pause 容器（sandbox）、拉镜像、再起业务容器，全程复用 containerd internal。

**证据**：`docs/cri/architecture.md:10-17`

```text
* Kubelet calls the `cri` plugin, via the CRI runtime service API, to create a pod;
* `cri` creates the pod’s network namespace, and then configures it using CNI;
* `cri` uses containerd internal to create and start a special [pause container](...) (the sandbox container) and put that container inside the pod’s cgroups and namespace (steps omitted for brevity);
* Kubelet subsequently calls the `cri` plugin, via the CRI image service API, to pull the application container image;
* `cri` further uses containerd to pull the image if the image is not present on the node;
* Kubelet then calls `cri`, via the CRI runtime service API, to create and start the application container inside the pod using the pulled container image;
* `cri` finally uses containerd internal to create the application container, put it inside the pod’s cgroups and namespace, then to start the pod’s new application container.
```

[🔗 docs/cri/architecture.md#L10-L17](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/architecture.md#L10-L17)（"implementation of Kubernetes CRI" 见 [#L4](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/architecture.md#L4)）

### 2.2 containerd 2.x 的 CRI plugin ID 变化（最容易讲错）

**结论**：2.x 把 CRI 内部拆成 `io.containerd.cri.v1.runtime` 与 `io.containerd.cri.v1.images` 两个子插件；但**对外 gRPC 入口仍叫 `io.containerd.grpc.v1.cri`**。所以 TOML 里 `[plugins.'io.containerd.cri.v1.runtime']`（runtimes/CNI）和 `[plugins.'io.containerd.cri.v1.images']`（snapshotter/registry）并存，而 `grpc.v1.cri` 只剩 streaming/TCP 少量选项；1.x 把全部 CRI 配置塞进 `grpc.v1.cri` 的写法在 config version 3 会被迁移。

**证据 1**：子插件注册（type `io.containerd.cri.v1` + ID `runtime` = 全 ID），`plugins/cri/runtime/plugin.go:46-57`

```go
	// Base plugin that other CRI services depend on.
	registry.Register(&plugin.Registration{
		Type:   plugins.CRIServicePlugin,
		ID:     "runtime",
		Config: &config,
		Requires: []plugin.Type{
			plugins.WarningPlugin,
		},
		ConfigMigration: configMigration,
		InitFn:          initCRIRuntime,
	})
}
```

[🔗 plugins/cri/runtime/plugin.go#L46-L57](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/cri/runtime/plugin.go#L46-L57)；type 定义 [plugins/types.go#L76-L77](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/types.go#L76-L77)，images 侧注册 [plugins/cri/images/plugin.go#L45-L48](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/cri/images/plugin.go#L45-L48)。

**证据 2**：官方 config 指南确认 version 3 改了 plugin ID，`docs/cri/config.md:225-228`

```toml
# containerd has several configuration versions:
# - Version 3 (Recommended for containerd 2.x): Introduced in containerd 2.0.
#   Several plugin IDs have changed in this version.
# - Version 2 (Recommended for containerd 1.x): Introduced in containerd 1.3.
```

[🔗 docs/cri/config.md#L225-L228](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L225-L228)

**证据 3**：plugin ID 变了，磁盘目录刻意保留旧名以免升级丢数据，`plugins/cri/runtime/plugin.go:77-81`

```go
	// For backward compatibility, we have to keep the rootDir and stateDir the same as before.
	containerdRootDir := filepath.Dir(ic.Properties[plugins.PropertyRootDir])
	rootDir := filepath.Join(containerdRootDir, "io.containerd.grpc.v1.cri")
```

[🔗 plugins/cri/runtime/plugin.go#L77-L81](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/plugins/cri/runtime/plugin.go#L77-L81)

### 2.3 RunPodSandbox：pause 容器 + CNI + runtime 选择

**结论**：`RunPodSandbox` 按 `RuntimeHandler` 解析 runtime 配置、建 netns/CNI、把 sandbox metadata 写入 sandbox store，再 `CreateSandbox`/`StartSandbox` 交给 sandboxer。2.x 默认 sandboxer 为 `podsandbox`：用 containerd client `NewContainer` + `NewTask` 创建 pause 容器，并把 sandbox netns 注入其 OCI spec；pause 镜像由 CRI 层预拉（`disable_pause_image_pull=true` 可交给 runtime 自己管）。

**证据**：podsandbox 创建 pause 容器，`internal/cri/server/podsandbox/sandbox_run.go:205-214`

```go
	opts := []containerd.NewContainerOpts{
		containerd.WithSnapshotter(sandboxSnapshotter),
		customopts.WithNewSnapshot(id, pauseImage, !c.imageConfig.DisableSnapshotAnnotations, snapshotterOpt...),
		containerd.WithSpec(spec, specOpts...),
		containerd.WithContainerLabels(sandboxLabels),
		containerd.WithContainerExtension(crilabels.SandboxMetadataExtension, &metadata),
		containerd.WithRuntime(ociRuntime.Type, podSandbox.Runtime.Options),
	}

	container, err := c.client.NewContainer(ctx, id, opts...)
```

[🔗 podsandbox/sandbox_run.go#L205-L214](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/podsandbox/sandbox_run.go#L205-L214)

handler → runtime 配置在 [sandbox_run.go#L117-L123](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/sandbox_run.go#L117-L123)；pause 容器 task 创建于 [#L257-L261](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/podsandbox/sandbox_run.go#L257-L261)；netns 注入见 [sandbox_run_linux.go#L80-L86](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/podsandbox/sandbox_run_linux.go#L80-L86)；pause 镜像预拉条件见 [sandbox_run.go#L298-L305](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/sandbox_run.go#L298-L305)。

### 2.4 CreateContainer 与 StartContainer 的分工

**结论**：CRI `CreateContainer` 只创建 containerd **container**（快照 + OCI spec + `WithRuntime`，runtime 继承 sandbox 的 handler，见 [container_create.go#L379-L390](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/container_create.go#L379-L390)）；真正的 `NewTask`（从而拉起 shim）在 `StartContainer`。业务容器的 shim 是 start 阶段才出现的。

**证据**：`internal/cri/server/container_start.go:146-149`

```go
	task, err := container.NewTask(ctx, ioCreation, taskOpts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create containerd task: %w", err)
	}
```

[🔗 container_start.go#L146-L149](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/container_start.go#L146-L149)（随后 `task.Start(ctx)` 见 [#L187-L190](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/container_start.go#L187-L190)）

## 3. shim 为什么存在（讲透）

### 3.1 目的：容器生命周期与 containerd 解耦

**结论**：shim 的第一目的不是"安全"或"性能"，而是**让容器不依赖 containerd 存活**：containerd 升级/重启/崩溃不杀容器，退出码与 stdio 仍有人接管，containerd 回来后重新接上。systemd 的 `KillMode=process` 是配套运维契约。

**证据**：`docs/ops.md:83-87`

```text
`KillMode` handles when containerd is being shut down.
By default, systemd will look in its named cgroup and kill every process that it knows about for the service.
This is not what we want.
As ops, we want to be able to upgrade containerd and allow existing containers to keep running without interruption.
Setting `KillMode` to `process` ensures that systemd only kills the containerd daemon and not any child processes such as the shims and containers.
```

[🔗 docs/ops.md#L83-L87](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/ops.md#L83-L87)（unit 文件同样配置，[containerd.service#L24-L27](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/containerd.service#L24-L27)）

设计文档列出 shim 职责：容器不绑定 containerd 生命周期；shim 是容器进程直接父进程、持有 stdio/pty、写退出码、reap 子进程（[docs/historical/design/lifecycle.md#L3](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/historical/design/lifecycle.md#L3)、[#L12](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/historical/design/lifecycle.md#L12)）。注：该文是 1.x 的"每容器一 shim"设计，v2 允许多容器共用一个 shim（§4.2），四项职责不变；其 "re-parented to the system's init" 与 2.x 实际进程树有出入（§8）。

### 3.2 僵尸回收：shim 是 sub-reaper

**结论**：容器进程（尤其共享 PID namespace 或 `runc exec` 产生的）可能失去父进程，内核把它们 reparent 给最近的 `PR_SET_CHILD_SUBREAPER` 祖先进程。shim 启动时 `SetSubreaper(1)` 并监听 `SIGCHLD` 调 `reaper.Reap()`，避免容器内孤儿进程变僵尸。

**证据**：`pkg/shim/shim_linux.go:29-31`

```go
func subreaper() error {
	return reaper.SetSubreaper(1)
}
```

[🔗 pkg/shim/shim_linux.go#L29-L31](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/shim/shim_linux.go#L29-L31)；`SIGCHLD` 注册见 [shim_unix.go#L38-L46](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/shim/shim_unix.go#L38-L46)；`Reap()` 见 [pkg/sys/reaper/reaper_unix.go#L63-L79](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/sys/reaper/reaper_unix.go#L63-L79)；含"跨 namespace 不 reparent"限制的说明见 [docs/runtime-v2.md#L583-L586](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L583-L586)。

### 3.3 持有 stdio/TTY 并转发

**结论**：容器 stdin/stdout/stderr 的 FIFO/pipe/console 由 shim 打开并长期持有，containerd 只在 `CreateTaskRequest` 里传路径；TTY resize 也依赖 shim 持有 pty master。容器输出因此不因 containerd 重启中断。

**证据**：`cmd/containerd-shim-runc-v2/process/io.go:104-110`

```go
	switch u.Scheme {
	case "fifo":
		pio.copy = true
		pio.io, err = runc.NewPipeIO(ioUID, ioGID, withConditionalIO(stdio))
	case "binary", "binary-v2":
		pio.io, err = NewBinaryIO(ctx, id, u)
```

[🔗 process/io.go#L104-L110](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/process/io.go#L104-L110)；CRI 侧 FIFO 创建 `cio.WithNewFIFOs` 见 [container_create.go#L352-L360](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/container_create.go#L352-L360)；IO scheme 列表见 [docs/runtime-v2.md#L498-L507](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L498-L507)；ttrpc 省 http 栈、二进制更小见 [docs/runtime-v2.md#L575-L581](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L575-L581)。

### 3.4 把运行时实现隔离在独立进程：shim + engine

**结论**：containerd 只跟 shim 的 ttrpc socket 对话，具体 engine 由 shim fork/exec（runc、crun、runsc…）。新增 OCI 运行时只需换 engine 或写新 shim，不动 containerd；shim 挂掉也不连带 daemon。

**证据**：`docs/runtime-v2.md:49-56`

```text
The separate "shim+engine" pattern is used because it makes it easier to integrate distinct runtimes implementing a specific runtime
engine spec, such as the [OCI runtime spec](https://github.com/opencontainers/runtime-spec).
The ttRPC protocol can be handled via one runtime shim, while distinct runtime engine implementations can
be used, as long as they implement the OCI runtime spec.
...
As this is a runtime _engine_, it is not invoked directly by containerd; instead, it is invoked by a shim, which listens on the socket and invokes the runtime engine.
```

[🔗 docs/runtime-v2.md#L49-L56](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L49-L56)

### 3.5 containerd 重启后 re-adopt：靠 bundle 里的 bootstrap.json

**结论**：每次建 task，containerd 把 shim 返回的 `BootstrapResult`（protocol+address）写入 bundle 的 `bootstrap.json`（老版本为 `address` 文件）。containerd 启动时扫描 state 目录各 bundle，读回地址重连 shim，用 `Pids()` 判断 shim 是否还养着进程，连不上则 `shim delete` 清理。因此重启 containerd 只重建客户端连接，不重建容器。

**证据 1**：写入位置，`core/runtime/v2/binary.go:139-142`

```go
	// Save bootstrap configuration (so containerd can restore shims after restart).
	if err := writeBootstrapParams(filepath.Join(b.bundle.Path, "bootstrap.json"), params); err != nil {
		return nil, fmt.Errorf("failed to write bootstrap.json: %w", err)
	}
```

[🔗 core/runtime/v2/binary.go#L139-L142](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/binary.go#L139-L142)

**证据 2**：启动时加载已有 shim，`core/runtime/v2/shim_load.go:37-46`

```go
// LoadExistingShims loads existing shims from the path specified by stateDir
// rootDir is for cleaning up the unused paths of removed shims.
func (m *ShimManager) LoadExistingShims(ctx context.Context, stateDir string, rootDir string) error {
	nsDirs, err := os.ReadDir(stateDir)
	if err != nil {
		return err
	}
	for _, nsd := range nsDirs {
		if !nsd.IsDir() {
			continue
		}
```

[🔗 shim_load.go#L37-L46](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/shim_load.go#L37-L46)；调用点 [task_manager.go#L102-L104](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/task_manager.go#L102-L104)；老 shim 从 `address` 文件迁移见 [shim_manager.go#L392-L413](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/shim_manager.go#L392-L413)。

## 4. shim v1 vs v2

### 4.1 v1：每容器一个 shim 进程 + 老 Shim API（2.0 已删）

**结论**：v1（`io.containerd.runtime.v1.linux` / `io.containerd.runc.v1`）时代，containerd 为每个容器拉起一个 `containerd-shim`，通过老的 Shim API 暴露 create/start/exec/delete；容器与 shim 一一对应。containerd 2.0 已彻底移除 v1。

**证据**：`docs/containerd-2.0.md:127-129`

```text
### `io.containerd.runtime.v1.linux` and `io.containerd.runc.v1` have been removed

Deprecated in containerd v1.4, support for the Runtime V1 (`io.containerd.runtime.v1.linux`) and Runc V1 (`io.containerd.runc.v1`) shims have been removed. Users should migrate to use `io.containerd.runc.v2` containerd shim instead.
```

[🔗 docs/containerd-2.0.md#L127-L129](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/containerd-2.0.md#L127-L129)

弃用表见 [RELEASES.md#L606-L607](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/RELEASES.md#L606-L607)；"一容器一 shim"的历史形态见 [docs/historical/cri/proposal.md#L9](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/historical/cri/proposal.md#L9)。

> **待核实**：v1 的 gRPC Shim 服务定义（历史 `containerd.shim.v1` 系列 proto）已随 v1 删除，v2.4.2 树内无法引用；"v1 用 gRPC Shim 接口"只能由历史文档与移除说明间接佐证，需回 v1.x 分支核对服务名与字段。

### 4.2 v2：统一二进制 + ttrpc Task 服务 + FIFO

**结论**：v2 把 shim 抽象为 ttrpc 服务：containerd 由 runtime 名推出二进制名（`io.containerd.runc.v2` → `containerd-shim-runc-v2`），exec 它并传启动参数，shim 返回自己的 ttrpc 地址，之后 containerd 用 `containerd.task.v2/v3.Task` 的 `Create/Start/Delete/State/...` 管理容器。一个 shim 可服务多个容器（同一 pod 按 `io.kubernetes.cri.sandbox-id` 分到同一 shim）。

**证据 1**：runtime 名 → 二进制名，`pkg/shim/util.go:41-49`

```go
func BinaryName(runtime string) string {
	// runtime name should format like $prefix.name.version
	parts := strings.Split(runtime, ".")
	if len(parts) < 2 || parts[0] == "" {
		return ""
	}

	return fmt.Sprintf(shimBinaryFormat, parts[len(parts)-2], parts[len(parts)-1])
}
```

[🔗 pkg/shim/util.go#L41-L49](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/shim/util.go#L41-L49)（`shimBinaryFormat = "containerd-shim-%s-%s"`，[util_unix.go#L46](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/shim/util_unix.go#L46)）

**证据 2**：统一入口与 Task 服务，`cmd/containerd-shim-runc-v2/main.go:29-31`、`api/runtime/task/v3/shim.proto:29-33`

```go
func main() {
	shim.RunShim(context.Background(), manager.NewShimManager("io.containerd.runc.v2"))
}
```

```text
// Shim service is launched for each container and is responsible for owning the IO
// for the container and its additional processes.  The shim is also the parent of
// each container and allows reattaching to the IO and receiving the exit status
// for the container processes.
service Task {
```

[🔗 main.go#L29-L31](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/main.go#L29-L31) · [🔗 shim.proto#L29-L33](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/api/runtime/task/v3/shim.proto#L29-L33)；17 个 RPC 完整列表见 [#L33-L51](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/api/runtime/task/v3/shim.proto#L33-L51)

> **版本容易讲错**：旧资料写 ttrpc 暴露 `containerd.task.v2.Task`，但 2.4.2 默认客户端是 **`containerd.task.v3`**（`CurrentShimVersion = 3`，[shim.go#L234](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/shim.go#L234)）。v3 与 v2 的 RPC/字段目前只差 package 名，v3 随 streaming I/O 引入；v2 由 `ttrpcV2Bridge` 兼容（[bridge.go#L61-L75](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/bridge.go#L61-L75)），runc shim 写 `params.Version = 3`（[manager_linux.go#L187-L190](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/manager/manager_linux.go#L187-L190)）。**"shim v2 架构" ≠ "task API v2"**。

### 4.3 `start` 子命令：legacy flags + 2.3+ Bootstrap 协议

**结论**：containerd 调 shim 的方式是 `exec <shim> <flags> start`，`cwd` 设为 bundle。2.3 起配置改从 stdin 读 protobuf `BootstrapParams`、stdout 回 `BootstrapResult`；旧 `-namespace/-address/-publish-binary/-id` 与环境变量仍保留但已 deprecated。`delete` 子命令用于 containerd 连不上时清理。

**证据**：`core/runtime/v2/command.go:78-86`（拼参数）

```go
	args := []string{
		"-namespace", ns,
		"-address", config.GRPCAddress,
		"-publish-binary", self,
		"-id", config.ID,
	}
	if config.BundlePath != "" {
		args = append(args, "-bundle", config.BundlePath)
	}
```

[🔗 command.go#L78-L86](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/command.go#L78-L86)（`args = append(args, config.Action)` 见 [#L95](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/command.go#L95)）

BootstrapParams 写 stdin 见 [command.go#L130-L151](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/command.go#L130-L151)，字段含义见 [bootstrap.proto#L42-L78](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/api/runtime/bootstrap/v1/bootstrap.proto#L42-L78)。文档：[Bootstrap protocol (2.3+) #L197-L209](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L197-L209)、[legacy 协议 #L229-L262](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L229-L262)、[delete #L264-L271](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/runtime-v2.md#L264-L271)。shim 侧读 stdin 并 `manager.Start` 见 [pkg/shim/shim.go#L272-L293](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/pkg/shim/shim.go#L272-L293)。

> 细节：`shim start` 进程只是"启动助手"，会 fork/exec 自己（`-namespace/-id/-address`，无 action）作为长驻 ttrpc server，然后把地址写 stdout 并退出。见 [manager/manager_linux.go#L84-L114](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/manager/manager_linux.go#L84-L114)（构造子进程 + `Setpgid`）。

## 5. 完整启动时序：startShim → runc create → shim 收养

### 5.1 因果链

1. CRI/kubelet 触发 `NewTask`：pause 容器在 `RunPodSandbox` 内，业务容器在 `StartContainer` 内。
2. `TaskManager.Create` 建 bundle（写 `config.json`）→ `ShimManager.Start`。
3. `startShim` 解析 runtime 路径 → `exec shim start`，`cwd=bundle`，stdin 写 `BootstrapParams`。
4. shim 读参数、设 subreaper、建 socket，fork/exec 自己作为长驻 ttrpc server；把 `BootstrapResult{version, protocol, address}` 写 stdout 后**助手进程退出**。
5. containerd 解析 stdout → 建 ttrpc 连接 → `TaskService.Create`。
6. shim 调 `runc create`（runc 读 bundle 的 `config.json`）。runc 用 **re-exec `/proc/self/exe init`** 拉起容器 init：C 构造函数 `nsexec` 先加入 namespace，再由 Go 的 `runc init` 完成初始化；init 在 **execve 之前**以 `O_WRONLY` 重新打开 `exec.fifo` 并写入 `"0"`（此时无读端，写入阻塞），runc 写完 pid 文件即**退出**（`create` detach）。
7. shim 从 pid 文件读 init PID → 返回 `CreateTaskResponse{pid}`。
8. `StartContainer` → `TaskService.Start` → shim 调 `runc start`；`runc start` **打开 exec.fifo 读端**，读走 init 写入的字节。
9. init 的写入因读端出现而解除阻塞，随即 `execve` 用户命令成为容器 PID 1；runc 已退出，**容器 init 被 shim 收养**（shim 是 sub-reaper/最近祖先），`ps` 里 PPID 是 shim。
10. 运行期 stdio 由 shim 转发；退出时 SIGCHLD → reaper → `TaskExit` 事件 + 退出码 → containerd `Wait` 返回。

### 5.2 时序图

```mermaid
sequenceDiagram
    autonumber
    participant K as kubelet
    participant C as containerd(CRI plugin)
    participant TM as TaskManager/ShimManager
    participant SH1 as shim "start" 助手
    participant SH as 长驻 shim(ttrpc)
    participant R as runc
    participant I as 容器 init(runc init)
    participant P as 业务进程

    K->>C: RunPodSandbox / CreateContainer / StartContainer
    C->>C: GetSandboxRuntime(runtime_handler)
    C->>TM: NewTask -> ShimManager.Start
    TM->>TM: NewBundle 写 config.json
    TM->>SH1: exec containerd-shim-runc-v2 ... start (cwd=bundle, stdin=BootstrapParams)
    SH1->>SH1: 读 stdin, subreaper(), 建 socket
    SH1->>SH: fork/exec 自己(-namespace/-id/-address), 传 socket fd
    SH1-->>TM: stdout BootstrapResult{version:3, "ttrpc", address}
    SH1--xSH1: 助手退出
    TM->>SH: ttrpc TaskService.CreateTaskRequest
    SH->>R: exec runc create --bundle <bundle> <id>
    R->>I: fork + re-exec(/proc/self/exe init) + nsexec 加入 namespace
    I->>I: 初始化完成; execve 前 O_WRONLY 打开 exec.fifo 写 "0"(无读端则阻塞)
    R-->>SH: 写 pid 文件后退出(detach)
    SH-->>TM: CreateTaskResponse{pid}
    C->>SH: TaskService.StartRequest
    SH->>R: exec runc start <id>
    R->>I: runc start 打开 exec.fifo 读端, 读走 "0"
    I->>P: 解除阻塞 -> execve 用户命令, 成为容器 PID 1
    Note over SH,P: runc 已退出, 容器 init 被 shim 收养
    SH-->>C: TaskStart 事件
    I-->>SH: 退出 -> SIGCHLD -> reaper
    SH-->>C: TaskExit 事件 + Wait 返回退出码
```

### 5.3 关键代码证据

**证据 1**：containerd 侧 startShim，`core/runtime/v2/shim_manager.go:365-372`

```go
	b := shimBinary(bundle, shimBinaryConfig{
		runtime:      runtimePath,
		address:      m.containerdAddress,
		ttrpcAddress: m.containerdTTRPCAddress,
		socketDir:    m.socketDir,
		env:          m.env,
	})
	shim, err := b.Start(ctx, typeurl.MarshalProto(topts), func() {
```

[🔗 shim_manager.go#L365-L372](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/shim_manager.go#L365-L372)

**证据 2**：shim 把 Create 转成 `runc create` 并读 pid 文件，`cmd/containerd-shim-runc-v2/process/init.go:149-151`、`:174-179`

```go
	if err := p.runtime.Create(ctx, r.ID, r.Bundle, opts); err != nil {
		return p.runtimeError(err, "OCI runtime create failed")
	}
```

```go
	pid, err := pidFile.Read()
	if err != nil {
		return fmt.Errorf("failed to retrieve OCI runtime container pid: %w", err)
	}
	p.pid = pid
```

[🔗 init.go#L149-L151](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/process/init.go#L149-L151) · [🔗 #L174-L179](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/process/init.go#L174-L179)

**证据 3**：runc `create` 是 detach 的，`runc/utils_linux.go:258`、`:277-L286`

```go
	detach := r.detach || (r.action == CT_ACT_CREATE)
```

```go
	switch r.action {
	case CT_ACT_CREATE:
		err = r.container.Start(process)
	case CT_ACT_RESTORE:
		err = r.container.Restore(process, r.criuOpts)
	case CT_ACT_RUN:
		err = r.container.Run(process)
	default:
		panic("Unknown action")
	}
```

[🔗 runc/utils_linux.go#L258](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L258) · [🔗 #L277-L286](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L277-L286)（detach 分支随后 `return 0` 退出，见 [#L306-L307](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L306-L307)）

**证据 4**：exec.fifo 的写端在容器 init、读端在 `runc start`（方向别写反！）

`runc/libcontainer/standard_init_linux.go:260-271`——init 在 `execve` 之前重新打开 fifo 并写 `"0"`；无读端时写入阻塞：

```go
	// Wait for the FIFO to be opened on the other side before exec-ing the
	// user process. We open it through /proc/self/fd/$fd, because the fd that
	// was given to us was an O_PATH fd to the fifo itself. Linux allows us to
	// re-open an O_PATH fd through /proc.
	fifoFile, err := pathrs.Reopen(l.fifoFile, unix.O_WRONLY|unix.O_CLOEXEC)
	if err != nil {
		return fmt.Errorf("reopen exec fifo: %w", err)
	}
	defer fifoFile.Close()
	if _, err := fifoFile.Write([]byte("0")); err != nil {
		return &os.PathError{Op: "write exec fifo", Path: fifoFile.Name(), Err: err}
	}
```

[🔗 standard_init_linux.go#L260-L271](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/standard_init_linux.go#L260-L271)

`runc/libcontainer/container_linux.go:256-265`——`runc start` 的 `Container.Exec()` 打开读端并读走该字节；读不到（已启动过）则报错：

```go
func readFromExecFifo(execFifo io.Reader) error {
	data, err := io.ReadAll(execFifo)
	if err != nil {
		return err
	}
	if len(data) <= 0 {
		return errors.New("cannot start an already running container")
	}
	return nil
}
```

[🔗 container_linux.go#L256-L265](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L256-L265)；读端打开过程（`fifoOpen` 用 `O_RDONLY`、阻塞等待）见 [#L267-L285](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L267-L285)；`exec()` 主循环见 [#L233-L253](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L233-L253)。

`runc` 的 init 是 re-exec 出来的：`cmd := exec.Command(exePath, "init")`（[container_linux.go#L530](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L530)）。`runc init` 入口见 [runc/init.go#L10-L15](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/init.go#L10-L15)（"executed before main() but after libcontainer/nsenter's nsexec()"）；初始化主体 [libcontainer/init_linux.go#L105-L123](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/init_linux.go#L105-L123)；`runc start` 走 `container.Exec()`（[start.go#L20-L40](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/start.go#L20-L40)）；bundle 的 `config.json` 由 containerd 写（[core/runtime/v2/bundle.go#L124-L129](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/core/runtime/v2/bundle.go#L124-L129)）。

**"收养"的准确说法**：容器 init 的父进程是 `runc create`，但 runc 立刻 detach 退出，init 被内核 reparent 给 shim（sub-reaper，通常是最近祖先）。所以 runc **不常驻**，只是"一次性创建器"；`ps` 里容器进程 PPID 是 shim。这是 shim 与 runc 分工的关键。

## 6. runtime handler 与 containerd 配置

### 6.1 handler = CRI 字符串 → containerd runtime 配置的映射

**结论**：`RuntimeClass.spec.handler`（k8s 侧，见 runtime-class 研究笔记）→ kubelet 填进 CRI 的 `runtime_handler` → containerd CRI 用它作 key 查 `containerd.runtimes.<handler>`，取出 `runtime_type`（containerd runtime 名，如 `io.containerd.runc.v2`）和 `options`（如 `SystemdCgroup`/`BinaryName`）→ 拼成 `containerd.WithRuntime(type, options)`。**空字符串 handler = 默认 runtime**（`default_runtime_name`）。

**证据 1**：CRI 请求字段（空串=默认），`cri-api/pkg/apis/runtime/v1/api.proto:627-636`

```text
message RunPodSandboxRequest {
    // Configuration for creating a PodSandbox.
    PodSandboxConfig config = 1;
    // Named runtime configuration to use for this PodSandbox.
    // If the runtime handler is unknown, this request should be rejected.  An
    // empty string should select the default handler, equivalent to the
    // behavior before this feature was added.
    // See https://git.k8s.io/enhancements/keps/sig-node/585-runtime-class
    string runtime_handler = 2;
}
```

[🔗 cri-api api.proto#L627-L636](https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L627-L636)

**证据 2**：映射实现，`internal/cri/config/config.go:712-720`

```go
	if runtimeHandler == "" {
		runtimeHandler = config.DefaultRuntimeName
	}

	r, ok := config.Runtimes[runtimeHandler]
	if !ok {
		return Runtime{}, fmt.Errorf("no runtime for %q is configured", runtimeHandler)
	}
	return r, nil
```

[🔗 internal/cri/config/config.go#L712-L720](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/config/config.go#L712-L720)

`Runtime` 结构字段见 [config.go#L82-L99](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/config/config.go#L82-L99)；CRI `Status` 里默认 handler `Name` 为空串见 [service.go#L441-L450](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/server/service.go#L441-L450)。

### 6.2 2.x 的 TOML 路径（与 1.x 对照）

**结论**：2.x 用 config version 3，runtimes 配在 `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.<name>]`；`options` 是 runtime 插件自己的 typed 配置（runc 用 `SystemdCgroup`、`BinaryName` 等）。1.x 对应 `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.<name>]`。

**证据**：`docs/cri/config.md:93-107`（2.x runtime classes 示例）

```toml
version = 3
[plugins."io.containerd.cri.v1.runtime".containerd]
  default_runtime_name = "crun"
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes]
    # crun: https://github.com/containers/crun
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.crun]
      runtime_type = "io.containerd.runc.v2"
      [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.crun.options]
        BinaryName = "/usr/local/bin/crun"
    # gVisor: https://gvisor.dev/
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.gvisor]
      runtime_type = "io.containerd.runsc.v1"
    # Kata Containers: https://katacontainers.io/
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.kata]
      runtime_type = "io.containerd.kata.v2"
```

[🔗 docs/cri/config.md#L93-L107](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L93-L107)

`SystemdCgroup` 的 2.x 写法见 [docs/cri/config.md#L33-L36](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L33-L36)；2.x 中 `io.containerd.grpc.v1.cri` 只剩 streaming/TCP 选项（[#L319-L328](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L319-L328)）。

> 注意：`docs/runtime-v2.md:171-174` 的配置示例仍写 1.x 的 `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes]`，属文档滞后，以 `docs/cri/config.md` 为准。

## 7. 边界澄清（常见误解）

| 说法 | 实际情况 | 依据 |
|---|---|---|
| containerd = CRI | 错。CRI 只是 containerd 的一个 plugin；ctr/nerdctl/Moby 走 containerd API 而非 CRI | [docs/cri/config.md#L9-L10](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L9-L10) |
| containerd 自己跑容器 | 错，不直接 launch，委托 shim→engine | §1.1、§3.4 |
| shim = runc | 错。shim 是含 ttrpc server 的伴生进程；runc 是 shim fork 的一次性 OCI 创建器，create 完即退出 | §5.3 |
| `containerd-shim-runc-v2` 硬绑定 runc | 名字只表示默认 runtime_type；可换 `io.containerd.runsc.v1`、`io.containerd.kata.v2`，也可用 `BinaryName` 换 crun | [docs/cri/config.md#L98-L107](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L98-L107) |
| shim 一定每容器一个 | 不一定。v2 下同一 pod 的容器通常共享一个 shim（按 `io.kubernetes.cri.sandbox-id` 分组） | [manager_linux.go#L64-L70](https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/cmd/containerd-shim-runc-v2/manager/manager_linux.go#L64-L70) |
| CRI 配置仍在 `io.containerd.grpc.v1.cri` | 2.x 已拆分：runtime/images 在 `io.containerd.cri.v1.*` | §2.2 |
| shim 协议就是 `containerd.task.v2` | 2.4.2 默认 task API 是 v3，v2 仅兼容 | §4.2 |
| 停 containerd 必杀容器 | 不会，前提是 systemd `KillMode=process` 且 shim 正常 | §3.1 |

## 8. 待核实

- **待核实**：v1 shim 的具体 gRPC 服务名与 proto（2.4.2 已删除 v1 代码，需回 v1.x 分支核对 `containerd.shim.v1`）。
- **待核实**：2.x 长驻 shim 被 reparent 到的具体祖先进程。历史文档说 "re-parented to the system's init"，但 `shim start` 助手退出后长驻 shim 的父进程取决于 containerd 是否被设为 subreaper，需实测 `ps -o ppid`。
- **待核实**：`docs/runtime-v2.md` 里 `containerd.task.v2` 表述与 2.4.2 默认 v3 的关系（文档未随 task API v3 更新；v3/v2 proto 目前只差 package 名，v3 引入动机需查 PR 历史）。

## 9. 关键结论（10-12 条）

1. containerd 是节点容器守护进程/hub，管理镜像、内容、快照、metadata 与任务编排；它**不是** OCI 运行时，不直接 launch 容器。
2. 一切能力都是 plugin（`io.containerd.<area>.v<n>.<id>`）；CRI 也只是 `io.containerd.grpc.v1.cri` 这个 gRPC plugin。
3. containerd 2.x 把 CRI 内部拆成 `io.containerd.cri.v1.runtime`（runtimes/CNI）与 `io.containerd.cri.v1.images`（snapshotter/registry），config version 3 必须用新 TOML 路径；旧 `grpc.v1.cri` 只剩 streaming 等少量选项。
4. CRI Pod 模型 = pause 容器（sandbox）+ 共享 netns/CNI + 业务容器；2.x 默认 sandboxer 为 `podsandbox`，pause 镜像由 CRI 预拉（可关）。
5. shim 的第一因是**生命周期解耦**：containerd 可升级/重启而容器不断，配合 `KillMode=process`，靠 bundle 里 `bootstrap.json`（老版 `address`）重启后 re-adopt。
6. shim 是容器进程的直接父进程与 sub-reaper，负责收僵尸、持 stdio/TTY、上报退出码与事件。
7. shim v2 = 统一 `containerd-shim-runc-v2` + ttrpc Task API + containerd 传入 FIFO 路径 + `start`/`delete` 子命令；runtime 名按 `io.containerd.runc.v2 → containerd-shim-runc-v2` 解析。
8. 2.3+ 起 shim 启动改用 stdin 的 protobuf `BootstrapParams` / stdout 的 `BootstrapResult`；旧 flags 与环境变量保留但 deprecated。
9. 2.4.2 默认 task API 是 `containerd.task.v3`（与 v2 同构、只差 package 名与版本号），v2 由 `ttrpcV2Bridge` 兼容；**shim v2 架构 ≠ task API v2**。
10. 启动因果链：containerd → `shim start`（助手）→ 长驻 ttrpc shim → `runc create`（re-exec `runc init`、加 namespace；init 在 execve 前打开 exec.fifo 写 `"0"` 并阻塞）→ **runc 退出、容器 init 被 shim 收养** → `runc start` 打开 exec.fifo 读端读走 `"0"` → init 解除阻塞并 execve 业务进程，成为容器 PID 1。
11. runtime handler 是纯映射：`RuntimeClass.handler` → CRI `runtime_handler` → `containerd.runtimes.<name>.runtime_type/options`；空 handler = `default_runtime_name`；container 继承 sandbox 的 runtime。
12. 名字别混：**containerd**（守护进程）≠ **CRI**（其插件之一）≠ **shim**（伴生进程）≠ **runc**（一次性 OCI 引擎）；`containerd-shim-runc-v2` 的 "runc" 只是默认 runtime_type。

## 附：行号与链接自检

- 三个固定 sha 与本地 `git rev-parse HEAD` 一致（containerd `b7a2526…`、runc `46365c6…`、cri-api `d279f3c…`）；链接形如 `.../blob/<sha>/<path>#Lx-Ly`，GitHub 可直接打开。
- 每段 `#Lx-Ly` 均用本地 `nl -ba`/`sed -n 'x,yp'` 核对；摘录均 ≤25 行，超长部分用 "…" 或拆段。
- 交叉引用：RuntimeClass/handler 语义见同目录 runtime-class 研究笔记；OCI/runc 的 namespace/cgroup 细节见 oci-runc 研究笔记；kubelet-CRI 调用细节见 cri-kubelet 研究笔记。
