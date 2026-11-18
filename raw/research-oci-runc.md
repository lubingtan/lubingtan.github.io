# OCI image-spec / runtime-spec / runc 调研笔记

> 调研日期 2026-11-18｜用途：容器镜像格式 + 运行时契约 + 最小实现的证据笔记（供 wiki 取材）。
> 本地固定源码（已 checkout 到 tag，本次未重新克隆、未 `git pull`）：
>
> | 仓库 | tag | commit |
> |---|---|---|
> | `.repos/upstream/runtime-spec` | `v1.3.0` | `92249139eea7161e13745abd4cb6d0ea02a3227a` |
> | `.repos/upstream/image-spec` | `v1.1.1` | `147f9c13cedb47a0c4d9a11a222961073d585877` |
> | `.repos/upstream/runc` | `v1.5.3` | `46365c62967c76a765a5e347f48f0c7b3b571fe9` |
>
> 行号以本地 `nl -ba` / `grep -n` 为准；GitHub 链接使用同一 commit，可逐条点开对照。无法用本地代码/规范证实的结论显式标注「待核实」。

## 1. OCI 是什么：三份规范的边界

**结论**
- `image-spec`：镜像的静态数据格式（descriptor / manifest / index / config / layer / media type / annotations），产物是「一堆按 digest 寻址的 blob」。
- `runtime-spec`：只管**执行**——bundle 形态、`config.json` 字段语义、四种状态、`create/start/kill/delete` 语义；不定义镜像格式。
- `distribution-spec`：registry 的 HTTP API（push/pull），是**独立项目**，image-spec 只在 README 指出去，不在自身规范范围内。
- 三者都是纯契约，正文不含实现代码；image → runtime 之间还有一步规范定义的转换（`conversion.md`），不是各家随意发挥。

