# DevOps 理念与实践：从 CI/CD 到平台工程

> 本文是平台工程专题的“基础篇”：保留经典 CI/CD 与开发环境的设计原则，并说明它们如何演进为平台工程。Agent 时代的变化、平台产品化、环境即服务、可观测性等深水区内容，见文末阅读地图。

## 1. DevOps 的目标：快而稳

DevOps 不是“开发兼运维”，也不是“买一套 CI/CD 工具”。它是一组让**价值流动更快、反馈更短、系统更稳**的工程与组织实践。可以用两个维度概括目标：

- **吞吐（throughput）**：部署频率、变更前置时间、返工率；
- **稳定性（stability）**：变更失败率、失败恢复时间。

这五个指标通常合称 **DORA 5**。它们衡量的是端到端交付结果，而不是某个团队的忙碌程度。

Gene Kim 等人在《The DevOps Handbook》中把 DevOps 的实践总结为“Three Ways”：

1. **Flow**：加速从开发到交付的流动，减少等待、交接与返工；
2. **Feedback**：让生产反馈尽快回到开发，缩短发现问题的时间；
3. **Continual learning**：从事故与实验中学习，持续改进系统。

**判断**：DevOps 的收益来自端到端系统，而不是单点自动化。只把“写代码”加速，瓶颈会转移到评审、集成、环境与发布。

## 2. CI/CD Pipeline

### 2.1 Pipeline as Code

Pipeline 的定义应该与项目代码放在一起，这样能确保 pipeline 在特定项目中正常工作，且 pipeline 本身的变更也能被充分测试。

**正面案例：GitHub Actions**
- 由 PR 事件触发的 workflow 定义在 git 仓库中，与其他代码一起管理；
- 当 PR 包含对 workflow 的修改时，该 PR 会使用修改后的 workflow 运行（对 `pull_request` 事件而言）；
- 同时，其他 PR 仍然使用主分支中定义的 workflow。

**反例（作者观点）：Prow**
- presubmit/postsubmit 任务集中在配置仓库中，配置变更需要单独的 PR 与 rollout；
- 难以在同一个 PR 内修改 pipeline 并立即用新定义验证，迭代反馈更长。

无论选哪种工具，原则是一致的：**pipeline 的变更也是代码变更**，需要 review、测试、版本化与回滚。

### 2.2 可复用 Pipeline

一个 workflow 应包含以下基本组件：

1. 触发 workflow 的事件（event）；
2. 在 runner 上执行的 job，包含一系列 step；
3. 每个 step 可以运行脚本，或调用一个可复用的 **action**。

可复用的关键在于**构建块（building block）**设计：

- Step 是基本构建块：Composite Action 包含多个 Step，Step 可以调用 Action；
- Job 也是构建块：Workflow 包含多个 Job，Job 可以调用 Workflow。

**反例（早期设计，作者观点）：Tekton Pipeline**
- Pipeline 包含多个 Task，Task 包含多个 Step；
- Pipeline/Task/Step 之间缺少直接嵌套复用，跨 Pipeline 复用容易退化为复制粘贴；
- Tekton 后续版本在持续演进，选型时以当前文档为准。

可复用性不只是“把 YAML 抽成模板”，而是把构建块做成**有版本、有契约、有测试、有 owner** 的产品。否则模板会腐烂，复用会变成新的技术债。

### 2.3 一次构建，多次部署

同一个制品只构建一次，通过 digest 晋级到不同环境，禁止“在环境里重新构建”。

原因：

- 重新构建会引入不可控的差异（依赖、工具链、时间）；
- 无法保证测试过的制品就是上线的制品；
- 供应链证据（SBOM、签名、provenance）会断裂。

这是“可追溯交付”的基础，也是 [CI/CD 与自动化质量保障](./ci-cd-quality-gates.md) 中证据链的起点。

### 2.4 小批量与主干开发

- **小批量**：变更越小，评审越快、测试越便宜、回滚越容易；
- **主干开发**：短生命周期分支，频繁集成，减少合并地狱；
- **特性开关**：把“部署”与“发布”解耦，支持灰度与快速关闭。

