# Operation Log

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
