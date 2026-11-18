# RuntimeClass 调研笔记：API / kubelet 解析链 / 调度与开销 / handler 生态

> 版本锚点：kubernetes **v1.37.2**（`c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32`）、containerd **v2.4.2**（`b7a25261e029d68978bbf290df0a62fc819b3c51`）、CRI-O **v1.37.4**（`c11d3e70365ab7a671894258601d54091ec384cf`）、cri-api **v0.37.2**（`d279f3cbb9d18b653d5fab12e187589914329c77`）。
>
> 方法：结论全部来自本地 sparse checkout，行号用 `nl -ba` 确认；链接是同一 commit 的 GitHub 固定链接。外部语义引用 K8s 官网 RuntimeClass 页面（本地副本 `.repos/upstream/runtime-class.md`）与 KEP-585。
>
> 一句话：RuntimeClass 是**集群级的「运行时选择器 + 调度约束 + 资源开销声明」**，它本身不提供任何隔离；真正执行的是 CRI 实现按 `handler` 找到的那份运行时配置。

## 1. RuntimeClass 是什么

### 结论

- `node.k8s.io/v1`，**集群级（非命名空间）**资源；`v1` 自 1.20 GA（1.12 alpha → 1.14/1.16 beta → 1.20 stable）。
- 只有三块语义：`handler`（必填、DNS Label、不可变）、`overhead.podFixed`（PodOverhead）、`scheduling.{nodeSelector,tolerations}`。
- 名字有两套校验：Pod 里的 `runtimeClassName` 是 RuntimeClass **对象名**（DNS subdomain），`handler` 是 **DNS label**（≤63）。
- 1.37.2 类型上的 `+k8s:beta(since:"1.37")` / `+k8s:alpha(since:"1.37")` 是 **declarative validation 规则**的成熟度标记，**不是**字段生命周期（字段早已 GA）。

### 证据：API 类型（handler 约束 + overhead/scheduling）

`staging/src/k8s.io/api/node/v1/types.go` L52-L64：

```go
	// The Handler must be lowercase, conform to the DNS Label (RFC 1123) requirements,
	// and is immutable.
	// +required
	// +k8s:beta(since: "1.37")=+k8s:format="k8s-short-name"
	// +k8s:beta(since: "1.37")=+k8s:immutable
	// +k8s:beta(since: "1.37")=+k8s:required
	Handler string `json:"handler" protobuf:"bytes,2,opt,name=handler"`

	// overhead represents the resource overhead associated with running a pod ...
	Overhead *Overhead `json:"overhead,omitempty" protobuf:"bytes,3,opt,name=overhead"`
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/node/v1/types.go#L52-L72

`Scheduling` 字段在 L66-L72（带 `+k8s:alpha` 验证标记），其合并语义写在注释里（同文件 L84-L101）：nodeSelector "merged with a pod's existing nodeSelector. Any conflicts will cause the pod to be rejected in admission"；tolerations "appended (excluding duplicates) ... effectively unioning"。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/api/node/v1/types.go#L82-L101

- 对象名 DNS subdomain + `handler` 必填/DNS label：`pkg/apis/node/validation/validation.go` L44-L63；`handler` 不可变在 L65-L72。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/apis/node/validation/validation.go#L44-L72
- Pod 侧 `spec.runtimeClassName` 是 DNS subdomain：`pkg/apis/core/validation/validation.go` L360-L366。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/apis/core/validation/validation.go#L360-L366
- 集群级：`pkg/registry/node/runtimeclass/strategy.go` L47-L50 `NamespaceScoped() bool { return false }`。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/registry/node/runtimeclass/strategy.go#L47-L50
- GA 1.20 / KEP：类型文件 `+k8s:prerelease-lifecycle-gen:introduced=1.20`（L24-L27）；官网文档 https://kubernetes.io/docs/concepts/containers/runtime-class/ ；KEP-585 https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/585-runtime-class ；PodOverhead 单列 KEP-688。

## 2. 端到端解析链：`Pod.spec.runtimeClassName` → CRI `runtime_handler`

### 结论（5 步）

1. **API server 创建时**：默认开启的 `RuntimeClass` admission plugin 用 informer lister 查 RuntimeClass；查不到 → **直接 Forbidden 拒绝创建**（不会留给 kubelet 去失败）。
2. **kubelet 启动时**：`runtimeclass.NewManager(kubeDeps.KubeClient)` 建 informer + lister，`Start()` 同步（`kubelet.go` L745-L747）。
3. **建 sandbox 前**：`LookupRuntimeHandler(pod.Spec.RuntimeClassName)` 把「RuntimeClass 名」翻译成 handler；`nil`/`""` → `""`（默认运行时），NotFound → error。
4. **写 CRI 的位置**：handler 是 **`RunPodSandbox(ctx, podSandboxConfig, runtimeHandler)` 的第三个参数**；`PodSandboxConfig` 里**没有** `runtime_handler` 字段。
5. **CRI 实现**：按 handler 查自己的 runtimes 表；查不到 → 报错，kubelet 记 `FailedCreatePodSandBox` 事件并重试。

### 证据 1：kubelet 的 handler 翻译点

`pkg/kubelet/runtimeclass/runtimeclass_manager.go` L61-L78：

```go
func (m *Manager) LookupRuntimeHandler(runtimeClassName *string) (string, error) {
	if runtimeClassName == nil || *runtimeClassName == "" {
		// The default RuntimeClass always resolves to the empty runtime handler.
		return "", nil
	}
	name := *runtimeClassName
	rc, err := m.lister.Get(name)
	if err != nil {
		if errors.IsNotFound(err) {
			return "", err
		}
		return "", fmt.Errorf("failed to lookup RuntimeClass %s: %v", name, err)
	}
	return rc.Handler, nil
}
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/runtimeclass/runtimeclass_manager.go#L61-L78

