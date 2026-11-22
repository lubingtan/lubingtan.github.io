# Operation Log

## [2026-11-22] ingest | Kubernetes 网络全链路与多集群互联

以本地源码/文档为主要证据，补齐 Kubernetes 网络专题。基线：`kubernetes@c50e5395`（v1.37.2）、`containerd@b7a25261`（v2.4.2）、CNI spec 1.1.0（`42e11794`）、CNI plugins（`0581b429`）、`coredns@996a30df`、`mcs-api@a3bfd21f`、`submariner@a920c26e`、`metallb@0db4a44c`、`gateway-api@d04e7458`；关键行号均用本地 checkout 核对，并用 `verify-links.py` 校验固定 commit 的 permalink。

- 新建 `k8s-network-path.md`：以"四张地址表 + 五层数据面"为主线，给出 Pod→Pod（同节点/underlay/overlay）、Pod→Service（PREROUTING→KUBE-SERVICES→KUBE-SVC→KUBE-SEP→DNAT→conntrack 回程）、外部→Service（NodePort/LB/Ingress/Gateway）、DNS（resolv.conf/search/ndots/CoreDNS/NodeLocal）、出集群 NAT 的完整路径；附抓包证据地图、L0–L7 检查表、12 个经典案例。重点澄清 `br_netfilter` 对同节点 Service 回包的作用、hairpin SNAT 的边界、`REJECT` vs `DROP`、IPVS 1.40/1.43 退场与 nftables 1.33 GA 但默认仍是 iptables。
- 重写 `cni详解.md`（原为 ~3KB 笔记）：CNI 边界与 6 个动词（ADD/DEL/CHECK/GC/STATUS/VERSION）、kubelet→CRI→containerd→go-cni→libcni→插件的调用链，纠正"netns 由 CNI 创建"的误解（实为 containerd 在 pause sandbox 阶段 unshare+bind mount）；bridge/host-local/portmap/bandwidth/tuning 的逐插件行为与源码；ptp/ipvlan/macvlan 对比；NodeIPAM 与静态/BGP/overlay/云路由；VXLAN/IPIP/Geneve/WireGuard/MTU 算术；host-local 磁盘状态与 IP 耗尽；CNI ipMasq 与 kube-proxy SNAT 的边界；NetworkPolicy 数据面（iptables/ipset/eBPF）；kindnet 的真实构成；故障表与 `crictl/nsenter` 命令。
- 重写 `6_service相关.md`（原为未完成的笔记）：Service 四类型与默认值、headless/ExternalName/无 selector、EndpointSlice 结构与 ready/serving/terminating 语义、100 端点/片、topology hints 与 `trafficDistribution`（1.37 的 PreferSameZone/PreferSameNode/PreferClose）；kube-proxy 的 informer→tracker→sync 骨架与 1s/30s 周期；iptables 模式 1.37 的链布局（`KUBE-SERVICES/EXTERNAL-SERVICES/NODEPORTS/POSTROUTING/MARK-MASQ/FORWARD/PROXY-FIREWALL`、`KUBE-SVC/SVL/EXT/FW/SEP`），纠正旧资料里的 `KUBE-XLB-*`/`KUBE-MARK-DROP`；IPVS 的 `kube-ipvs0`/ipset/sysctl 与弃用；nftables 的 map/set/hairpin；conntrack 与 UDP 陈旧条目清理；ETP/ITP/双栈；云 CCM 与 MetalLB L2（active-passive）/BGP（ECMP）、kube-vip/DSR；Ingress 冻结与 Gateway API 角色分离、GEP-1748。
- 新建 `multicluster-networking.md`：四种连通模型（flat L3/网关隧道/service export-import/DNS-only）、成员集群与成员地址的精确定义及在 Submariner/Cilium/MCS/Karmada 中的落点、地址重叠与 Globalnet/Liqo；MCS-API 只有 ServiceExport/ServiceImport 两个 CRD（无 ClusterSet CRD）、EndpointSlice 导出标签、`clusterset.local`、冲突按最老 export 胜出、MCS 不是数据面；Submariner 组件/cable/端口（纠正 500/udp、4800、8080 三个常见错误）/NAT-T/Globalnet/数据路径；Cilium ClusterMesh 的前置条件、Global Service、策略、MCS；Istio/Liqo/Skupper/Karmada 对比；跨集群 DNS 与 search/ndots 坑；信任域/NAT/MTU；排障 runbook 与选型。
- 交叉引用：四页互相链接，并在 `index.md` 更新摘要；`SUMMARY.md` 由 `make gen-summary` 重新生成。

## [2026-11-22] update | 补充 owned resources 的 diff 与默认值处理

针对“`Owns` 触发后如何比较 desired/live”补充 `production-operator.md` §7.6：

- 说明 `Owns` 只负责子资源事件 → owner 入队，不做 diff；默认只看 `controller: true` 的 ownerReference。
- 新增 §7.6.1：解释 Deployment/Pod 创建后 API Server 会填充 `replicas=1`、`strategy`、`revisionHistoryLimit`、`progressDeadlineSeconds`、`restartPolicy`、`dnsPolicy`、`schedulerName`、`terminationGracePeriodSeconds`、`imagePullPolicy` 等默认值，因此“部分 desired spec”和 live spec 必然有差异。
- 新增 §7.6.2：推荐 SSA，只 apply controller 拥有的字段，依赖 `managedFields`，不对 HPA/用户字段盲目 `ForceOwnership`；并说明省略 owned 字段会导致删除/重置。
- 新增 §7.6.3：GET live → DeepCopy before → 只改 owned 字段 → 比较 before/after → `Patch`，避免全量 `Update` 覆盖默认值；引用 `CreateOrUpdate` 对默认值字段的警告。
- 新增 §7.6.4：`apiequality.Semantic.DeepDerivative(desired, live)` 的语义与边界（忽略 nil/空 string/slice/map，不忽略零值 int/bool，无法表达清空）。
- 新增 §7.6.5：SSA / GET+patch / DeepDerivative / 全量 Update 的选择表，以及 HPA、清空字段、status-only 事件的注意事项。

**验证**：`make build` 通过；97 条 pinned GitHub 链接全部 verified、`bad=0`；121 个外部 URL 全部 2xx；9 条相对链接 `missing=0`。

## [2026-11-22] update | 重写 client-go List/Watch 并改用英文文件名

把 `5_client-go list & watch 原理.md` 重写并改名为 `client-go-list-watch.md`（符合 AGENTS.md 的短英文 + 连字符命名约定），从原来的 apiserver watch 片段扩展为 654 行的完整链路：

- **API 语义**：`resourceVersion` 的 get/list/watch 语义表、`resourceVersionMatch`、`410 Gone`/`Too large resource version`、bookmark、streaming list（WatchList）、分页 `limit`/`continue`。
- **服务端**：`ListResource` → `handleWatch`（30–60 分钟随机超时）→ `WatchServer`（WebSocket/chunked）→ `Cacher.Watch`（B-tree 对象 + 75s 事件历史 + 429 初始化保护）→ `etcd3.watcher`（RangeStream/分页 sync + `clientv3.Watch`）。
- **client-go**：`ListWatch`（只是两个函数）→ `Reflector`（list RV 选择、410 回退、watch 重连、bookmark）→ `WatchList`（临时 Store + initial-events-end bookmark）→ `DeltaFIFO`（按 key 累积/dedup/Replace）→ `SharedIndexInformer`（Controller/processDeltas/HasSynced）→ `sharedProcessor`（多 handler 与慢 handler 反压）。
- **自定义 watch**：`watch.Interface`/`StreamWatcher`、`RetryWatcher`/`Until`/`UntilWithSync` 的能力边界（尤其 410 与顺序保证）。
- **生产坑**：RV=0、忽略 `watch.Error`、自定义分页、慢 handler、watch 重连风暴（`Request.Watch` 不限速）、启动 `WaitForCacheSync`、resync≠relist、metadata-only/分片/指标排障。