Agent 时代这条原则更重要：AI 可以在短时间内生成大变更，如果不主动拆分，评审会成为新的瓶颈。

### 2.5 性能指标

CI/CD 系统的基本性能可以用效率来衡量：

**Efficiency = User Time / (User Time + System Time)**

- **User Time**：从实际执行到用户定义任务完成的时间；
- **System Time**：用户不关心的系统开销（如 event 处理、资源创建/更新、Pod 调度、参数传递等）。

此外，应监控和优化用户定义任务本身的性能，例如启用 Go、Maven、Docker 等构建缓存，减少排队时间，提高并发度。

### 2.6 可靠性指标

**Pipeline Reliability = (成功运行次数 - 由用户任务导致的失败次数) / 总运行次数**

由用户任务导致的失败不计入 CI/CD 系统的故障统计，因为这并非 CI/CD 系统的责任。相反，调度失败、runner 异常、缓存/网络故障等平台侧问题，才应该计入平台可靠性。

除了成功率，还应关注：

- **flaky rate**：不稳定测试占比；
- **门禁误报率**：被人工推翻的阻断占比；
- **平均排队/执行时间**：容量与调度问题。

### 2.7 从平台指标到交付指标

效率与可靠性衡量的是 **CI/CD 系统本身**，不是交付效能。不要用它们替代 DORA 5。

| 层次 | 指标 | 回答的问题 |
|---|---|---|
| 平台 | 效率、可靠性、排队时间、缓存命中率、flaky rate | CI/CD 系统好不好用、稳不稳？ |
| 交付 | DORA 5：部署频率、前置时间、返工率、失败率、恢复时间 | 价值流动是否更快、更稳？ |
| 体验 | DX Core 4 / SPACE / DevEx 调研 | 开发者是否更轻松、更有掌控感？ |

## 3. 开发环境

### 3.1 可复现环境

搭建开发环境是一个重要障碍。由于文档不完整或开发者理解差异，最终环境可能差异很大。远程开发环境虽有优势，但网络延迟、上传/下载时间、公司安全合规限制等因素使其无法完全替代本地环境。

可复现环境的抓手：

- **环境即代码**：Dockerfile、devcontainer、IaC、依赖锁文件；
- **一条命令启动**：`make dev` / `docker compose up` / devcontainer；
- **与 CI 一致**：本地与 CI 使用相同的工具链、基础镜像与依赖缓存；
- **黄金路径**：新同学按文档即可跑通，而不是“找某某同学”。

目标不是“每个人环境完全一样”，而是“环境差异是可解释、可复现、可修复的”。

### 3.2 Docker as a Service

为什么需要 Docker as a Service 而非本地构建镜像？

- 在笔记本上安装和维护 Docker 并不简单（尤其是 macOS/Windows）；
- 本地网络环境可能与数据中心不同，Dockerfile 可能需要访问内网资源；
- 构建可能需要大量 CPU、内存或磁盘，本地笔记本可能无法满足。

平台化后，构建还应该附带：远程缓存、并发构建、安全扫描、签名与制品推送。

### 3.3 Kubernetes as a Service

每个开发者可能需要独立的 Kubernetes 环境，因为他们之间需要互相独立。通过 Kubernetes as a Service，开发者可以直接将镜像部署到 Kubernetes 上。

隔离级别可以按需选择：Namespace → 虚拟集群（vCluster 等）→ 独立集群 → 独立账号/VPC。隔离越强，成本越高、创建越慢；大多数研发/测试场景用 Namespace + 网络策略 + 配额即可。

### 3.4 环境即服务

当环境数量从“每个团队一套”变为“每个 PR/每个 agent run 一套”，环境就必须产品化：

- 自助申请、自动交付、可验证；
- TTL、空闲回收、配额与成本可见；
- 环境契约（owner、数据分级、暴露方式、生命周期）。

详见 [环境即服务：云原生资源自助交付与治理](./environment-as-a-service.md)。

## 4. 从 CI/CD 到平台工程

CI/CD 解决了“变更如何被构建、测试、部署”；平台工程进一步解决“能力如何被自助、可复用、可治理地提供给多个团队”。