### 证据 2：handler 写入 CRI 的唯一位置（sandbox 创建）

`pkg/kubelet/kuberuntime/kuberuntime_sandbox.go` L59-L71：

```go
	runtimeHandler := ""
	if m.runtimeClassManager != nil {
		runtimeHandler, err = m.runtimeClassManager.LookupRuntimeHandler(pod.Spec.RuntimeClassName)
		if err != nil {
			message := fmt.Sprintf("Failed to create sandbox for pod %q: %v", format.Pod(pod), err)
			return "", message, err
		}
		if runtimeHandler != "" {
			logger.V(2).Info("Running pod with runtime handler", "pod", klog.KObj(pod), "runtimeHandler", runtimeHandler)
		}
	}
	podSandBoxID, err := m.runtimeService.RunPodSandbox(ctx, podSandboxConfig, runtimeHandler)
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_sandbox.go#L59-L71

CRI proto 里 `runtime_handler` 是 `RunPodSandboxRequest` 的字段 2（与 `config = 1` 平级）：`cri-api/pkg/apis/runtime/v1/api.proto` L627-L636；`PodSandboxConfig` 定义在同文件 L578-L625，无该字段；另有两个回声 `PodSandboxStatus.runtime_handler`（L716-L718）与 `PodSandbox.runtime_handler`（L777），镜像拉取用 `ImageSpec.runtime_handler`（L966-L969）。
固定链接：https://github.com/kubernetes/cri-api/blob/d279f3cbb9d18b653d5fab12e187589914329c77/pkg/apis/runtime/v1/api.proto#L627-L636

### 证据 3：admission 在创建阶段就拒掉「RuntimeClass 不存在」

`plugin/pkg/admission/runtimeclass/admission.go` L148-L160（lister 未命中后再做一次 live get，仍 NotFound 则 Forbidden）：

```go
	runtimeClass, err = r.runtimeClassLister.Get(*pod.Spec.RuntimeClassName)
	if apierrors.IsNotFound(err) {
		// if not found, our informer cache could be lagging, do a live lookup
		runtimeClass, err = r.runtimeClassClient.Get(ctx, *pod.Spec.RuntimeClassName, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return pod, nil, admission.NewForbidden(attributes, fmt.Errorf("pod rejected: RuntimeClass %q not found", *pod.Spec.RuntimeClassName))
		}
	}
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/plugin/pkg/admission/runtimeclass/admission.go#L148-L160

