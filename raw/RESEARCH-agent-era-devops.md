# RESEARCH: Agent 时代的 DevOps 与软件交付

- 调研日期：2026-11-21
- 目的：为 `src/docs/Cloud_Native/Platform_Engineering/` 下的 6 篇 wiki 页面提供事实底座与来源台账。
- 方法：官方文档 / 标准 / 大型调研优先；厂商遥测与博客仅作方向性参考，并标注证据等级。
- 证据分级：**A** = 标准、官方文档、大样本公开研究；**B** = 厂商工程博客、遥测报告；**C** = 个人观点/二手解读。

## 来源台账

| # | 来源 | 关键事实 | 等级 | 备注 |
|---|---|---|---|---|
| 1 | [DORA 2025 State of AI-assisted Software Development](https://dora.dev/research/2025/dora-report/) | AI 是“放大器”；高 AI 采用率同时关联交付吞吐上升与不稳定性上升；90% 从业者使用 AI，80%+ 自评提效，30% 对 AI 代码低信任；7 项组织能力；7 类团队画像 | A | 问卷为主，相关不等于因果 |
| 2 | [DORA: Balancing AI tensions](https://dora.dev/insights/balancing-ai-tensions/) | “验证税”：写代码时间下降，审查/验证时间上升；审查者认知负荷增加；建议小批量、把 AI 反馈前移到作者侧、减少工具蔓延、保护深度技能 | A | 1110 条 Google 工程师开放式问卷的主题分析 |
| 3 | [CNCF Platforms White Paper v1.1](https://cloudnativeplatforms.com/whitepapers/platforms/) | 平台是“按用户需求定义和呈现的集成能力集合”；平台即产品；黄金路径；TVP；自助、可组合、默认安全；平台用户可以是人类或 agent；平台成熟度四阶段 | A | v1.1 明确写入 agentic users |
| 4 | [CNCF Platform Engineering Maturity Model](https://cloudnativeplatforms.com/whitepapers/platform-eng-maturity-model/) | 平台成熟度维度：投资、采用、接口、运营、度量 | A | 用于成熟度模型对照 |
| 5 | [GitHub Agentic Workflows GA](https://github.blog/changelog/2026-10-28-github-agentic-workflows-generally-available/) | 用自然语言 Markdown 定义、编译为 Actions YAML；默认只读权限；沙箱容器 + Agent Workflow Firewall；safe outputs；threat detection；ARC / DinD；micro-VM 隔离 | A | 2026-10-28 GA；演示“agent 作为 CI 执行者” |
| 6 | [GitHub Agentic Workflows Docs](https://github.github.com/gh-aw/) | 触发器、工具/MCP 调用、权限与防火墙模型 | A | 具体配置以官方文档为准 |
| 7 | [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) | `gen_ai.*` 属性；模型调用、token 用量、agent/tool 调用；MCP 属性；仍处于 development | A | 版本演进快，落地时锁定 semconv 版本 |
| 8 | [SLSA](https://slsa.dev/) | Build L1–L3： provenance 存在 → 托管构建签名 →  hardened build platform；防篡改与可验证性 | A | 供应链证据链的基础标准 |
| 9 | [Sigstore](https://www.sigstore.dev/) | 无密钥签名、透明日志、attestation | A | 与 Cosign / admission control 配合 |
| 10 | [CNCF Supply Chain Security Paper v2 (2025)](https://safeguard.sh/resources/blog/cncf-supply-chain-security-paper-v2-2025) | SBOM、签名 attestation、零信任工作负载身份成为主流实践 | B | 二手解读，标准本身以 CNCF 原文为准 |
| 11 | [vCluster Preview Environments](https://www.vcluster.com/docs) | 每个 PR 一个虚拟集群；sleep mode 空闲不占资源；模板化交付 | A | 环境即服务的典型实现 |
| 12 | [Crossplane](https://www.crossplane.io/) | 用 Kubernetes API 编排云资源；Composition 抽象平台能力 | A | 控制面式 IaC |
| 13 | [Karpenter](https://karpenter.sh/) | 节点自动扩缩容与弹性容量 | A | 成本/容量优化 |
| 14 | [OpenCost](https://opencost.io/) | Kubernetes 成本分配与可视化 | A | showback/chargeback |
| 15 | [GitOps](https://opengitops.dev/) | 声明式、版本化、持续协调的交付模型 | A | Argo CD / Flux 为实现 |
| 16 | [DX Core 4](https://getdx.com/research/measuring-developer-productivity-with-the-dx-core-4/) | Speed / Effectiveness / Quality / Impact 四维开发者生产力框架 | B | 与 DORA、SPACE 互补 |
| 17 | [SPACE Framework](https://queue.acm.org/detail.cfm?id=3454124) | Satisfaction, Performance, Activity, Communication, Efficiency | A | 反对单一生产率指标 |
| 18 | [Team Topologies](https://teamtopologies.com/) | stream-aligned / platform / enabling / complicated-subsystem 四类团队；认知负荷；TVP | A | 组织设计参考 |
| 19 | [Faros DORA 2025 解读](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025) | 厂商遥测：PR 审查时长、PR 体积、缺陷率、incident/PR 上升 | B | 样本与口径未独立复核，仅作方向性证据 |
| 20 | [incident.io: AI SRE](https://incident.io/blog/what-is-ai-sre-complete-guide-2026) | AI SRE 的定位：告警分诊、RCA 假设、事故总结、复盘草稿；人在环内 | B | 厂商博客，能力边界需自行验证 |

## 综合判断

1. **瓶颈迁移**：代码生成的边际成本下降，验证、审查、集成、环境与信任的边际成本没有同步下降。Agent 时代 DevOps 的核心矛盾是“供给趋零 vs 信任不降”。
2. **平台双模**：平台的第一用户从“开发者”扩展为“开发者 + agent”。接口必须 API/契约优先，并提供机器可读文档、结构化错误、dry-run、幂等、短时身份与审计。
3. **门禁转向证据**：从“人工审批”转向“策略护栏 + 可验证证据链 + 自动回滚”。质量门禁的产物不是“approve”，而是一组可追溯的证据。
4. **环境即产品**：环境的关键不是“能创建”，而是“能隔离、能回收、能计费、能自愈”。TTL、idle sleep、配额与成本可见性是核心。
5. **可观测性扩展**：除了服务指标，还要观测 agent run、tool call、eval 结果、token 成本与 guardrail 事件。
6. **落地是组织变革**：平台即产品、TVP、黄金路径、enabling team、按团队画像差异化推进；度量用 DORA 5 + DX Core 4/SPACE，避免 LOC/PR 数等虚荣指标。

## 不确定性与待验证

- DORA 的“吞吐↑ + 不稳定↑”是相关性；不同组织、不同 AI 采用深度差异很大。
- Faros 等厂商遥测的样本选择、统计口径未公开复核，引用时只取方向。
- Agentic CI 工具（GitHub Agentic Workflows、各类 coding agent）迭代极快，落地前需重新核对权限模型与计费方式。
- OTel GenAI semconv 仍是 development 状态，生产落地应固定版本并做兼容层。
- “Agent 身份”尚无统一标准；SPIFFE、OAuth2 client credentials、云 IAM 混用是常态。
- 如何把生产事故归因到“某次 agent 生成变更”仍是开放问题，需要变更标记 + 证据链 + 代码来源标注共同解决。

## 页面映射

| 页面 | 对应关注点 |
|---|---|
| `agent-era-devops.md` | 总览：理念与交付流程重构 |
| `platform-as-a-product.md` | 关注点 1：平台设计与工程能力服务化 |
| `ci-cd-quality-gates.md` | 关注点 2：CI/CD 与自动化质量保障 |
| `environment-as-a-service.md` | 关注点 3：云原生环境与资源管理 |
| `observability-and-sre.md` | 关注点 4：可观测性、稳定性、权限与恢复 |
| `platform-adoption.md` | 关注点 5：协作、规范落地与效果评估 |