**证据**
```text
# image-spec/README.md L22-L25
... an OCI implementation would download an OCI Image then unpack that image
into an OCI Runtime filesystem bundle. At this point the OCI Runtime Bundle
would be run by an OCI Runtime.
```
**链接**：[image-spec/README.md#L20-L25](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/README.md#L20-L25) · [image-spec/README.md#L34-L37](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/README.md#L34-L37) · [runtime-spec/spec.md#L5-L10](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/spec.md#L5-L10) · [image-spec/conversion.md#L1-L9](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/conversion.md#L1-L9)

**待核实**：`distribution-spec` 仓库本地未克隆，endpoint / referrers API / 分块上传等细节未验证；只能确认「独立项目、负责 registry API」这一层（依据 image-spec README L34-L37）。

## 2. image-spec：带 media type 的 Merkle DAG

### 2.1 descriptor：一切引用的原子单位

**结论**
- OCI image 由多个 component 排成 **Merkle DAG**；引用统一是 Content Descriptor。
- 必填 `mediaType` + `digest` + `size`；可选 `urls`、`annotations`、`data`（base64 内嵌）、`artifactType`、`platform`（仅指向 manifest 时）。
- 引用按内容哈希，任何一层被改动都会让上层 digest 失配——pull 校验与 content store 去重的基础。

**证据**
```text
# image-spec/descriptor.md L3-L6
- An OCI image consists of several different components, arranged in a [Merkle Directed Acyclic Graph (DAG)](https://en.wikipedia.org/wiki/Merkle_tree).
- References between components in the graph are expressed through _Content Descriptors_.
- A Content Descriptor (or simply _Descriptor_) describes the disposition of the targeted content.
- A Content Descriptor includes the type of the content, a content identifier (_digest_), and the byte-size of the raw content.
```
**链接**：[image-spec/descriptor.md#L3-L12](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/descriptor.md#L3-L12) · [image-spec/descriptor.md#L20-L47](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/descriptor.md#L20-L47) · [image-spec/specs-go/v1/descriptor.go#L22-L50](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/descriptor.go#L22-L50)（`Descriptor` 结构体）

### 2.2 manifest 与 image index

**结论**
- manifest 只描述**单一架构/单一 OS**。REQUIRED 只有：`schemaVersion`（本版本固定 `2`，为兼容老 Docker）、`config`（descriptor → image config）、`layers`（descriptor 数组，index 0 是 base，之后按 stack 顺序）。可选 `mediaType`、`artifactType`、`subject`（referrers 用）、`annotations`。
- image index（"fat manifest"）的 `manifests[]` 是带 `platform` 的 descriptor 列表；对 provider OPTIONAL，对 consumer SHOULD 支持——多架构自动选型就在这一层。

**证据**
```text
# image-spec/manifest.md L70-L73
  - The array MUST have the base layer at index 0.
  - Subsequent layers MUST then follow in stack order (i.e. from `layers[0]` to `layers[len(layers)-1]`).
  - The final filesystem layout MUST match the result of [applying](layer.md#applying-changesets) the layers to an empty directory.
  - The [ownership, mode, and other attributes](layer.md#file-attributes) of the initial empty directory are unspecified.
```
**链接**：[image-spec/manifest.md#L3-L14](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/manifest.md#L3-L14) · [image-spec/manifest.md#L18-L21](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/manifest.md#L18-L21) · [image-spec/image-index.md#L3-L8](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/image-index.md#L3-L8) · [image-spec/specs-go/v1/manifest.go#L20-L41](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/manifest.go#L20-L41) · [image-spec/specs-go/v1/index.go#L21-L38](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/index.go#L21-L38)

### 2.3 config：ImageID 与 diff_ids

**结论**
- image config 是一个 JSON blob，**ImageID = SHA256(config JSON)**；因为 config 引用了每层 hash，ImageID 天然绑定整个镜像内容。
- `rootfs.type` MUST 为 `layers`；`rootfs.diff_ids` 是**未压缩** layer 的摘要序列（first→last），与 manifest 里压缩 blob 的 digest 是两套值。
- `history` 用 `empty_layer` 标记与 layer 的对应关系，所以「history 条数 ≠ layer 数」（Dockerfile 的 `ENV` 不产生文件系统变化）。

**证据**
```text
# image-spec/config.md L87-L89（节选）
Each image's ID is given by the SHA256 hash of its [configuration JSON](#image-json).
Since the [configuration JSON](#image-json) that gets hashed references hashes of each layer in
the image, this formulation of the ImageID makes images content-addressable.
```
**链接**：[image-spec/config.md#L85-L89](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/config.md#L85-L89) · [image-spec/config.md#L210-L222](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/config.md#L210-L222) · [image-spec/specs-go/v1/config.go#L64-L71](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/config.go#L64-L71)（`RootFS`） · [image-spec/specs-go/v1/config.go#L91-L111](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/config.go#L91-L111)（`Image`）

### 2.4 layer / media type / annotations

**结论**
- layer 是 **changeset 而非普通 tar**：`.wh.` 前缀的空文件是 whiteout，表示「删除下层该路径」；没有 whiteout 时才等价于普通 tar 解包。
- 压缩格式由 media type 表达：`application/vnd.oci.image.layer.v1.tar`、`+gzip`、`+zstd`。
- annotations 是 string→string map，key 推荐 reverse-domain，`org.opencontainers` 前缀被 OCI 保留；预定义 key 覆盖 created/authors/source/version/revision/licenses/title/description 等。**遇到未知 key，consumer MUST NOT 报错**（可扩展性的关键约定）。

**证据**
```text
# image-spec/layer.md L247-L252（节选）
- A whiteout file is an empty file with a special filename that signifies a path should be deleted.
- A whiteout filename consists of the prefix `.wh.` plus the basename of the path to be deleted.
- Whiteout files MUST only apply to resources in lower/parent layers.
- Files that are present in the same layer as a whiteout file can only be hidden by whiteout files in subsequent layers.
```
**链接**：[image-spec/layer.md#L229-L253](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/layer.md#L229-L253) · [image-spec/layer.md#L9-L23](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/layer.md#L9-L23) · [image-spec/annotations.md#L7-L20](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/annotations.md#L7-L20) · [image-spec/specs-go/v1/mediatype.go#L17-L48](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/specs-go/v1/mediatype.go#L17-L48)

### 2.5 为什么 containerd 能直接消费；与 Docker image 的关系

**结论**
- 因为 OCI image 在传输形态上是**纯内容寻址的 blob 集合**：`blobs/<alg>/<encoded>` + `oci-layout`（版本标记）+ `index.json`（入口 descriptor 列表）。引擎只要实现「按 digest 存取 blob」的 content store 就能原样消费。
- 与 Docker image 的关系：manifest/index/config 与 Docker schema2 一一对应，差异主要是 OCI 多 `annotations`/`urls`；`tar+gzip` layer 是 **fully compatible / interchangeable**。Docker 的 `Memory`/`MemorySwap`/`CpuShares`/`Healthcheck` 在 OCI 被标 reserved，`ArgsEscaped` 已 deprecated。
- 所以「OCI 镜像取代 Docker 镜像」不准确，更准确的是**同一 schema 的两个版本**：OCI 补 annotations/artifact，Docker 留历史字段。

**证据**
```text
# image-spec/media-types.md L62-L64
Interchangeable and fully compatible mime-types:
- [application/vnd.docker.image.rootfs.diff.tar.gzip](https://github.com/moby/moby/blob/v20.10.8/image/spec/v1.2.md#creating-an-image-filesystem-changeset)
```
**链接**：[image-spec/media-types.md#L35-L76](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/media-types.md#L35-L76) · [image-spec/image-layout.md#L1-L36](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/image-layout.md#L1-L36) · [image-spec/image-layout.md#L145-L155](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/image-layout.md#L145-L155) · [image-spec/implementations.md#L14](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/implementations.md#L14)（`containerd/containerd` 在列）

**待核实**：containerd 内部实现（content store、images service、gc、snapshotter unpack）本次未验证——containerd 仓库不在本地 `.repos`。本节只证明「OCI 的数据形态允许直接消费」+「image-spec 把 containerd 列为采用者」。

## 3. runtime-spec：bundle + config.json + 生命周期

### 3.1 bundle 的形态

**结论**
- bundle 是**一个目录**，必需内容只有两样：目录根部的 `config.json`，以及 `root.path` 指向的 root filesystem（若设置）。目录本身不算 bundle 的一部分（tar 打包时 artifact 在归档根部，不嵌套）。

**证据**
```text
# runtime-spec/bundle.md L13-L17（节选）
1. <a name="containerFormat01" />`config.json`: contains configuration data.
    This REQUIRED file MUST reside in the root of the bundle directory and MUST be named `config.json`.
2. <a name="containerFormat02" />container's root filesystem: the directory referenced by [`root.path`](config.md#root), if that property is set in `config.json`.
```
**链接**：[runtime-spec/bundle.md#L3-L20](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/bundle.md#L3-L20)

### 3.2 config.json：顶层字段 + Linux 扩展

**结论**
- 顶层：`ociVersion`、`process`、`root`、`hostname`、`domainname`、`mounts`、`hooks`、`annotations`，加平台扩展（`linux`/`windows`/`vm`/`solaris`/`zos`/`freebsd`）。
- `ociVersion` 是 REQUIRED 的 SemVer，minor 版本向前兼容；`root.path` 可相对 bundle（约定用 `rootfs`），`root.readonly` 控制只读；`mounts` 按数组顺序挂载。
- `linux.namespaces` 是 `{type, path?}` 数组，type 支持 `pid`/`network`/`mount`/`ipc`/`uts`/`user`/`cgroup`/`time`。给了 `path` 就 join；不给就**新建**；**没出现在数组里的 type 继承 runtime 的 namespace**。
- `linux.cgroupsPath`（绝对相对均可）+ `linux.resources` 表达限额；cgroup 不存在时会被创建。规范只定义**字段语义**，不规定 cgroup v1/v2 的具体实现。

**证据**
```go
// runtime-spec/specs-go/config.go L5-L36（节选）
type Spec struct {
	Version string `json:"ociVersion"`
	Process *Process `json:"process,omitempty"`
	Root *Root `json:"root,omitempty"`
	Hostname string `json:"hostname,omitempty"`
	Domainname string `json:"domainname,omitempty"`
	Mounts []Mount `json:"mounts,omitempty"`
	Hooks *Hooks `json:"hooks,omitempty" platform:"linux,solaris,zos"`
	Annotations map[string]string `json:"annotations,omitempty"`
	Linux *Linux `json:"linux,omitempty" platform:"linux"`
}
```
**链接**：[runtime-spec/specs-go/config.go#L5-L36](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/specs-go/config.go#L5-L36) · [runtime-spec/config.md#L15-L19](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config.md#L15-L19) · [runtime-spec/config.md#L27-L43](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config.md#L27-L43) · [runtime-spec/config.md#L237-L254](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config.md#L237-L254) · [runtime-spec/config-linux.md#L20-L46](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config-linux.md#L20-L46) · [runtime-spec/config-linux.md#L294-L331](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config-linux.md#L294-L331)

### 3.3 hooks：六个字段

**结论**
- 六个字段：`prestart`（已 deprecated）、`createRuntime`、`createContainer`、`startContainer`、`poststart`、`poststop`。
- 区分维度是「执行时机 + 所在 namespace」：createRuntime/poststart/poststop 在 runtime namespace；createContainer/startContainer 在 container namespace。hooks 按列出顺序执行，容器 state 通过 stdin 传给 hook。

**证据**
```go
// runtime-spec/specs-go/config.go L205-L213
	// CreateRuntime is a list of hooks to be run after the container has been created but before pivot_root or any equivalent operation has been called
	// It is called in the Runtime Namespace
	CreateRuntime []Hook `json:"createRuntime,omitempty"`
	// CreateContainer is a list of hooks to be run after the container has been created but before pivot_root or any equivalent operation has been called
	// It is called in the Container Namespace
	CreateContainer []Hook `json:"createContainer,omitempty"`
	// StartContainer is a list of hooks to be run after the start operation is called but before the container process is started
	// It is called in the Container Namespace
	StartContainer []Hook `json:"startContainer,omitempty"`
```
**链接**：[runtime-spec/config.md#L548-L592](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config.md#L548-L592) · [runtime-spec/config.md#L594-L600](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/config.md#L594-L600) · [runtime-spec/specs-go/config.go#L197-L220](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/specs-go/config.go#L197-L220)

### 3.4 生命周期与 state

**结论**
- 四种状态：`creating` / `created` / `running` / `stopped`。`created` = create 完成、「既没退出也没执行用户程序」；`running` = 已执行用户程序未退出。
- 13 步生命周期：create（建运行环境，**MUST NOT** 跑用户程序）→ prestart → createRuntime → createContainer → **start** → startContainer → 跑用户程序 → poststart → 进程退出 → delete → 销毁资源 → poststop。
- state REQUIRED 字段：`ociVersion`、`id`、`status`、`bundle`；Linux 上 created/running 时 `pid` REQUIRED；`annotations` 可选。

**证据**
```text
# runtime-spec/runtime.md L19-L22
    * `creating`: the container is being created (step 2 in the [lifecycle](#lifecycle))
    * `created`: the runtime has finished the [create operation](#create) (after step 2 in the [lifecycle](#lifecycle)),
      and the container process has neither exited nor executed the user-specified program
    * `running`: the container process has executed the user-specified program but has not exited (after step 8 in the [lifecycle](#lifecycle))
    * `stopped`: the container process has exited (step 10 in the [lifecycle](#lifecycle))
```
**链接**：[runtime-spec/runtime.md#L8-L37](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/runtime.md#L8-L37) · [runtime-spec/runtime.md#L54-L79](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/runtime.md#L54-L79) · [runtime-spec/specs-go/state.go#L6-L35](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/specs-go/state.go#L6-L35)

### 3.5 四个操作的语义与已知实现

**结论**
- 规范**刻意声明这些「操作」不是 CLI API 规范**，参数只是通用操作的输入——所以 `runc create` 这种命令行形态属实现自由。
- `create`：除 `process` 外所有 config 字段 MUST 应用；`process.args` MUST NOT 应用；create 后改 config.json 不影响容器。`start` 只在 `created` 有效；`kill` 只能对 created/running；`delete` 只能删 `stopped` 且只删 create 阶段创建的资源。
- `implementations.md` 的清单：容器型 `crun`(C)、`youki`(Rust)、`runc`(reference implementation)、`inclavare-containers`、`bwrap-oci`、`systemd-nspawn`(v242 `--oci-bundle`)；VM 型 `gvisor`(runsc)、`kata-containers`、`runv`、`clearcontainers/runtime`；工具 `oct`/`octool`/`runtime-tools`。

**证据**
```text
# runtime-spec/runtime.md L95-L96
Note: these operations are not specifying any command-line APIs,
and the parameters are inputs for general operations.
```
**链接**：[runtime-spec/runtime.md#L91-L103](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/runtime.md#L91-L103) · [runtime-spec/runtime.md#L105-L145](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/runtime.md#L105-L145) · [runtime-spec/implementations.md#L6-L26](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/implementations.md#L6-L26)

## 4. runc：OCI runtime 的 CLI 参考实现

### 4.1 定位：CLI + libcontainer，没有守护进程

**结论**
- runc 自我描述是「按 OCI 规范在 Linux 上 spawn/run 容器的 CLI 工具」，容器被 spawn 为 process supervisor 的**直接子进程**。命令集全是短命 CLI（create/start/delete/kill/state/exec/run/...），**没有 serve/daemon 命令**。
- 「无守护进程」证据链三段：① `detach := r.detach || (r.action == CT_ACT_CREATE)`，create 天然 detach；② `forward()` 开头 `if detach && h.notifySocket == nil { return 0, nil }`，detach 立即返回不等容器退出；③ `create.go` 成功时直接 `os.Exit(status)`，**`runc create` 进程随即退出**，容器 init 留在后台。
- 状态不在内存，而在 `--root` 目录（默认 `/run/runc`，tmpfs）下的 `state.json` + `exec.fifo`。后续 `runc start`/`delete` 都是**另起进程读磁盘状态**，不连常驻服务。

**证据**
```go
// runc/signals.go L64-L69
func (h *signalHandler) forward(process *libcontainer.Process, tty *tty, detach bool) (int, error) {
	// make sure we know the pid of our main process so that we can return
	// after it dies.
	if detach && h.notifySocket == nil {
		return 0, nil
	}
```
**链接**：[runc/main.go#L62-L84](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/main.go#L62-L84) · [runc/main.go#L133-L151](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/main.go#L133-L151)（命令列表） · [runc/main.go#L95](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/main.go#L95) · [runc/create.go#L59-L70](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/create.go#L59-L70) · [runc/signals.go#L64-L69](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/signals.go#L64-L69) · [runc/utils_linux.go#L258-L258](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L258-L258)

### 4.2 `runc create` 的调用链

**结论**
- `runc create <id>` → `startContainer(ctx, CT_ACT_CREATE, nil)` → `setupSpec()` 读 bundle 的 `config.json` → `createContainer()` → `specconv.CreateLibcontainerConfig()`（**OCI spec → libcontainer 内部 config 的翻译层**）→ `libcontainer.Create(root, id, config)`（建 state 目录、准备 cgroup manager；`state.json` 要等到 procReady 握手时才写入）→ `r.run(spec.Process)`。
- `r.run` 按 action 分派：`CT_ACT_CREATE` 只调 `container.Start`；`CT_ACT_RUN` 调 `container.Run`（= start + exec）。

**证据**
```go
// runc/utils_linux.go L277-L283
switch r.action {
case CT_ACT_CREATE:
	err = r.container.Start(process)
case CT_ACT_RESTORE:
	err = r.container.Restore(process, r.criuOpts)
case CT_ACT_RUN:
	err = r.container.Run(process)
```
**链接**：[runc/utils_linux.go#L367-L418](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L367-L418) · [runc/utils_linux.go#L183-L203](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/utils_linux.go#L183-L203) · [runc/libcontainer/specconv/spec_linux.go#L384-L414](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/specconv/spec_linux.go#L384-L414) · [runc/libcontainer/factory_linux.go#L20-L23](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/factory_linux.go#L20-L23)（`state.json`/`exec.fifo` 常量）

### 4.3 `runc init`：re-exec 自己，在 Go runtime 之前用 C 切 namespace

**结论**
- runc 是**单二进制**：容器 init 不是新程序，而是把 `/proc/self/exe` 再 exec 一次、参数带 `init`（`exec.Command(exePath, "init")`）。
- 子进程启动后、**Go runtime 起来之前**，`libcontainer/nsenter` 的 CGo constructor 跑 `nsexec()`：先读 `_LIBCONTAINER_INITPIPE`，读不到就 `return`——这一行直接证明主进程与 init 共用同一二进制；读到则解析 netlink bootstrap 数据，clone stage-1/stage-2 完成 user namespace 映射与真正的 unshare。
- Go 侧 `init.go` 判断 `os.Args[1] == "init"` → `libcontainer.Init()` → `startInitialization()`（`init_linux.go`），从环境变量取 `_LIBCONTAINER_SYNCPIPE`/`_LIBCONTAINER_INITPIPE`/`_LIBCONTAINER_LOGPIPE`/`_LIBCONTAINER_INITTYPE`/`_LIBCONTAINER_FIFOFD`。

**证据**
```go
// runc/init.go L10-L16
func init() {
	if len(os.Args) > 1 && os.Args[1] == "init" {
		// This is the golang entry point for runc init, executed
		// before main() but after libcontainer/nsenter's nsexec().
		libcontainer.Init()
	}
}
```
**链接**：[runc/init.go#L10-L16](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/init.go#L10-L16) · [runc/libcontainer/container_linux.go#L502-L537](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L502-L537)（`exec.Command(exePath, "init")`） · [runc/libcontainer/nsenter/nsenter.go#L1-L17](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/nsenter/nsenter.go#L1-L17) · [runc/libcontainer/nsenter/nsexec.c#L743-L747](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/nsenter/nsexec.c#L743-L747)（"We are not a runc init"） · [runc/libcontainer/nsenter/nsexec.c#L857-L870](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/nsenter/nsexec.c#L857-L870)（stage-0 → stage-1） · [runc/libcontainer/init_linux.go#L105-L161](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/init_linux.go#L105-L161)

### 4.4 init 如何等 start 信号：exec.fifo

**结论**
- create 阶段 `c.start()` 先 `createExecFifo()`：在 `<stateDir>/exec.fifo` 上 `mkfifo`（mode 0622），并把它的 **O_PATH fd** 通过 `ExtraFiles` + `_LIBCONTAINER_FIFOFD` 传给 `runc init`。
- init 侧在 execve 用户程序**之前**，把该 O_PATH fd 以 `O_WRONLY` 重新打开并写一字节 `"0"`。**FIFO 没有读端时这个 open/write 会阻塞**——这就是「容器停在 created 等 start」的机制。
- `runc start` 走 `container.Exec()` → `c.exec()` → 阻塞式 `O_RDONLY` 打开 + `readFromExecFifo`。读端一打开，init 的 write 完成，init 继续 execve。
- 因此 `exec.fifo` 的**存在本身**就是状态标志：`refreshState()` 用它在不在区分 created/running（start 时 `handleFifoResult` 会 `os.Remove` 掉它）。`runc create` 末尾 `c.fifo.Close()` 后返回退出；O_PATH fd 不算读端，不会提前解除阻塞。
- 父子之间还有 sync socket（`_LIBCONTAINER_SYNCPIPE`）：init 发 `procReady` → 父进程设 rlimits、`updateState()` 落盘 state.json、记 init 起始时间，回写 `procRun` → init 才继续。

**证据**
```go
// runc/libcontainer/standard_init_linux.go L260-L271
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
**链接**：[runc/libcontainer/container_linux.go#L447-L494](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L447-L494) · [runc/libcontainer/standard_init_linux.go#L250-L303](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/standard_init_linux.go#L250-L303) · [runc/libcontainer/container_linux.go#L233-L254](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L233-L254) · [runc/libcontainer/container_linux.go#L368-L388](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L368-L388) · [runc/libcontainer/process_linux.go#L984-L1016](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/process_linux.go#L984-L1016)（procReady→procRun） · [runc/libcontainer/init_linux.go#L185-L196](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/init_linux.go#L185-L196)

### 4.5 start / kill / delete / state 与状态持久化

**结论**
- `runc start <id>`：从 state 目录加载容器 → 只允许 `Created` → `container.Exec()`（上文 fifo 读端）→ running。`Stopped`/`Running` 直接报错。
- `runc kill`：默认 `SIGTERM` → `container.Signal(sig)`。`SIGKILL` + **没有私有 PID namespace** 时 runc 会显式 `signalAllProcesses(cgroupManager, SIGKILL)` 杀整个 cgroup（此时 init 不是 namespace 里的 PID 1，内核不会级联）。
- `runc delete`：`--force` 先 `killContainer`（SIGKILL 轮询后 `Destroy()`）；非 force 时 `Stopped` 直接 `Destroy()`、`Created` 也走 `killContainer`、`Running` 报错 "cannot delete container ... that is not stopped"。`Destroy()` 会 `os.RemoveAll(stateDir)` + cgroup destroy + poststop hook。
- `runc state` 由 `container.State()` + `containerStatus.String()` 组装输出；libcontainer 内部 `currentOCIState()` 则把 Status 的 `String()` 直接映射成 OCI `specs.ContainerState`（供 hooks / 事件使用）。状态文件 `state.json` 用 tmpfile + rename 原子替换，`refreshState()` 的判定顺序是 paused → init 是否存活 → `exec.fifo` 是否存在。

**证据**
```go
// runc/libcontainer/container_linux.go L885-L890
	// The presence of exec fifo helps to distinguish between
	// the created and the running states.
	if _, err := os.Stat(filepath.Join(c.stateDir, execFifoFilename)); err == nil {
		return c.state.transition(&createdState{c: c})
	}
	return c.state.transition(&runningState{c: c})
```
**链接**：[runc/start.go#L21-L53](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/start.go#L21-L53) · [runc/kill.go#L34-L61](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/kill.go#L34-L61) · [runc/delete.go#L27-L87](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/delete.go#L27-L87) · [runc/state.go#L20-L57](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/state.go#L20-L57) · [runc/libcontainer/container_linux.go#L396-L426](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L396-L426) · [runc/libcontainer/container_linux.go#L874-L891](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L874-L891) · [runc/libcontainer/container_linux.go#L967-L986](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L967-L986) · [runc/libcontainer/container_linux.go#L837-L861](https://github.com/opencontainers/runc/blob/46365c62967c76a765a5e347f48f0c7b3b571fe9/libcontainer/container_linux.go#L837-L861)

## 5. 常见误解

**结论**
- **误解 1：runc 就是 containerd 的「runtime plugin」全部。** 不对。containerd 负责镜像/快照/任务管理，「起进程」的是 shim + OCI runtime；runc 只是后者的一种 CLI 实现。**待核实**：containerd v2 shim/runtime 插件接口细节（仓库未本地克隆）。
- **误解 2：OCI runtime 会解析镜像。** 不会，runtime 输入只有 bundle；镜像 → bundle 的 unpack 与 conversion 发生在 runtime 之外。
- **误解 3：runtime-spec 规定了命令行。** 规范原文明说 operations are not command-line APIs，所以 `runc create` 的名字与参数都是 runc 自己的选择。
- **误解 4：OCI 规定 cgroups 具体实现。** 规范只要求把 `linux.resources` 的限额落实，v1/v2 由实现决定。
- **误解 5：`runc create` 之后容器进程已经在跑。** 没有；要等 `runc start` 打开 exec.fifo 读端、init 写完 `"0"` 才 execve。这是 `docker create`/`docker start` 语义的底层机制。
- 留给 containerd/CRI 笔记：CRI 的 PodSandbox/Container 配置最终由 containerd 的 CRI plugin 翻译成 OCI `config.json` 再交给 runtime，runc 只是最后一段（此链路本次未做源码验证）。

**证据**
```text
# runtime-spec/runtime.md L95-L96
Note: these operations are not specifying any command-line APIs,
and the parameters are inputs for general operations.
```
**链接**：[runtime-spec/runtime.md#L95-L96](https://github.com/opencontainers/runtime-spec/blob/92249139eea7161e13745abd4cb6d0ea02a3227a/runtime.md#L95-L96) · [image-spec/conversion.md#L22-L36](https://github.com/opencontainers/image-spec/blob/147f9c13cedb47a0c4d9a11a222961073d585877/conversion.md#L22-L36)

## 6. 关键结论（12 条）

1. **OCI = 三份契约**：`image-spec`（镜像格式）、`runtime-spec`（bundle + 生命周期）、`distribution-spec`（registry API，独立项目）；三者都不含运行时实现。
2. **image 是 Merkle DAG**：所有引用都是 `{mediaType, digest, size}` 的 descriptor；manifest = config + layers，index = 多平台 manifests，config 的 SHA256 就是 ImageID。
3. **OCI image 与 Docker image 是同一 schema 的两个版本**：manifest/index/config 一一对应，`tar+gzip` layer 完全可互换；OCI 多 annotations/urls/artifactType，Docker 留 Memory/CpuShares/Healthcheck/ArgsEscaped。
4. **layer 是 changeset 不是 tar**：`.wh.` whiteout 表示删除下层路径；`rootfs.diff_ids` 是未压缩摘要，与 manifest 里压缩 blob 的 digest 是两套值。
5. **OCI layout 让引擎能直接消费**：`blobs/<alg>/<encoded>` + `oci-layout` + `index.json` 纯内容寻址；这是 containerd 这类 content store 能原样吃 OCI 镜像的结构原因。
6. **bundle 只有两样东西**：根部 `config.json` + `root.path` 指向的 rootfs；runtime 不解析镜像、不拉镜像。
7. **生命周期核心是 create/start 分离**：create 建环境但 MUST NOT 跑用户程序；state 有 creating/created/running/stopped 四态。
8. **hooks 六字段的区分维度是「时机 + namespace」**：createRuntime/poststart/poststop 在 runtime namespace，createContainer/startContainer 在 container namespace；`prestart` 已 deprecated。
9. **runc 没有 daemon**：create 成功后 `os.Exit` 走人；容器 init 是 `runc` 二进制的 re-exec（`/proc/self/exe init`），namespace 切分由 nsenter 的 C 构造函数在 Go runtime 之前完成。
10. **create→start 的信号是命名管道 `exec.fifo`**：init 在 execve 前阻塞写 `"0"`，`runc start` 阻塞打开读端；fifo 存在 = created，被 start 删除 = running。
11. **runc 状态全在磁盘**：`<root>/<id>/state.json` + `exec.fifo`，`--root` 默认 `/run/runc`（tmpfs），因此任意 runc 进程都能接管同一容器。
12. **最容易讲错的一句**：「runc 是容器运行时」不够准确——它是 OCI runtime 的 CLI **参考实现**；containerd/CRI 才是上层编排入口，runc 只负责 create/start/exec/delete 这层系统调用编排。

## 附录：证据自检

所有链接都用脚本校验过：① 从链接拆出 `<repo>/<path>`，确认 `.repos/upstream/<repo>/<path>` 存在；② 校验链接中的 40 位 commit 与本地 `git rev-parse HEAD` 一致；③ 解析 `#Lx-Ly`，确认 `1 <= x <= y <= 文件总行数`；④ 对每个带行号的摘录块，用 `sed -n` 取出本地内容并与摘录关键行做 `grep -F` 比对确认命中。代码摘录均 ≤25 行；无法本地验证的内容已标「待核实」。