### 三种情况的行为对照（官方文档语义 vs 代码现实）

| 情况 | 代码位置 | 实际行为 |
|---|---|---|
| `runtimeClassName` 为 nil/空 | manager L62-L65；proto L631-L633；containerd `config.go` L712-L714 | handler = `""`，CRI 用默认运行时（containerd `default_runtime_name` / CRI-O `default_runtime`） |
| RuntimeClass 对象不存在 | admission L153-L160 | **Pod 创建被拒**（`Forbidden: pod rejected: RuntimeClass "x" not found`），Pod 不会出现 |
| RuntimeClass 在，但节点 CRI 没有该 handler | containerd `internal/cri/config/config.go` L716-L719；CRI-O `internal/oci/oci.go` L127-L131 | `RunPodSandbox` 报错 → `FailedCreatePodSandBox` 事件 + `CreatePodSandboxError`，持续重试 |

官网说「...the pod will enter the `Failed` terminal phase」，KEP-585 也说 "the Kubelet will fail the Pod"，但 v1.37.2 的 kubelet 只是记事件后 return：`pkg/kubelet/kuberuntime/kuberuntime_manager.go` L1732-L1753（`createSandboxResult.Fail(kubecontainer.ErrCreatePodSandbox, msg)` + `Eventf(... FailedCreatePodSandBox ...)`），`grep PodFailed pkg/kubelet` 里没有 handler 解析失败 → `phase=Failed` 的分支。所以现实更可能是 **Pending + 反复事件**；「Failed 终态」**待核实**（需 e2e 佐证）。
固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L1732-L1753

## 3. 调度与开销：admission 合并 + overhead 记账

### 结论

- **`scheduling.nodeSelector` / `tolerations` 的合并全部在 `plugin/pkg/admission/runtimeclass/admission.go` 的 `setScheduling`**（L187-L217）：不是 scheduler 插件，也不在 component-helpers。该插件默认开启，且只处理 **Pod CREATE**。
- nodeSelector 逐 key 合并，**同 key 不同值 → Forbidden「conflict」**；tolerations 用 `pkg/util/tolerations.MergeTolerations`（并集 + superset 去重）后写回 `pod.Spec`。
- overhead 由同一个 plugin 的 `setOverhead`（L166-L185）写入 `Pod.Spec.Overhead`；scheduler 通过 `component-helpers/resource.PodRequests()` 把它计入 requests。
- kubelet 侧 overhead **不只是账本**：会作为 `LinuxPodSandboxConfig.Overhead` 传给 CRI 放大 pod-level cgroup，容器侧再减掉避免重复计数。

### 证据 1：setScheduling（合并 nodeSelector + tolerations 的位置）

`plugin/pkg/admission/runtimeclass/admission.go` L196-L217：

```go
	runtimeNodeSelector := nodeScheduling.NodeSelector
	newNodeSelector := pod.Spec.NodeSelector
	if newNodeSelector == nil {
		newNodeSelector = runtimeNodeSelector
	} else {
		for key, runtimeClassValue := range runtimeNodeSelector {
			if podValue, ok := newNodeSelector[key]; ok && podValue != runtimeClassValue {
				return admission.NewForbidden(a, fmt.Errorf("conflict: runtimeClass.scheduling.nodeSelector[%s] = %s; pod.spec.nodeSelector[%s] = %s", key, runtimeClassValue, key, podValue))
			}
			newNodeSelector[key] = runtimeClassValue
		}
	}
	newTolerations := tolerations.MergeTolerations(pod.Spec.Tolerations, nodeScheduling.Tolerations)
	pod.Spec.NodeSelector = newNodeSelector
	pod.Spec.Tolerations = newTolerations
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/plugin/pkg/admission/runtimeclass/admission.go#L196-L217

`Admit` 的顺序是 `setOverhead` → `setScheduling`（L94-L114）；插件只处理 Create（L134-L139 `admission.NewHandler(admission.Create)`），`Admit` 顺序见 L94-L114。默认开启：`pkg/kubeapiserver/options/plugins.go` L96（有序表）与 L179（`defaultOnPlugins`）。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/plugin/pkg/admission/runtimeclass/admission.go#L94-L114 ｜ `MergeTolerations`（`pkg/util/tolerations/tolerations.go` L45-L70）链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/util/tolerations/tolerations.go#L45-L70

### 证据 2：setOverhead（overhead 写入 `Pod.Spec.Overhead`）

同文件 L177-L182：

```go
	// reject pod if Overhead is already set that differs from what is defined in RuntimeClass
	if len(pod.Spec.Overhead) > 0 && !apiequality.Semantic.DeepEqual(nodeOverhead.PodFixed, pod.Spec.Overhead) {
		return admission.NewForbidden(a, fmt.Errorf("pod rejected: Pod's Overhead doesn't match RuntimeClass's defined Overhead"))
	}
	pod.Spec.Overhead = nodeOverhead.PodFixed
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/plugin/pkg/admission/runtimeclass/admission.go#L166-L185