同步更新 `index.md` 及 5 处页面内相对链接；`SUMMARY.md` 由 `make gen-summary` 重新生成。

**验证**：`make build` 通过；62 条 pinned GitHub 链接全部 verified、`bad=0`；70 个外部 URL 全部 2xx；6 条相对链接 `missing=0`。

## [2026-11-22] update | 补充 Operand 术语与 Operator 五级能力说明

针对 `production-operator.md` 中 L2 出现的 Operand 和 Operator SDK 做了澄清：

- 新增 §1.4 术语表：Operator（运维机器人）、Operand（被运维的业务工作负载/服务）、CR（工单）、Managed Resources（实际创建的对象）、CRD（API schema）；明确 Operand 不是 Operator 自己的 Deployment，并用 PostgreSQL 集群举例说明 L2 “管理旧版本 Operand” 的含义。
- 将原 §1.4 的五级能力简表展开为 §1.5 的 L1–L5 分节说明：每级给出目标、具体能力、典型例子和验收问题；补充 SDK = Software Development Kit，以及“L2+L4 是多数生产 Operator 的底线、有状态服务再加 L3、L5 取决于护栏成熟度”的结论。

**验证**：`make build` 通过；页面 pinned 链接仍为 90 条全部 verified、`bad=0`；外部 URL 与相对链接检查通过。

## [2026-11-22] update | kube-apiserver 原理、生产故障与参数调优

把 `Cloud_Native/Kubernetes/2_kubernetes-api-server.md` 从空壳（仅"理解 Kubernetes 证书"两个标题）重写为 710 行的专题页，版本基准 Kubernetes v1.37.2（`c50e5395`）与 etcd v3.7.4（`2e8a5c99`）：

- **原理**：aggregator → kube → apiextensions 三层 server 与 delegate 降级；handler chain 的完整执行顺序（认证 → 审计 → 伪装 → APF → 授权）；准入插件顺序（MAP → mutating webhook → VAP → validating webhook）；写路径 `OptimisticPut(compare mod_revision)` 与冲突重试；读路径四种 `resourceVersion` 语义及 `ShouldDelegateList` 判定；watch cache 在 1.37 的结构（B-tree 全量对象 + 75s 事件历史 + 快照，环形缓冲已移除）；`/registry` key 布局；启动时 cache 初始化与 `storage-readiness` hook。
- **生产故障**：12 个模式（APF 429、OOM、1.5MiB 大对象、LIST 风暴、410/Too large RV、etcd 慢、webhook、聚合 API/CRD 转换、审计阻塞、证书/SA token、LB/HTTP2、升级期 404），每个按症状/机理/定位/处置展开，并附症状→层速查表。
- **调优**：apiserver 并发/缓存/审计参数表与 etcd 参数表（quota、compaction、snapshot-count、heartbeat/election、max-request-bytes、慢盘 warning），apiserver↔etcd 客户端常量，OS/网络/LB 建议，三档容量起点与六条调参禁区。
- **新特性**（1.33–1.37）：WatchList/`WatchListCompression`/`EtcdRangeStream`/`ListFromCacheSnapshot`/`DetectCacheInconsistency`/`ConsistentListFromCacheSkipTimeoutFallback`、`ShardedListAndWatch`、VAP/MAP/`ManifestBasedAdmissionControlConfig`/`DeclarativeValidation`、`ConstrainedImpersonation`/结构化认证授权/KEP-6060、Mixed Version Proxy 与 `--emulated-version`、`WebhookRoundTripLoadBalancing`、`/flagz` `/statusz`。
- **证据**：87 个真实外部 URL 逐一 curl 验证 2xx（另有 3 个 `127.0.0.1:6443` 与 1 个 `apiserver:6443` 示例端点，不作外链校验）；相对链接全部存在；关键结论固定到行号，并对照 v1.36 源码确认 1.37 才移除 watch cache 的 `capacity` 环形缓冲。

同步更新 `index.md` 条目与 `SUMMARY.md`。

## [2026-11-22] ingest | 生产级 Kubernetes Operator：从 CRD 到状态收敛与升级

Web research + 源码核对，新建 `Cloud_Native/Kubernetes/production-operator.md`（约 1850 行），并写入来源台账 `raw/RESEARCH-k8s-operator.md`。文件名采用短英文 `production-operator.md`（不与 H1 标题相同），该命名约定已写入 `AGENTS.md` 的 Page Conventions。覆盖用户要求的完整链路：

- **CRD**：group/names/scope/versions、structural schema、pruning、defaulting、OpenAPI/CEL/ratcheting、status/scale 子资源、`served`/`storage`/`storedVersions`、conversion（None vs Webhook）、Established/Terminating/删除语义、CRD vs Aggregated API。
- **API Server**：`crdHandler` 如何解析 `<resource>.<group>`、按版本构建 storage（decoder=请求版本、encoder=storage 版本）、admission 与 schema/CEL 顺序、status/scale scope、CRD spec 更新导致 storage 重建、watch cache 初始化保护。
- **List/Watch**：`resourceVersion` 的 get/list/watch 语义表、`resourceVersionMatch`、`410 Gone`/`Too large resource version`、Reflector 的 list-then-watch/回退、bookmark、streaming list（WatchList beta）、客户端/API Server 分片（`ShardSelector` alpha）、metadata-only 与 field selector。
- **Informer/Workqueue**：SharedInformer/DeltaFIFO/Indexer 三层、resync 是“同 RV Update”而非重新 list、workqueue 的 dirty/processing 去重与串行化、rate limiter/Forget、controller-runtime 的 Reconcile 返回语义、cache 读的“写后读”陷阱、启动顺序（webhook→cache→leader election）、指标。
- **API 设计**：spec/status 分离、声明式命名、optional/required 与 pointer、conditions（`metav1.Condition`、listType=map、observedGeneration、polarity）、list/map 拓扑与 SSA、printer columns/selectableFields/scale、v1alpha1→v1 兼容规则、8 条反模式。
- **状态收敛**：Reconcile 骨架（删除优先→finalizer→观察→收敛→status）、transient/terminal/wait 分类、status 冲突重试、依赖顺序、pause、drift、多步状态机。
- **幂等**：name idempotency/409、read-modify-write+RV、SSA field ownership/force 边界、外部副作用的确定性名字/幂等键/标签/两阶段状态/孤儿清理、删除与 status/event 幂等。
- **清理**：ownerReference 同 namespace 限制、background/foreground/orphan、finalizer 机制与 qualified name、finalizer 先于副作用、跨 namespace 清理、卡住 finalizer 排查、CRD 删除=删除所有 CR、孤儿 sweeper。
- **并发**：per-key 串行 vs `MaxConcurrentReconciles`、Lease 选主参数与切换、单活/多活/分片、resourceVersion 冲突、client-go 默认 QPS=5/Burst=10 与 APF、热循环治理、多 controller 字段 ownership。
- **升级**：CRD 版本升级 9 步、conversion webhook HA/证书/监控、StorageVersionMigration/手动迁移、schema 演进矩阵、controller 滚动与 N-1 兼容窗口、OLM `replaces`/`skips`/`skipRange`、回滚边界、升级测试矩阵。
- **可观测性与测试**：controller-runtime/workqueue/APIServer/conversion 指标、告警、日志/事件、envtest/e2e/fuzz/故障注入、62 项生产检查清单。

**证据**：Kubernetes v1.37.2（`c50e5395`）、controller-runtime v0.25.2（`5d8467b3`）、sample-controller（`7204184e`）、Cluster API v1.14.4（`4356c154`）四个 pinned checkout；`verify-links.py` 90 条 pinned GitHub 链接全部 verified、`bad=0`；114 个外部 URL 逐条 curl 全部 2xx；8 条相对链接 missing=0；`make build` 通过。同步更新 `index.md`、`SUMMARY.md`，并在 `.repos/verify-links.py` 增加 controller-runtime/sample-controller 的本地 checkout 映射。与既有页面交叉引用：client-go list & watch、API Server、APF/FlowSchema、控制面 HA、多集群版本升级、Cluster API、Kueue、容器运行时。