| 阶段 | 复用单位 | 用户接口 | 治理方式 |
|---|---|---|---|
| 脚本 | 复制粘贴 | 找专家 | 事后检查 |
| 模板 | 参数化 pipeline | CLI/文档 | 规则与约定 |
| 自助平台 | API/CRD/服务 | 门户 + API | 策略即代码 |
| Agent-ready | 契约 + MCP | 人机双模 | 证据链 + 审计 + 自动回滚 |

平台工程不是 CI/CD 的替代，而是把 CI/CD 及其周边能力（环境、制品、可观测性、安全）**产品化**。详见 [平台工程：把工程能力变成可复用的产品](./platform-as-a-product.md)。

## 5. Agent 时代的补充

DORA 2025 把 AI 定性为“放大器”：90% 的技术从业者使用 AI，80% 以上自评生产力提升，但 30% 对 AI 代码信任度很低；更高的 AI 采用率同时关联吞吐上升与不稳定性上升。

这带来两个直接后果：

- **验证税**：写代码省下的时间，被审查、调试、对齐和返工重新花掉；
- **评审瓶颈**：PR 供给增加、体积增大，评审者从“写代码的人”变成“审计 agent 的人”。

因此，经典原则不是过时了，而是更重要了：

- Pipeline as Code：agent 也要通过同一条可审计的流水线；
- 一次构建、多次部署：保证“测过的就是上线的”；
- 可复现环境：让 agent 的失败可复现、可回滚；
- 小批量：把 agent 的大变更拆成可审查的单元；
- 证据链：测试、SBOM、签名、eval、审批共同构成发布依据。

同时，平台需要为 agent 提供**机器可读的接口**：OpenAPI/MCP、dry-run、幂等、短时身份、结构化错误与审计。详见 [Agent 时代的 DevOps](./agent-era-devops.md) 与 [CI/CD 与自动化质量保障](./ci-cd-quality-gates.md)。

## 6. 常见反模式

- **集中式 pipeline 配置**：无法按 PR 修改，反馈链路过长；
- **复制粘贴 pipeline**：模板没有版本、测试与 owner，最终腐烂；
- **每个环境重新构建**：破坏“一次构建、多次部署”与供应链证据；
- **雪花环境**：手工配置、无法复现，故障排查靠猜；
- **人工审批代替证据**：审批没有记录，出问题无法追溯；
- **用 pipeline 效率衡量交付生产力**：平台指标好，不代表价值流动快；
- **把平台做成工单队列**：瓶颈从基础设施转移到平台团队。

## 7. 阅读地图

| 想深入什么 | 从这里开始 |
|---|---|
| Agent 时代 DevOps 的整体变化与参考架构 | [Agent 时代的 DevOps](./agent-era-devops.md) |
| 平台产品化、能力契约、黄金路径、Agent-ready 接口 | [平台工程](./platform-as-a-product.md) |
| CI/CD 深水区：供应链、测试分层、LLM eval、发布回滚 | [CI/CD 与自动化质量保障](./ci-cd-quality-gates.md) |
| 环境自助、隔离、回收与成本 | [环境即服务](./environment-as-a-service.md) |
| 可观测性、SLO、事故管理、权限审计与容灾 | [可观测性与稳定性](./observability-and-sre.md) |
| 组织协作、规范落地与效果评估 | [平台落地](./platform-adoption.md) |

## 8. 参考

- [GitHub Actions Workflow 基础](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows#workflow-basics)
- [Tekton Pipelines 文档](https://tekton.dev/docs/pipelines/)
- [Prow 文档](https://docs.prow.k8s.io/)
- [DORA 2025: State of AI-assisted Software Development](https://dora.dev/research/2025/dora-report/)
- [Accelerate: The Science of Lean Software and DevOps](https://itrevolution.com/product/accelerate/)
- [The DevOps Handbook](https://itrevolution.com/product/the-devops-handbook-second-edition/)
- [CNCF Platforms White Paper](https://cloudnativeplatforms.com/whitepapers/platforms/)