`Validate` 阶段复核 overhead（L219-L237），并拒绝「没有 RuntimeClass 却设了 overhead」的 Pod。字段注释也写明该字段只能由这个 admission 控制器设置：`staging/src/k8s.io/api/core/v1/types.go` L4568-L4576。

### 证据 3：scheduler 如何消费 overhead 与合并后的约束

overhead 进 requests 的统一入口 `staging/src/k8s.io/component-helpers/resource/helpers.go` L167-L170（函数 L152-L173）：

```go
	// Add overhead for running a pod to the sum of requests if requested:
	if !opts.ExcludeOverhead && pod.Spec.Overhead != nil {
		addResourceList(reqs, pod.Spec.Overhead)
	}
```

固定链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/staging/src/k8s.io/component-helpers/resource/helpers.go#L152-L173

消费点：`NodeResourcesFit` 的 PreFilter `computePodResourceRequest`（`pkg/scheduler/framework/plugins/noderesources/fit.go` L320-L330）与 `PodInfo.CalculateResource`（`pkg/scheduler/framework/types.go` L1385-L1391）都走 `resource.PodRequests`。合并后的 nodeSelector 由 NodeAffinity 插件消费（`nodeaffinity.GetRequiredNodeAffinity(pod)` 内部读 `pod.Spec.NodeSelector`，`staging/.../nodeaffinity/nodeaffinity.go` L305-L318；调用点 `pkg/scheduler/framework/plugins/nodeaffinity/node_affinity.go` L121）；tolerations 由 TaintToleration 插件消费（`taint_toleration.go` L125 用 `pod.Spec.Tolerations`）。

### 证据 4：kubelet 把 overhead 落到 pod-level cgroup

`applySandboxResources` 里两行就是落地点：`kuberuntime_sandbox_linux.go` L74-L75 `config.Linux.Resources = m.calculateSandboxResources(...)`、`config.Linux.Overhead = m.convertOverheadToLinuxResources(pod)`。overhead 被当作「requests == limits 的 guaranteed 资源」（L34-L46）；容器侧再由 `subtractOverheadFromResourceConfig` 从 pod 总量里减掉（`helpers_linux.go` L26-L61，调用点 `kuberuntime_container_linux.go` L343-L352）。链接：https://github.com/kubernetes/kubernetes/blob/c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32/pkg/kubelet/kuberuntime/kuberuntime_sandbox_linux.go#L34-L78

## 4. handler → 运行时配置映射

### 结论

- 映射在 **CRI 实现的配置文件**里：`RuntimeClass.spec.handler` 必须精确等于 runtimes 表的 **key**。
- containerd 2.x：插件 ID 是 `io.containerd.cri.v1.runtime`（配置 `version = 3`），表为 `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.<handler>]`，字段 `runtime_type` / `runtime_path` / `sandboxer` / `base_runtime_spec` / `snapshotter`；默认 handler 由 `default_runtime_name` 指定。
- containerd 1.x：同一张表在 `[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.<handler>]`（`version = 2`，2.x 仍接受并自动转 v3）。
- CRI-O：`[crio.runtime.runtimes.<handler>]`，字段 `runtime_path` / `runtime_type`（`oci`|`vm`|`pod`）/ `runtime_root` / `runtime_config_path`；默认 `[crio.runtime].default_runtime = "crun"`。