## [2026-11-21] update | DevOps 理念与实践迁入 Platform_Engineering 并补全基础篇

将 `Cloud_Native/CICD/devops-thinking.md` 移至 `Cloud_Native/Platform_Engineering/devops-thinking.md`（CICD 目录随之移除），并按“基础篇”定位补全：

- 新增 DevOps 目标（DORA 5、Three Ways）与“平台指标 ≠ 交付指标”的区分；
- CI/CD 部分补充“一次构建多次部署”“小批量与主干开发”，并给 Prow/Tekton 的反例加上“作者观点/早期设计”限定；
- 开发环境部分补充 devcontainer、环境即代码、K8s 隔离级别与环境即服务桥接；
- 新增“从 CI/CD 到平台工程”演进表、“Agent 时代的补充”、常见反模式与阅读地图；
- 更新参考（DORA、Accelerate、The DevOps Handbook、Tekton/Prow、CNCF Platforms White Paper）。

同步更新 5 个专题页的反向链接、`index.md` 分类与 `SUMMARY.md`；页面标题改为《DevOps 理念与实践：从 CI/CD 到平台工程》。

## [2026-11-21] ingest | Agent 时代的 DevOps 与软件交付（平台工程专题）

Web research + synthesis，新建 `Cloud_Native/Platform_Engineering/` 下 6 页，并把来源台账写入 `raw/RESEARCH-agent-era-devops.md`：

- **总览** `agent-era-devops.md`：以 DORA 2025 的“AI 是放大器”为主线，提出“代码供给边际成本趋零 vs 信任边际成本不降”的核心矛盾；三个变化（生产者/平台接口/控制点）、不变原则、五面一核架构、L0–L4 成熟度、8 个新工程问题、四层度量与 5 个专题的阅读地图。
- **平台工程** `platform-as-a-product.md`：平台边界、通用 + AI 能力地图、8 条设计原则、复用四级阶梯、能力契约、黄金路径解剖、Agent-ready 双模接口与安全边界、团队拓扑与 90 天路线。
- **CI/CD 与质量** `ci-cd-quality-gates.md`：参考流水线、可复现构建、制品与 SBOM/SLSA/Sigstore 证据链、测试分层与 flaky 治理、LLM eval（离线/在线/红队）、风险分级门禁、GitOps/金丝雀/回滚、agentic CI 与 CI 攻击面。
- **环境即服务** `environment-as-a-service.md`：环境分类、namespace/vcluster/cluster/account 隔离矩阵、自助交付流水线、Environment 契约示例、数据策略、TTL/空闲回收、配额与成本、容量调度、故障模式与度量。
- **可观测性与稳定性** `observability-and-sre.md`：OTel 信号与资源属性、GenAI/agent 语义约定、SLO 与多窗口燃烧率、性能与容量模型、事故管理与 AI SRE 边界、韧性/混沌/容灾、权限审计与恢复。
- **平台落地** `platform-adoption.md`：四类角色协作与 RACI、规范生命周期、策略例外、工具评估矩阵、AI 工具的数据/成本/安全治理、DORA + DX Core 4/SPACE + 平台指标、四阶段路线图与阻力应对。

来源：DORA 2025、CNCF Platforms White Paper v1.1、GitHub Agentic Workflows GA（2026-10-28）、OpenTelemetry GenAI semconv、SLSA/Sigstore、vCluster/Crossplane/Karpenter/OpenCost 等；厂商遥测仅作方向性证据并已在 raw 台账中标注等级。同步更新 `index.md`、`SUMMARY.md`，并在 `devops-thinking.md` 增加延伸阅读反向链接。

## [2026-11-20] query | 大规模多集群 Kubernetes 版本升级规划与故障处理

用户问"如何规划大规模多集群 K8s 版本升级、升级中会出什么问题以及怎么处理"。按 query 流程把答案沉淀为页面 `src/docs/Cloud_Native/Kubernetes/大规模多集群版本升级.md`（380 行）：

- **约束**：K8s 每年 3 个 minor、维护最近 3 个 minor、约 1 年 patch 支持（用 1.37/1.36/1.35 的 EOL 日期举例）；组件 skew 表（HA apiserver ±1、kubelet -3、kube-proxy、KCM/scheduler/CCM、kubectl ±1，并链到 kubeadm `MinimumControlPlaneVersion`/`MinimumKubeletVersion` 源码）；beta API 9 个月/3 个 minor 的废弃策略与 1.32 移除 flowcontrol v1beta3 的实例；kubeadm/CAPI/EKS 都禁止跳 minor。
- **规划七步法**：舰队盘点（含 `apiserver_requested_deprecated_apis` 指标与审计日志）→ 选目标版本 → 依赖兼容矩阵（CNI/CSI/Ingress/Operator/运行时/OS/云厂商/CAPI）→ 风险分级与 Wave 0–3/soak/并发限制 → 回滚预案（控制面无 downgrade、etcd 快照、节点重装、EKS/GKE 回滚能力）→ 容量与 SLO → 变更管理。
- **执行**：单集群 pre-flight → 控制面（第一台 apply、其余 drain+node、stacked etcd 的在途请求卡顿缓解、addons 等最后一台 CP）→ worker 分批 → 验收；托管集群差异表（EKS 节点≤控制面/upgrade insights/回滚、GKE release channels/两步升级 soak 6h–7d/rollout sequencing、AKS node surge/60 天宽限期/API breaking change 停升级）；Cluster API KCP maxSurge 滚动升级（链到 CAPI docs 与 update.go）。
- **故障处理**：13 行"现象/原因/处置/预防"矩阵（废弃 API、控制面卡住、etcd 升级、PDB/drain、容量、CNI/CSI、cgroup v2、证书、托管强制升级、回滚不可行、舰队漂移等），并对 kubeadm 失败恢复（幂等重跑/`--force`/`/etc/kubernetes/tmp` 备份）、etcd 硬边界、PDB 1 小时上限、skew 违规、托管平台行为、回滚边界做了展开。
- **验收/监控**：apiserver/etcd/节点/Pending/PDB 指标与每集群验收清单；浓缩版 pre/during/post checklist。

**证据**：11 条 pinned GitHub 链接（kubeadm constants/policy、apiserver 废弃 API 指标、CAPI docs/update.go）全部 verified、bad=0；20 个外部 URL（kubernetes.io releases/version-skew/kubeadm/deprecation、EKS/GKE/AKS 文档）逐条 curl 2xx；9 条相对链接有效；`make build` 通过。与已有页面交叉引用：控制面高可用方案（§10 升级）、控制面灾备与恢复、事故处理手册（R6/R10/R12）、Cluster API、flowschema。index.md/SUMMARY.md 同步。

## [2026-11-19] update | “Latest updates” 页面增加开关并默认关闭

按要求先下线首页的 “Latest updates” 页面，并留下一个可逆开关：

- `tools/blog-preprocessor.py` 读取 `[preprocessor.blog]` 下的 `latest-updates`（默认 `true`）；为 `false` 时不再注入该章节，构建日志会打印一行跳过提示。
- `book.toml` 现为 `latest-updates = false`：不生成 `latest_updates.html`，ToC 中也没有该条目。需要时改成 `true` 重新构建即可，页面内容仍是构建期从 `src/docs/` 的 git 创建日期实时汇总的，无需维护正文。
- `Makefile` 的 `build`/`serve` 在构建前删除旧的 `book/latest_updates.html`，避免关掉开关后本地仍残留可直接访问的旧页面。

