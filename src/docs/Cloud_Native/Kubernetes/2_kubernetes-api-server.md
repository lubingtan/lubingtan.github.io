## 理解 Kubernetes 证书

### RSA 加密与 SSL 协议

## 延伸阅读

- [Kubernetes 控制面高可用方案](./控制面高可用方案.md) —— apiserver 为什么可以 active-active 多副本（无本地持久状态、watch cache 只是缓存）、`/livez` `/readyz` `/healthz` 的差异，以及多 apiserver 的入口设计。
- [Kubernetes 控制面事故处理手册](./控制面事故处理手册.md) —— apiserver CrashLoop、客户端证书过期、webhook/聚合 API 拖垮写操作等现场处置。
- [FlowSchema](./flowschema.md) —— apiserver 内部的 API Priority and Fairness 限流机制。