### 证据 1：containerd 2.x 的 runtimes 表（官方示例）

`docs/cri/config.md` L88-L108：

```toml
version = 3
[plugins."io.containerd.cri.v1.runtime".containerd]
  default_runtime_name = "crun"
  [plugins."io.containerd.cri.v1.runtime".containerd.runtimes]
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.crun]
      runtime_type = "io.containerd.runc.v2"
      [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.crun.options]
        BinaryName = "/usr/local/bin/crun"
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.gvisor]
      runtime_type = "io.containerd.runsc.v1"
    [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.kata]
      runtime_type = "io.containerd.kata.v2"
```

固定链接：https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/docs/cri/config.md#L88-L108

配套 RuntimeClass/Pod 示例在同文档 L128-L158。插件 ID 的来源：类型 `io.containerd.cri.v1`（`plugins/types.go` L76-L77）+ ID `runtime`（`plugins/cri/runtime/plugin.go` L47-L56）。2.x 的完整可配字段见 L283-L308；配置版本 3 「Several plugin IDs have changed」见 L340-L347；runtimes 表 key 即 CRI RuntimeHandler 字符串见 L519-L522。1.x 写法（`version = 2` + `io.containerd.grpc.v1.cri`）见 L109-L126。

### 证据 2：CRI-O 的 runtimes 表

`docs/crio.conf.5.md` L351-L372（节选，行内合并排版）：

```
The "crio.runtime.runtimes" table defines a list of OCI compatible runtimes. The runtime to use is picked based on the runtime handler provided by the CRI. If no runtime handler is provided, the runtime will be picked based on the level of trust of the workload.
**runtime_path**=""           Path to the OCI compatible runtime used for this runtime handler.
**runtime_type**="oci"        Valid values: "oci" (runc/crun), "vm" (Kata 等 shimv2/ttrpc，runtime_path 必须是 containerd-shim-*), "pod" (conmon-rs)
**runtime_config_path**=""    Path to the runtime configuration file, should only be used with VM runtime types
```

固定链接：https://github.com/cri-o/cri-o/blob/c11d3e70365ab7a671894258601d54091ec384cf/docs/crio.conf.5.md#L351-L372 ｜ 默认运行时 L122-L123：同上文件 #L118-L123

### 证据 3：两个实现的行为差异

- containerd：空 handler → `default_runtime_name`；未知 handler → `no runtime for %q is configured`（`internal/cri/config/config.go` L712-L719）。链接：https://github.com/containerd/containerd/blob/b7a25261e029d68978bbf290df0a62fc819b3c51/internal/cri/config/config.go#L712-L720
- CRI-O：空 handler 直接放行（`server/sandbox_run.go` L56-L59），之后**可能按 workload 信任级别**挑运行时；未知 handler → `failed to find runtime handler ...`（`internal/oci/oci.go` L127-L131）。链接：https://github.com/cri-o/cri-o/blob/c11d3e70365ab7a671894258601d54091ec384cf/internal/oci/oci.go#L118-L135

## 5. 典型实现与可直接粘贴的配置

| handler（示例） | 实现 | CRI 侧配置 | 隔离级别 |
|---|---|---|---|
| `runc` / `crun` / 省略 | OCI runtime | containerd `runtime_type="io.containerd.runc.v2"`（可配 `options.BinaryName`）；CRI-O `runtime_type="oci"`+`runtime_path` | 内核 namespace/cgroup（共享 host kernel） |
| `runsc`（gVisor 官方示例） | gVisor | containerd `runtime_type="io.containerd.runsc.v1"`，shim `containerd-shim-runsc-v1` | 用户态内核（Sentry），OCI 语义 |
| `kata` / `kata-qemu` | Kata Containers | containerd `runtime_type="io.containerd.kata.v2"`；CRI-O `runtime_type="vm"`+`runtime_path=containerd-shim-kata-v2` | VM 级，shim 作为 VM 代理 |
| `spin` | Wasm/runwasi | containerd `runtime_type="io.containerd.spin.v2"`，shim `containerd-shim-spin-v2` | 无内核（WASI 沙箱） |