**验证**：`false` 时 `make build` 通过，`book/latest_updates.html` 不存在、`toc.html` 无 “Latest updates”、`print.html`/搜索索引中无该页；临时改回 `true` 构建 → 页面与 ToC 条目恢复；再改回 `false` 重建 → 页面消失。下线后 Graph View 自动前移到 ToC 首位，站点首页（`index.html`，即 SUMMARY 第一项）不受影响。

## [2026-11-19] update | 重写 flowschema.md：APF 机制 + 自定义使用方法

原 `flowschema.md`（113 行）停留在早期版本：示例用已不再 serve 的 `flowcontrol.apiserver.k8s.io/v1beta1`，并发字段还是旧的 `assuredConcurrencyShares`，只讲了公式和一段旧集群的 `kubectl get priorityLevelConfiguration` 输出，缺少 FlowSchema 规则/匹配优先级、内置策略维护、自定义方法和观测手段。本次按 v1.37.2 / `flowcontrol.apiserver.k8s.io/v1` 重写为 367 行的机制 + 使用指南：

- **机制**：max-inflight 的局限与 APF 定位；请求生命周期（RequestDigest → 按 precedence 匹配 FlowSchema → PL → seat 估算 → 公平队列/借还 → 429）；FlowSchema 字段语义（matchingPrecedence 1–10000、distinguisherMethod、subjects、resourceRules/nonResourceRules、空 rules 不匹配任何请求、引用不存在的 PL 会 `Dangling`）；内置 FlowSchema 的 precedence 全表（exempt=1、probes=2、system-leader-election=100 … global-default=9900、catch-all=10000）；PL 的 `NominalCL = ceil(ServerCL * NCS / sum(NCS))`、默认份额表（system 30 / node-high 40 / leader-election 10 / workload-high 40 / workload-low 100 / global-default 20 / catch-all 5，合计约 245）、Queue 参数与校验、lendablePercent/borrowingLimitPercent、Exempt；mandatory vs suggested 与 `apf.kubernetes.io/autoupdate-spec` 的接管规则（mandatory 会被改回、suggested 需显式注解、删除会被重建、自定义对象不受 ensurer 影响）。
- **使用方法**：自建 PL + FlowSchema 的完整 YAML（CI 批处理示例）、按 Group/非资源 URL 的匹配模板、调内置 PL 的 `annotate` + `patch` 步骤与恢复方法、debug 端点（`/debug/api_priority_and_fairness/dump_*`）、PromQL（rejected/wait/inqueue/nominal_limit_seats）、容量规划清单，以及 9 条常见误区（shares 是相对值、APF 每实例独立、watch 受限、precedence 不能乱设等）。
- **修正**：明确 1.37 只 serve v1（v1beta1/2/3 仅保留转换），`assuredConcurrencyShares` → `nominalConcurrencyShares`；默认值、内置对象名/份额/precedence、autoupdate 行为全部以本地 v1.37.2 checkout 的源码为准（types/defaults/validation/bootstrap/ensurer/filter/metrics 共 26 条 pinned 链接）。新增 H1 标题，`SUMMARY.md` 中的条目从 `flowschema` 变为「API Priority and Fairness：FlowSchema 与 PriorityLevelConfiguration」。

**验证**：`verify-links.py` 26 条 pinned 链接全部 verified、`bad=0`；28 个外部 URL 逐条 curl 全部 2xx；5 条相对链接 0 缺失；headless Chromium 渲染页面：1 个 mermaid 图 `data-processed`、无 syntax error / Uncaught；`make build` 通过。index.md 描述同步更新。

## [2026-11-19] update | mermaid 升级 11.6.0 → 12.3.0（对齐 GitHub 当前大版本）

把 vendored 的 `theme/mermaid.min.js` 从 11.6.0 升级到 npm 最新 **12.3.0**（与 GitHub Viewscreen 现在运行的 12.3.0 同版本），文件取自 jsDelivr `mermaid@12.3.0/dist/mermaid.min.js`（esbuild 单文件，末尾 `globalThis.mermaid = ...`，与 `book.toml` 中"先 `mermaid.min.js` 后 `mermaid-init.js`"的加载顺序兼容；sha256 `336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3`）。`theme/mermaid-init.js` 无需修改：`initialize({startOnLoad:false, theme})` 与 `run({nodes})` 在 12 仍可用，暗/亮主题切换逻辑继续生效。

行为变化：

- 12.x 默认 `layout: "elk"`（11.x 是 dagre），所有 flowchart/graph 的布局会变化（更紧凑、个别边标签位置不同）；若要保留升级前的布局，可在 init 里加 `flowchart: {layout:'dagre'}`。
- 12.x 上游已内置 `redux` / `redux-dark` / `redux-color` / `redux-dark-color` 主题（即 GitHub 使用的那套自定义主题），本次仍使用 `dark` / `default`，后续可切换到 GitHub 风格。
- 体积 2.67MB → **5.54MB**（gzip 772KB → 1.59MB，12 内置 ELK 等），首屏 JS 明显变重。

验证（headless Chromium chromium-1243）：

- `src/docs` 下全部 **17 个含 mermaid 的页面、54 个图**（flowchart 31 / sequence 13 / state 5 / graph 5）逐页渲染：`data-processed` 数量与源码块数一致，无 `Uncaught`、无 "Syntax error in text"；
- 暗色（navy）/亮色（light）截图正常；暗→亮点击切换后 SVG 就地重渲染（填充从 `#1f2020` 切到 `#ECECFF`），无整页 reload；
- 渲染耗时（headless，页面脚本开始到全部 SVG 出现）：控制面高可用页（4 个流程图）约 1.4s，沙箱与虚拟化页（10 个图）约 3.0s；
- `make build` 通过。

## [2026-11-19] update | 修复 mermaid 图在暗色主题下文字/节点色不匹配

现象：mdBook 切到暗色主题（navy/coal/ayu）后，mermaid 图仍按浅色主题渲染（浅色节点 + 深色文字），与页面主题冲突、可读性差。根因：`book.toml` 的 `additional-js` 顺序把 `theme/mermaid-init.js` 排在 `theme/mermaid.min.js` **之前**——init 立即调用 `mermaid.initialize` 时全局 `mermaid` 尚未定义（headless Chromium 中实测 `Uncaught ReferenceError: mermaid is not defined`），随后 mermaid 以默认 `theme: 'default'` 自动渲染，完全忽略 mdBook 的主题 class。修复：① `book.toml` 调整为先加载 `theme/mermaid.min.js`、后加载 `theme/mermaid-init.js`；② 重写 `theme/mermaid-init.js`：按 `<html>` 的主题 class 选择 mermaid `dark`/`default`，`startOnLoad: false` 后显式 `mermaid.run()`；缓存每张图的原始源码（innerHTML），用 `MutationObserver` 监听 html class 变化就地重渲染（覆盖主题菜单、mdBook 0.5 的 Auto 主题、系统 `prefers-color-scheme` 切换），不再像旧脚本那样整页 reload，也不再依赖固定的主题按钮 ID。验证：headless Chromium（Playwright chromium-1243）分别以 navy/light 加载页面并截图——暗色下节点填充 `#1f2020`、label `#ccc/#F9FFFE`；亮色下 `#ECECFF`/`#333`；在暗色下点击 Light 后 SVG 就地重渲染为亮色（`fill:#ECECFF`，无残留 `#1f2020`），全程无 JS 错误；`make build` 通过（脚本注入顺序 mermaid.min.js → mermaid-init.js）。

## [2026-11-19] update | Kubernetes 控制面 HA / 灾备 / 事故处理三篇（重写原 HA stub）

