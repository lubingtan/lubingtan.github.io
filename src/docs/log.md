# Operation Log

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