**RuntimeClass 不提供隔离**，只做三件事：选 handler、把调度约束合进 Pod、声明 overhead；隔离由 handler 背后的运行时决定。

RuntimeClass + Pod 示例：

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }          # 集群级；Pod 用这个名字
handler: runsc                      # 必须等于节点 CRI 配置里 runtimes 的 key
overhead: { podFixed: { cpu: 250m, memory: 64Mi } }
scheduling:
  nodeSelector: { sandbox: gvisor } # 只调度到支持节点
  tolerations:
  - { key: sandbox, operator: Equal, value: "true", effect: NoSchedule }
---
apiVersion: v1
kind: Pod
metadata: { name: nginx-gvisor }
spec:
  runtimeClassName: gvisor
  containers: [{ name: nginx, image: nginx }]
```

containerd 2.x 片段：

```toml
version = 3
[plugins.'io.containerd.cri.v1.runtime'.containerd]
  default_runtime_name = 'runc'
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc]
    runtime_type = 'io.containerd.runc.v2'
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
    runtime_type = 'io.containerd.runsc.v1'
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.kata]
    runtime_type = 'io.containerd.kata.v2'
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.spin]
    runtime_type = 'io.containerd.spin.v2'
```

（字段/层级对应 `docs/cri/config.md` L283-L308，`SystemdCgroup` 等 options 见 L34-L36 与 L300-L308；spin 的 `io.containerd.spin.v2` 见 SpinKube README https://github.com/spinframework/containerd-shim-spin）

CRI-O 1.37 片段：

```toml
[crio.runtime]
default_runtime = "crun"
[crio.runtime.runtimes.runc]
  runtime_path = ""
  runtime_type = "oci"
[crio.runtime.runtimes.kata]
  runtime_type = "vm"                                   # Kata 走 shimv2
  runtime_path = "/usr/bin/containerd-shim-kata-v2"      # 以发行版实际路径为准
  runtime_config_path = "/usr/share/defaults/kata-containers/configuration-qemu.toml"