用户要求把 K8s 控制面的高可用方案、备灾（灾备）与事故处理讲清楚，并要求"把相关代码或文档拉下来仔细查看、文中带相关代码/文档链接作为参考/证据"。做法：在 `.repos/upstream/` 定点克隆 5 个上游仓库——kubernetes v1.37.2 `c50e539`（sparse-checkout 扩到 `staging/src/k8s.io/apiserver`、`client-go`、`cmd/kubeadm`、`pkg/{controller,registry,controlplane}` 等）、etcd v3.7.4 `2e8a5c9`、Velero v1.18.4 `4ee1e79`、Cluster API v1.14.4 `4356c15`、kube-vip v1.3.1 `6da770e`；把 etcd/velero/cluster-api/kube-vip 补进 `.repos/verify-links.py` 的 repo 映射。3 个 teammate 并行研究写作，Lead 统一审校、交叉引用、SUMMARY 与构建；原 16 行 `kubernetes_ha.md`（只贴两张 kubeadm 拓扑图）重写并更名为 `控制面高可用方案.md`，`kubernetes_ha.assets` 两图随迁。产出：

- **控制面高可用方案.md**（698 行，90 个去重源码链接）：把 HA 拆成三个独立问题——kube-apiserver 无状态 active-active（请求读写直达 etcd、watch cache 只是可重建缓存）、etcd 有状态 quorum（`(n/2)+1`、3/5/7 容忍度、偶数成员无收益、learner 加入/提升与 strict-reconfig-check、跨 AZ RTT 与 fsync、2GiB quota/NOSPACE）、KCM/scheduler/cloud-controller-manager 的 Lease 选主（默认 15s/10s/2s、切换 15–17s、无 fencing、依赖 quorum、APF `leader-election` 保底）；stacked/external/托管/hosted 四类拓扑对比与选型决策树；入口层（6443/2379/2380、kube-vip ARP/BGP、L4 LB、`/livez` `/readyz` 的真实语义、kubeconfig 单 server）；失效域矩阵与"全部控制面 down 时数据面冻结而非崩溃"的代码级解释；kubeadm stacked join 顺序、external etcd 配置、滚动升级与 version skew、12 条常见误区。
- **控制面灾备与恢复.md**（689 行，51 个去重源码链接）：备份/HA/DR 的区别与 RPO/RTO；11 类保护对象（etcd、PKI、sa.key、加密配置+KMS、kubeconfig、manifests/kubeadm-config、对象、RBAC、PV、外部依赖、IaC）；从 RPO 倒推的快照频率/保留/加密/3-2-1、离线校验三件套与 PKI"离线状态包"；`etcdctl snapshot save` → `etcdutl snapshot restore` 原理（单 endpoint、bbolt 快照 + SHA256、restore 清空成员信息、`--bump-revision --mark-compacted`）与 stacked etcd 多成员完整恢复命令；quorum 丢失两条路径（快照 restore vs `--force-new-cluster`）对比与官方"strongly discouraged"风险；全集群重建（保留 PKI、kubeadm init、Cluster API `clusterctl move` 且明确"不是 backup/restore"）；Velero 架构/流程/PV 两条路/限制及与 etcd 快照对比表；多集群 DR 模式与 RTO/RPO 矩阵；演练验证清单与 14 条误区。
- **控制面事故处理手册.md**（767 行，84 个去重源码链接）：P0–P3 分级与"先止血后根因、保留现场、变更冻结、先算数据风险"原则；`/livez` `/readyz` `/healthz` 的真实组成（`etcd` 组经 `AddHealthChecks` 进入三个端点、`etcd-readiness` 只进 readyz）、指标清单（apiserver / 延迟分解 / APF / 证书 / webhook / etcd / 选主 / 节点）与 10 条 PromQL、日志位置；症状→层 mermaid 决策树；R1–R13 runbook（全超时、CrashLoop、etcd 无 leader、NOSPACE、quorum 丢失、证书过期含 CA、webhook/聚合 API、APF 429、选主震荡、节点 NotReady/磁盘满、误删/误操作、升级失败、**apiserver 请求延迟升高**），每个含确认/止血/恢复/验证；事故流程、`cluster-info dump` 取证、时间线/复盘/沟通模板、预防表与一页速查表。R13 用 `request_duration_seconds` 与不含 webhook/APF 排队的 `request_sli_duration_seconds` 做延迟分解，再按"请求形态 / APF 排队 / admission webhook / etcd 与存储 / apiserver 资源 / 聚合层与网络"六层定位。

**Lead 审校修正**：① 健康检查语义——`/livez` 并非"纯进程存活"：etcd 的 `etcd` health 组经 `AddHealthChecks` 同时注册进 healthz/livez/readyz，只有 `etcd-readiness` 是 readyz-only，两页的表格与说明已按源码更正并补 `healthz.go#L79-L110` 证据；② 修正 `cluster-api.md` 一个原本 404 的 CAPI 开发指南链接（改用 `developer/providers/overview`）；③ 统一三页"参考资料 + 本 wiki 相关页面"结构，并把 etcd 版本口径（kubeadm 1.37 默认 3.7.0、证据 checkout 3.7.4）写进页首版本表。

**证据与校验**：三页共 2154 行；去重后 pinned-SHA 代码链接 217 个（全部 40 位 SHA + `#Lx-Ly` 行号），官方文档/博客/SLA 等外部链接 71 个；`verify-links.py` 三页分别 93/63/120 条 pinned 链接全部 verified、`bad=0`；267 个去重外部 URL 逐条 curl 全部 2xx；相对链接 106 条 0 缺失；`make build` 通过（3 个 HTML 页面、8 个 mermaid 块、2 张 SVG 正确渲染）。交叉引用：`2_kubernetes-api-server.md`、`client-go-list-watch.md`、`flowschema.md`、`kubelet原理.md`、`cluster-api.md` 增加延伸阅读；`index.md` 三条索引；`SUMMARY.md` 由 `make gen-summary` 重新生成。研究简报与版本矩阵留在 `.repos/CONTROL_PLANE_RESEARCH_BRIEF.md`（gitignored），并新增 `raw/RESEARCH-k8s-control-plane.md` 作为可入库的来源清单与事实基线。

## [2026-11-19] update | KVM 部分新增可运行实验（最小 VMM）

用户希望 KVM 部分有一个能动手跑的实验。新增 §3.7：①环境检查（`/dev/kvm`、CPU 虚拟化扩展、kvm 组权限、WSL2 `nestedVirtualization=true`、云主机嵌套虚拟化）；②约 150 行 C 的最小 VMM（`KVM_CREATE_VM` → `mmap` guest RAM → `KVM_SET_USER_MEMORY_REGION` → `KVM_CREATE_VCPU` → 16 位实模式 guest 执行 `mov al,'A'; out 0xe9,al; hlt` → VMM 打印 `KVM_EXIT_IO`/`KVM_EXIT_HLT`）；③实测输出与 `strace` ioctl 对照（fd 3=/dev/kvm、4=VM、5=vCPU；API version=12；`KVM_GET_VCPU_MMAP_SIZE`=12288）；④逐行概念映射表；⑤三个扩展实验（`KVM_EXIT_MMIO`、IN 方向 IO、多 vCPU）；⑥故障排查与安全提醒。代码作为页面附件 `沙箱与虚拟化技术全景.assets/tiny-kvm.c`。实测环境 WSL2（6.6.87.2-microsoft-standard-WSL2 + kvm_amd，Docker 容器挂载 `/dev/kvm` 运行）：`gcc -O2 -Wall -Wextra` 无告警，两次 `KVM_RUN` 分别得到 `exit_reason=2`（`KVM_EXIT_IO`，port=0xe9，data=0x41）与 `exit_reason=5`（`KVM_EXIT_HLT`）；MMIO 变体实测 `exit_reason=6`。页面 247 条固定链接校验通过，`make build` 通过。

## [2026-11-19] ingest | 容器存储三连：OverlayFS/镜像层、Snapshotter、镜像懒加载