```

## 6. 常见坑

1. **handler 名 ≠ 二进制名 ≠ RuntimeClass 名。** 必须精确等于节点 CRI 配置的 runtimes key：containerd 官方示例把 gVisor 的 key 叫 `gvisor`，gVisor 官方 quickstart 叫 `runsc`，两种都行；写错就报 `no runtime for "x" is configured`。
2. **「同名 handler 在所有节点等价」只是假设。** 类型注释写明 "It is assumed that all handlers are available on every node, and handlers of the same name are equivalent on every node"（`types.go` L44-L51）。只在部分节点装了 gVisor 却全集群用 → 落到没该 handler 的节点会一直 sandbox 失败，必须配 `scheduling.nodeSelector` + 节点 label。
3. **RuntimeClass 不存在时错误在创建阶段。** admission 直接 Forbidden，而不是「Pod 会 Failed」；文档那句 Failed terminal phase 与 v1.37.2 代码路径对不上（见 §2）。
4. **RuntimeClass 是集群级、无命名空间边界**，写权限应收敛给管理员；KEP-585 也说明对 RuntimeClass 的使用本身没有授权限制——能建 Pod 就能选任意 RuntimeClass，需要额外策略约束。
5. **admission 只处理 Pod CREATE**：已存在的 Pod 不会因 RuntimeClass 变更重新合并 nodeSelector/tolerations 或重算 overhead；Pod 里看到的是合并后的值，与用户原始 manifest 不同。
6. **overhead 不是「只影响调度账本」**：它会放大 pod-level cgroup（`LinuxPodSandboxConfig.Overhead`），Pod 不能自带 overhead，且 `podFixed` 校验复用容器资源校验（`node/validation/validation.go` L74-L78）。
7. **containerd 2.x 插件 ID 变了**：旧路径 `io.containerd.grpc.v1.cri` 是 1.x（`version=2`）写法，2.x 用 `io.containerd.cri.v1.runtime`（`version=3`）；写错时自定义 runtime 不生效，表现为 handler 找不到（具体报错形态**待核实**）。
8. **CRI 实现配置格式完全不同**：containerd 是 `runtimes.<handler>.runtime_type`（shim 名），CRI-O 是 `runtimes.<handler>.{runtime_path,runtime_type}`，且 CRI-O 的 `runtime_type` 有 `oci|vm|pod` 三值（Kata 用 `vm`），不能照抄。
9. **1.37 的类型注解易误读**：`handler` 的 `+k8s:beta(since:"1.37")`、`scheduling`/`tolerations` 的 `+k8s:alpha(since:"1.37")` 是 declarative validation 的成熟度，不是字段退回 alpha/beta。
10. **官网文档有过时表述**：`runtime-class.md` L59-L60 说 "currently only has 2 significant fields"，实际已有 `overhead` 与 `scheduling`。

## 关键结论

1. RuntimeClass = 集群级 `node.k8s.io/v1`，三块语义：`handler`（选运行时配置）、`overhead.podFixed`（调度开销）、`scheduling.{nodeSelector,tolerations}`（调度约束）；**不提供隔离**。
2. `handler` 是 DNS Label、必填、不可变；`runtimeClassName` 是 DNS subdomain、指向对象名。校验点：`pkg/apis/node/validation/validation.go` L44-L72、`pkg/apis/core/validation/validation.go` L360-L366。
3. kubelet 解析入口：`pkg/kubelet/runtimeclass/runtimeclass_manager.go` L61-L78 的 `LookupRuntimeHandler`（informer/lister；nil/空 → `""`；NotFound → error）。
4. **handler 写入 CRI 的位置是 `kuberuntime_sandbox.go` L59-L71 的 `RunPodSandbox(ctx, config, runtimeHandler)` 第三参**，不是 `PodSandboxConfig.runtime_handler`（proto 里该字段属于 `RunPodSandboxRequest`，field 2）。
5. `scheduling` 合并在 `plugin/pkg/admission/runtimeclass/admission.go` 的 `setScheduling`（L187-L217）：nodeSelector 逐 key 合并、冲突 Forbidden；tolerations 用 `MergeTolerations` 取并集+superset 去重。插件默认开启、只处理 Create。
6. overhead 由同插件 `setOverhead`（L166-L185）写入 `Pod.Spec.Overhead`；scheduler 通过 `component-helpers/resource.PodRequests`（L167-L170）计入 requests，`NodeResourcesFit`/`PodInfo` 均依赖。
7. kubelet 侧 overhead 实际生效：`applySandboxResources` 传给 CRI 放大 pod-level cgroup（`kuberuntime_sandbox_linux.go` L69-L78），容器侧再减掉避免重复计数。
8. handler → 运行时映射在 CRI 配置：containerd 2.x `[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.<handler>]` + `runtime_type`；CRI-O `[crio.runtime.runtimes.<handler>]` + `runtime_path`/`runtime_type`。空 handler 回落到 `default_runtime_name` / `default_runtime`。
9. 「RuntimeClass 不存在 → Pod Failed」是文档/KEP 说法；v1.37.2 主要路径是 admission 创建时 Forbidden，sandbox 失败只产生事件并重试（Pending）。**待核实**：e2e 是否存在 Failed 终态。
10. 生产上最容易翻车的是异构节点：要么全集群都配同一 handler，要么给支持节点打 label/taint 并用 `scheduling` 把 Pod 圈过去。

## 附：链接与行号自检

- 行号均用 `nl -ba` 在本地 checkout 确认；链接使用与本地一致的 commit sha（k8s `c50e5395`、containerd `b7a2526`、cri-o `c11d3e7`、cri-api `d279f3c`）。
- 已抽查 HTTP 200：k8s `plugin/pkg/admission/runtimeclass/admission.go`、`staging/src/k8s.io/api/node/v1/types.go`、containerd `docs/cri/config.md`、cri-o `docs/crio.conf.5.md`、cri-api `pkg/apis/runtime/v1/api.proto`。
- 本地 `kubernetes/staging/src/k8s.io/cri-api/.../api.proto` 与独立 `cri-api` 仓库同版本文件 `diff` 一致；官网文档正文副本 `.repos/upstream/runtime-class.md` 的短代码标记未计入行号，引用其语义时只给页面 URL。