用户要求理清 OverlayFS、镜像层、snapshotter、懒加载等概念，并要求"把相关代码或文档拉下来仔细查看、文中带链接作证据"。做法：在 `.repos/upstream/` 定点/浅克隆 9 个上游仓库——containerd v2.4.2 `b7a2526`、image-spec v1.1.1 `147f9c1`、linux 7.3 `c03c1a1`（sparse-checkout 补出 `fs/overlayfs`、`Documentation/filesystems`）、stargz-snapshotter `6ee88d9`、soci-snapshotter `8b347fe`、nydus `6aa3f8f`、nydus-snapshotter `8a458b9`、accelerated-container-image（OverlayBD）`0806b5e`、crfs `71d77da`；并把 `torvalds/linux` 与 5 个懒加载仓库补进 `.repos/validate_links.py`、`.repos/verify-links.py` 的 repo 映射。3 个 teammate 并行产出代码级页面、Lead 统一审校与集成。新建 3 页：

- **OverlayFS与镜像层.md**（565 行）：五名词分层定位（OverlayFS/layer/content store/snapshotter/rootfs）；分层的五个动机；AUFS→overlay2→containerd `overlayfs` 命名对照；内核语义（lowerdir/upperdir/workdir/merged、workdir 同 mount 且互不包含、**lowerdir 最左优先级最高**且恰好匹配 containerd `ParentIDs` 从直接父到 base 的顺序、`ovl_open_flags_need_copy_up` 只认 `FMODE_WRITE|O_TRUNC`、copy-up 全路径、whiteout=0/0 字符设备、opaque=`trusted.overlay.opaque=y`、redirect_dir/metacopy/index/nfs_export/userxattr/xino 六开关与代价、d_type/st_ino/xattr 注入/在线改 lower 等坑）；OCI image-spec 精读（descriptor、manifest/config/layers、三种 digest 分工：layer digest 管传输 / diffID 管内容 / chainID 管顺序、`.wh.` 与 `.wh..wh..opq`、必须 apply 而非解包）；containerd 落地（content store CAS 布局、label 引用与 lease、Pull→Prepare→apply→Commit、**对 overlay 直接 apply 到 upperdir**、`OverlayConvertWhiteout` 把 `.wh.` 变 0/0 chardev 而 opaque 变 xattr、rootless 退回 naive 删除）；动手验证清单与 9 条误解。
- **镜像快照器snapshotter.md**（539 行）：layer（内容）vs snapshot（文件系统状态）vs snapshotter 边界表与调用时序；Active/Committed/View 三态、key/name/parent/ParentIDs、labels（`containerd.io/snapshot.ref`、diff-id、parent-chain-id、gc.root）、Snapshotter 10 方法 + Cleaner；bolt metadata 层（`<ns>/<seq>/<key>`、`containerd.io/snapshot.ref` 短路返回 `ErrAlreadyExists`、目录名是 bolt 数字 ID 而非 key/chainID）；overlay 驱动精读（目录布局、createSnapshot 的 `new-*`→rename、mounts() 四分支与 lowerdir 拼接、Commit/Remove/异步删除/Cleanup、索引与 userxattr 自动探测、index=off 默认）；pull（`extract-<uniq> <chainID>` → `Commit(name=sha256:<chainID>)`、gc.ref.snapshot 写回 config）与 run（Prepare(key=容器 ID, parent=顶层 chainID)→Mounts→shim/runc）端到端；View 的真实用途（`rootfs.CreateDiff` 的只读 lower/upper）；GC 引用链与"删镜像不立刻释放"；7 类驱动对比；9 条误解与排障；CRI/ImageFsInfo 边界。
- **镜像懒加载.md**（557 行）：四个前提/代价（registry Range、层内索引、FUSE/EROFS/块设备、冷读放大）；全景图；containerd remote snapshotter 协议（Prepare 带 `containerd.io/snapshot.ref` → 返回 `ErrAlreadyExists`=future snapshot → unpacker `Stat(chainID)` 跳过 fetch+apply；`startFetch` 在 Prepare 之后，故为"零下载"；`containerd.io/snapshot/cri.*` annotations 与 `disable_snapshot_annotations`）；stargz/eStargz（gzip member 可 seek、TOC 为最后一个 tar entry、51 字节 footer 记录 TOC offset、文件顺序编码 prefetch、FUSE+overlayfs、fuse manager、`/.stargz-snapshotter` 状态、zstd:chunked）；Nydus（RAFS bootstrap+blob、1 MiB chunk、nydus-image Native/Zran/Tarfs、merge 合并层、nydusd、fusedev/fscache/blockdev/proxy、EROFS 路径、nydus-overlayfs mount helper、discard_unpacked_layers、Dragonfly）；SOCI（独立 index manifest、zTOC=TOC+zInfo、span 默认 4 MiB、v1 Referrers 弱引用 vs v2 内嵌强绑定、sparse 回退、实验性 prefetch、Fargate/EKS）；OverlayBD（tar→块设备、Zfile、TCMU、obdconv、TurboOCI meta image≈3%、块级可写层）；对比矩阵 + 不该用清单 + CRI 配置骨架 + 验证命令 + 10 条失败对照 + 观测指标。

**证据与校验**：三页共 1661 行（565+539+557），固定 40 位 sha 的 GitHub blob 链接 308 条（112+82+114，去重后），全部逐条用本地 checkout 核对文件存在、行号范围、HEAD 与 pinned sha 一致（`validate_links.py` bad=0；`verify-links.py` 对 5 个改动页面共 491 条 verified、bad=0）。**Lead 审校修正**：① OverlayFS 页 §6.2 原命令在挂载中直接改 lower（内核文档明示 UB），改为"卸载→补 lower→重挂→删并重建同名目录"以稳定复现 opaque；② 同页 §6.4 原用容器 ID 当快照目录名（实际目录名是 bolt 数字 ID），改为先 `ctr snapshots ls` 确认 key=CID、再从 mount 的 `upperdir=` 反查数字目录；③ 懒加载页 §4.5/§9.1 的 CRI 配置从 containerd 1.x 路径改为 2.x `plugins.'io.containerd.cri.v1.images'`，并注明 stargz 文档仍写 1.x 路径。此外把 snapshotter 页开头的 URL 模板改为占位符形式，避免被链接校验脚本误判。

**交叉引用**：容器运行时.md 在 §3.1 layer 条目后加"三页导读"、§6.1 snapshotter 行加深度链接、§12 相关页面新增三条；容器知识备忘录.md 的 UnionFS 小节加延伸阅读；index.md 新增三条索引；SUMMARY.md 由 `make gen-summary` 重新生成。`make build` 通过。

## [2026-11-19] query | VMM 是什么 — 在沙箱与虚拟化页补 §0.3

用户问"VMM 是什么"。原页面只有零散定义（§0.1 定位表、§10.1 名词表、§3/§4 正文）。新增 §0.3「VMM 是什么：一台虚拟机的"用户态操作系统"」：①VMM 的四项职责（管 vCPU / 管内存 / 造虚拟平台 / 管生命周期）及每项的代码落点；②`KVM_CREATE_VM → mmap → KVM_SET_USER_MEMORY_REGION → KVM_CREATE_VCPU → KVM_RUN 循环` 伪代码；③VMM vs Hypervisor / Accelerator / Runtime / KVM 的边界表；④"KVM 提供原语、VMM 组装机器、runtime 包装容器"的一句话总结。§10.1 名词表加「见 §0.3」交叉引用。链接校验：页面 247/247 bad=0，`make build` 通过。

## [2026-11-19] ingest | 沙箱与虚拟化技术全景：KVM / QEMU / Firecracker / Kata / gVisor

用户要求理清 gVisor、Kata、Firecracker、QEMU、KVM 等沙箱/虚拟化概念，并要求文档带代码/文档链接作证据。做法：按稳定 tag 浅克隆 5 个上游仓库到 `.repos/upstream/`（linux v7.3 `c03c1a1`、qemu v11.1.3 `005c61c`、firecracker v1.18.0 `eaf83bb`、kata v4.4.0 `f9cbda4`、gvisor release-20261116.0 `89cacad`），5 个 teammate 并行产出代码级证据笔记（`.repos/research-isolation-2026-11/*.md`，共 1318 行、638 条固定 sha 链接）。新建本页：①五名词分层定位表 + 全景图；②历史线与"沙箱/虚拟化/运行时"三词澄清；③三种隔离边界（共享内核/用户态内核/硬件虚拟化）；④KVM 的 fd 对象模型、memslot、KVM_RUN/VM exit、VMX/EPT；⑤QEMU 的 TCG vs KVM、启动链、qdev/virtio/固件与"为什么重"；⑥Firecracker 的 microVM、REST API 启动、设备模型（纠正"无 PCI/ACPI"）、jailer 与 seccomp 分工、快照；⑦Kata 的 VM-per-Pod 调用链、Go/Rust 双 runtime、多 VMM、guest 资产、CoCo；⑧gVisor 的 Sentry、三 platform（systrap 默认）、gofer/LISAFS、netstack、host seccomp 白名单；⑨对比矩阵、组合关系、选型决策树与 RuntimeClass 接线；⑩15 条常见误解；⑪名词速查与参考。所有 235 条 GitHub 固定链接用脚本校验（文件存在、行号在范围内、commit 与本地 checkout 一致）。交叉引用：容器运行时.md、agent-sandbox.md、agent-substrate.md、容器知识备忘录.md 增加链接；index.md / SUMMARY.md 同步。

## [2026-11-18] ingest | 容器运行时全链路：OCI / CRI / containerd / shim / RuntimeClass

用户要求把 OCI、CRI、containerd、shim、RuntimeClass 五个概念彻底理清，并要求文档带代码/文档链接作为证据。做法：按稳定 tag 浅克隆 7 个上游仓库到 `.repos/upstream/`（runtime-spec v1.3.0 `9224913`、image-spec v1.1.1 `147f9c1`、runc v1.5.3 `46365c6`、containerd v2.4.2 `b7a2526`、kubernetes v1.37.2 `c50e539`、cri-api v0.37.2 `d279f3c`、cri-o v1.37.4 `c11d3e7`），4 个 teammate 并行产出代码级证据笔记（`raw/research-oci-runc.md`、`raw/research-cri-kubelet.md`、`raw/research-containerd-shim.md`、`raw/research-runtimeclass.md`）。新建本页：①五名词分层全景与历史线；②OCI image-spec（descriptor→manifest→config/layers）与 runtime-spec（bundle/config.json/13 步生命周期）；③runc 的 create→`runc init` re-exec→exec.fifo 握手（纠正 fifo 读写方向）；④CRI 两组 service、PodSandbox 语义、`runtime_handler` 位于 `RunPodSandboxRequest` 而非 `PodSandboxConfig`、streaming 由运行时提供而 kubelet 只反代；⑤kubelet 真实调用链（PreInitRuntimeService→SyncPod→createPodSandbox/startContainer，默认 endpoint、版本严格 `0.1.0`）；⑥containerd 组件、CRI plugin（2.x 插件 ID 变更、sandboxer）、handler→`GetSandboxRuntime` 映射；⑦shim 存在理由、2.4 启动时序（start helper→常驻 shim→ttrpc→runc）、按 `io.kubernetes.cri.sandbox-id` 分组、v1→v2 与 2.0 移除；⑧RuntimeClass API/admission（overhead、nodeSelector/tolerations 合并）/kubelet 解析/containerd 与 CRI-O 配置/生态表；⑨端到端时序；⑩12 条常见误解；⑪动手验证清单。所有 134 条 GitHub 固定链接均用脚本校验（文件存在、行号在范围内、commit 与本地 checkout 一致），外部链接逐一 HTTP 200。交叉引用：kubelet原理.md 与容器知识备忘录.md 增加延伸阅读；index.md 同步。

## [2026-11-17] update | Agent Substrate — 补充 worker pod 故障恢复机制

用户提问「worker pod 挂了，上面的 actor 还能恢复吗」。核对 `docs/reference/api-guide.md#eviction`（Eviction 30 分钟窗口、Resume/Revert 语义）、`cmd/ateapi/internal/controlapi/workflow_worker_delete.go`（worker pod 消失 → DeleteWorker 工作流把承载的 actor 置 CRASHED、清理 assignment、尽力回收节点状态）、`cmd/ateworker-gvisor/main.go` 的 `workloadGracePeriod = 30m` 与 atelet 的 `--snapshot-upload-delay`/`--snapshot-detach-delay` 默认值后，在 agent-substrate.md 的「核心机制」下新增「Worker 故障与 Actor 恢复」小节：SUSPENDED 不受影响；RUNNING 随 pod 丢失状态 → CRASHED → `revert`（回最近 completed 外部快照，首次为 Golden）→ `resume`；优雅驱逐有 30min SIGTERM 窗口、推荐 `--mode=sync`；异步 suspend 上传未完成可能丢最新快照；external CSI 卷不随快照回退。

## [2026-11-17] update | Agent Substrate — 追更到 v1.0.0（2026-11）

对比本地仓库 `/home/lubingtan/go/src/github.com/agent-substrate/substrate`：旧页面内容基线约 `cbdeb7dbe`（2026-07-31，425 commits），HEAD 已到 `d283af4eb`（2026-11-17，1718 commits），区间 **1293 commits**，且 v1.0.0（2026-11-05，"Fully armed and operational"）已发布。按 HEAD 重写 agent-substrate.md 并加「与旧页面的差异」对照表（17 项）。关键更新：①v1.0.0 GA + 兼容性承诺；②状态存储 ValKey/Redis → PostgreSQL（atepg）+ 内嵌 OpenFGA，锁改 actorlock + PG 租约；③`ateom-*` → `ateworker-*`，新增 ate-setup/ate-idp-server/objectstore-plugin/credential-provider/envoy-dataplane，cmd/ 8→14；④Worker 支持多 actor（`--max-actors` 默认 1000）+ Actor 必填 CPU/内存 limits + 容量记账/调度器重写（power of two choices）；⑤快照 FULL/DATA → VOLUMES/ROOTFS/MEMORY + 默认异步 suspend + RevertActor + Tag；⑥安全从零补到 zero-trust：per-actor SPIFFE X.509、actor JWT（ate-idp-server OIDC）、atenet-egress + EgressPolicy + 凭证注入（secret 不进 sandbox）、默认拒绝 NetworkPolicy、worker 权限收紧（gVisor 9 / microVM 11 caps，均 privileged:false）；⑦入口从 DNS/Host 改为 `ate-target-actor` header + mTLS CONNECT 到 atunnel(8443)，atenet dns 删除、改 per-sandbox DNS relay；⑧安装改 `ate-setup`、CLI 改 `kubectl ate proxy`，Hugo 文档站 ate.dev + OTel Weaver 指标注册表 + SLO；⑨2026-11 捐赠 CNCF Sandbox，kagent 1.0 每个 agent 跑在 Substrate 上。另修正旧页面基线：其"425 commits / 13 caps / atunnel"实际对应 07-31，而非日志所记 07-09（86cd169b7 当时仅 273 commits）。index.md 一行摘要同步；kagent.md 关系表更新为 Substrate 集成。证据：4 份研究报告（架构/安全/运行时/运维，来自 git 历史对比与 docs 阅读）存于 `.repos/substrate-research-2026-11/`（gitignored）。

## [2026-10-28] ingest | HAMi + HAMi-core

Processed raw/RESEARCH-hami.md（依据本地 clone master@07c89a3f / v2.10.0-280、HAMi-core@de0e4df，以及 project-hami.io、CNCF 博客、GitHub API）。新建 hami.md：项目档案与 CNCF 阶段、三大组件 + 内嵌 kube-scheduler sidecar、一次 GPU Pod 的 webhook→filter→bind→allocate 全链路、资源模型（gpu/gpumem/gpucores/%）、节点与设备策略（binpack/spread/topology-aware/mutex/numa 及策略链）、14 家厂商后端与 hami-core/mig/mps/remote 四种模式、Helm 部署与运维要点、生态集成与同类方案对比表、已知限制。新建 hami-core.md：注入链路（libvgpu.so + /etc/ld.so.preload、整卡跳过、remote 用 LD_PRELOAD）、为什么不用改 libcudart（ld.so.preload 全局符号抢占 + 汇编 dlsym interposer + cuGetProcAddress trampoline 三路）、真实函数表与 preInit/postInit 时序、显存账本（oom_check、共享内存 slot + seqlock、context_size、VMM/async 覆盖、getinfo/nvml 配额视图）、算力令牌桶 + 120ms 反馈闭环、失效场景。assets 新增架构图与共享示例图（Apache-2.0，源自 HAMi 仓库）。交叉引用：kueue.md 增加与 HAMi 的集成说明，kube-scheduler 源码分析补充 Scheduler Extender 扩展点章节并链接本页；index.md / SUMMARY.md 同步。

## [2026-09-08] update | Cordis — Hello World demo + 基线刷新

继续 2026-08-15 的 Cordis ingest：项目 checkout（/home/lubingtan/projects/cordis = LuBingtan fork，HEAD 与上游 main 同步于 caab04e）已从研究快照 8cc9e33/rc.8 前进 20 commits 至 rc.9，故把 cordis.md 头部基线更新为 v4.0.0-rc.9，并据 DeepSeek Harness vendor 现状把 @deepseek-ai/cordis 由 4.0.1 更正为 4.0.2。新增配套上手页 cordis-hello-world.md：用 ~70 行把 effect/inject/provide/Fiber.dispose 全跑一遍（依赖缺失→PENDING、提供→自动激活、卸载→LIFO 逆序回收并级联停用依赖者、恢复→自动复活、dispose 幂等）。demo 已对本机 npm cordis@4.0.0-rc.9（Node 24）实测通过并核对输出。实测发现并记录两个坑：① 具名 function 声明因带 prototype 被 cordis 当「类插件」以 new 实例化，apply 的 return disposer 被静默丢弃——函数插件须用箭头函数或 { apply } 对象（核心测试亦如此写法）；② npm 包 cordis 的 .d.ts barrel 在 TS NodeNext 模块解析下导出为空（export * 链失效），demo 工程 tsconfig 改用 module=ESNext + moduleResolution=bundler 编译，产物为纯 ESM、node 直接可跑。assets 目录已升级为可直接本地 build/run 的完整 npm 工程（package.json type:module + tsconfig + README；npm install → npm run build && npm start / npm run dev / node hello-world.ts 三路均已验证，package-lock 入库、node_modules/dist gitignore）。index.md / SUMMARY.md 同步新增页面。

## [2026-08-15] ingest | Cordis

Processed raw/RESEARCH-cordis.md — Cordis, the "Meta-Framework of Spatiotemporal Composability" (cordiverse/cordis, MIT, by Shigma; paper "A Programming Paradigm for Spatiotemporal Composability" by PKU × DeepSeek-AI). Created cordis.md under Cloud_Native/AI_Infrastructure covering the five core concepts (Context/Service/Plugin/Fiber/Effect/Events), the fiber lifecycle state machine, effect tracking (ctx.effect + LIFO inverses), reactive coeffects (inject + notify + inertial transitions), proxy-mediated context access, the three-phase transactional HMR engine, the loader (EntryTree/Include/isolate realms), and why DeepSeek Harness vendored it (@deepseek-ai/cordis, 18 local patches). Cross-referenced kagent.md with a runtime-vs-K8s-orchestration comparison. Related to DeepSeek Harness ecosystem (kagent, agent-substrate, agent-sandbox).

## [2026-05-08] update | Slurm — added Mermaid architecture diagrams

Embedded 5 Mermaid diagrams: system topology (daemon communication), job lifecycle state machine, scheduling flow, authentication flow, and accounting data model (Cluster→Account→User→Association→QOS hierarchy).

## [2026-05-08] update | Slurm — expanded scheduling algorithms with detailed pseudocode

Expanded the core scheduling algorithms section with: job lifecycle state machine (12 states + 15 flags), multifactor priority formula with fairshare math and decay loop, backfill algorithm with full pseudocode and time complexity analysis, cons_tres selection algorithm (job_test modes, future_run_test, topology-aware best-fit), and preemption algorithm (partition_prio/qos plugins, gang scheduling).

## [2026-05-08] update | Slurm — added job/step concepts, cgroup limits, file distribution

Expanded slurm.md with detailed explanations of job vs job step (with sbatch/srun/salloc examples), Linux cgroups resource limiting mechanism, shared filesystem and sbcast for file distribution, and a comparison table with Kueue.

## [2026-07-09] ingest | Agent Substrate

Processed raw/RESEARCH-agent-substrate.md — Google's high-density agent sandbox runtime. Created agent-substrate.md under Cloud_Native/AI_Infrastructure covering dual-layer state model (CRDs + Redis), Actor/Worker lifecycle, suspend/resume mechanism, 8-binaries control plane, gVisor/Kata sandbox backends, and relationships with kagent.

## [2026-07-09] ingest | kagent

Processed raw/RESEARCH-kagent.md — CNCF K8s-native AI agent framework. Created kagent.md under Cloud_Native/AI_Infrastructure covering Agent CRD, controller architecture, A2A Handler Mux, ADK API Translator, Python/Go runtimes, MCP tool ecosystem, and multi-framework support (ADK/LangGraph/CrewAI/OpenAI).

## [2026-07-09] ingest | Agent Sandbox

Processed raw/RESEARCH-agent-sandbox.md — K8s-native sandbox execution environment. Created agent-sandbox.md under Cloud_Native covering resource model (Sandbox/WarmPool/Claim), Claim lifecycle with state diagram, WarmPool pre-warming mechanism, 7-layer defense-in-depth security, and Router request routing protocol.

## [2026-06-18] ingest | Cluster API

Processed raw/RESEARCH-cluster-api.md — Kubernetes Cluster API for declarative cluster lifecycle management. Created cluster-api.md under Cloud_Native/Kubernetes covering resource hierarchy, provider contracts, controller reconciliation, ClusterClass managed topologies, a minimal custom infrastructure provider example, and comparison with Kueue.

## [2026-05-22] ingest | Apache Mesos

Processed raw/RESEARCH-mesos.md — Apache Mesos, a distributed systems kernel with two-level scheduling. Created mesos.md under Distributed_Systems covering architecture, DRF allocator, v1 HTTP scheduler API, resource reservation model, and comparison with Slurm/Kueue.

## [2026-05-08] ingest | Slurm Workload Manager

Processed raw/RESEARCH-slurm.md — comprehensive research on Slurm, the HPC cluster workload manager. Created slurm.md under Machine_Learning/High_Performance_Computing covering daemon architecture, plugin system, scheduling algorithms (backfill, multifactor priority, cons_tres), user commands, and project state.

## [2026-05-08] ingest | DevOps Thinking

Processed raw/devops-thinking.md — DevOps principles and practices covering CI/CD pipeline design (pipeline as code, reusability, performance, reliability), reproducible dev environments, Docker as a Service, and Kubernetes as a Service. Created under Cloud_Native/CICD.

## [2026-05-07] ingest | Kueue Project Research

Processed raw/RESEARCH-kueue.md — a comprehensive research document on Kueue (Kubernetes-native job queueing manager). Created kueue.md under Cloud_Native/Kubernetes covering core CRDs, architecture (controller/scheduler/cache), supported job types, MultiKueue, and resource management.

## [2026-05-07] update | Adopted LLM-driven wiki schema

Rewrote AGENTS.md as the wiki schema defining ingest/query/lint workflows, created index.md and log.md, and set up raw/ directory for future source documents. The wiki is now structured for LLM-driven maintenance.
