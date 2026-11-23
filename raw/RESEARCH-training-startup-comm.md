# 训练启动与通信：从 Pod 到第一个 collective —— 研究稿

Date: 2026-11-23
Scope: rank / world size / rendezvous / process group / NCCL communicator 分别在什么时刻建立，
每一步失败时进程会看到什么；PyTorch（代码级为主）、TensorFlow、MPI、NCCL 四条路径对照。
Method: 只读本地 pinned checkout 的源码与官方文档；所有结论标注是「代码确认」还是「文档说明」。

## 0. 证据基线

| 项目 | Commit | 本地路径 |
|---|---|---|
| pytorch | `02e06c707ee33f8bbad64652dc8f695729a92766` | `.repos/upstream/pytorch`（sparse：torch/distributed、torch/csrc/distributed、docs/source/distributed、docs/source/elastic） |
| nccl | `ad2d192c1f279aefcaf340f67e07880b65a1116b` | `.repos/upstream/nccl` |
| mpi-operator | `a057ca529cb7c3b831207d8bbd37f18136057e0f` | `.repos/upstream/mpi-operator` |
| training-operator | `ae27d3faf401f627af88d451cab7092458083420` | `.repos/upstream/training-operator` |
| torchtitan | `692c9bb5b26f606e5fb739acd55effb6f8850bc9` | `.repos/upstream/torchtitan`（真实工程用法参照） |

行号均对应该 commit。「代码确认」= 读源码；「文档说明」= 读官方文档/注释。

## 1. PyTorch 路径（重点）

### 1.1 torchrun 参数与默认值（代码确认）

- `--nnodes` 默认 `"1:1"`，形如 `MIN:MAX`；`MIN != MAX` 即弹性区间。
  [run.py#L486-L495](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L486-L495)
- `--nproc-per-node` 默认 `"1"`，可为 `auto/cpu/gpu/xpu/int`；它决定 `LOCAL_WORLD_SIZE`，也是唯一被限制为「全作业同构」的量。
  [run.py#L496-L507](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L496-L507)
- `--rdzv-backend` 默认 `"static"`，`--rdzv-endpoint` 默认空，`--rdzv-id` 默认 `"none"`，`--max-restarts` 默认 `0`。
  [run.py#L508-L560](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L508-L560)
- `static` 用 `--master-addr/--master-port/--node-rank`，不支持弹性；`c10d` 是推荐后端；`etcd-v2`/`etcd` 走 etcd v2 API 且 legacy `etcd` 后端已进入维护模式。
  [run.py#L157-L176](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L157-L176)
- 两个自动降级：`--standalone` 强制 `c10d` + `localhost:0` + 随机 UUID 且忽略显式 rdzv 参数；`static` 且未给 endpoint/master-port 且 `nnodes` 上限为 1 时，同样切到 `c10d localhost:0`。
  [run.py#L1099-L1120](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L1099-L1120)
- `MASTER_PORT` 的最终兜底是 29500，且注释明确它只对 `static` 有意义（`c10d` 的端口在 rdzv endpoint 里）。
  [run.py#L1124-L1128](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L1124-L1128)

### 1.2 agent 如何把 rendezvous 结果变成进程环境（代码确认）

`SimpleElasticAgent._rendezvous()` 调 `next_rendezvous()`，拿到 `(store, rank, world_size, bootstrap_store_info)`，
再调用 `_assign_worker_ranks()` 计算每个 worker 的 global/role rank；`master_addr/master_port` 优先取 spec 覆盖值，
否则取 `bootstrap_store_info`（即 rdzv 时写进 store 的 `MASTER_ADDR`/`MASTER_PORT`）。
[api.py#L524-L583](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L524-L583)

`_start_workers()` 逐 worker 组装环境变量并 fork/spawn：
`RANK`、`GROUP_RANK`、`ROLE_RANK`、`ROLE_NAME`、`LOCAL_WORLD_SIZE`、`WORLD_SIZE`、`GROUP_WORLD_SIZE`、
`ROLE_WORLD_SIZE`、`MASTER_ADDR`、`MASTER_PORT`、`TORCHELASTIC_RESTART_COUNT`、`TORCHELASTIC_MAX_RESTARTS`、
`TORCHELASTIC_RUN_ID`、`TORCHELASTIC_USE_AGENT_STORE`。
[local_elastic_agent.py#L435-L452](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L435-L452)

两个容易被忽略的点：

- `LOCAL_RANK` 不在上面那个 dict 里，而是在 `_set_local_rank_env()` 里写；`virtual_local_rank=True` 时每个 worker 只看到自己那张卡（`CUDA_VISIBLE_DEVICES` 收窄为单卡、`LOCAL_RANK=0`）。
  [local_elastic_agent.py#L498-L545](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L498-L545)
- torchrun 会给 worker 注入 `TORCH_NCCL_ASYNC_ERROR_HANDLING=1`（若用户没设），这与库层默认值 3 不同，见 1.5。
  [local_elastic_agent.py#L450-L452](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L450-L452)、
  [torch_nccl_environment_variables.md#L15-L17](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/torch_nccl_environment_variables.md#L15-L17)

`restart_count = spec.max_restarts - self._remaining_restarts`，即 `TORCHELASTIC_RESTART_COUNT` 是「已用掉的次数」，
用户常误以为是「剩余次数」。
[local_elastic_agent.py#L419](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/local_elastic_agent.py#L419)

监控循环的状态机（代码确认）：

- `FAILED`/`UNHEALTHY` 且 `_remaining_restarts > 0` → 扣一次重启额度并重启 worker group；额度耗尽 → 停全部 worker 并返回失败。
- `HEALTHY` 且 `rdzv_handler.num_nodes_waiting() > 0` → 直接重启 worker group（re-rendezvous），代码注释写明「membership changes do not count as retries」。
  [api.py#L946-L973](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L946-L973)
- 重启 = `_stop_workers()` → `_rendezvous()` → `_start_workers()`，进程会带**新的** `RANK`/`WORLD_SIZE` 被重新拉起。
  [api.py#L700-L744](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L700-L744)

文档层面把这件事说得更直白：`RANK` 不稳定、`WORLD_SIZE` 在弹性下会变，必须从 checkpoint 恢复而不是假设 rank 不变。
[run.py#L375-L380](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/run.py#L375-L380)

### 1.3 rendezvous：store key、TryCreate/Join、keep-alive、re-rendezvous（代码确认）

接口契约：`next_rendezvous()` 阻塞直到本轮成形/被关闭/超时；`num_nodes_waiting()` 返回「到晚了、在等下一轮」的节点数，
调用方应周期性轮询它并据此 re-rendezvous；`set_closed()` 的传播是最终一致的，不能当同步原语。
[api.py#L169-L231](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/api.py#L169-L231)

`RendezvousInfo` 携带四样东西：控制面 `store`、组内 `rank`、`world_size`、`bootstrap_store_info`。
`RendezvousStoreInfo.build()` 由 rank 0 选一个空闲端口/地址并写入 store 的 `MASTER_ADDR`/`MASTER_PORT` 两个 key，
其余 rank 从 store 读——这就是「`--rdzv-endpoint` 只指定 rdzv 服务器，不一定是训练进程的 master」的原因。
[api.py#L63-L145](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/api.py#L63-L143)

c10d backend 的落地细节：

- TCPStore 端点默认端口 29400（`parse_rendezvous_endpoint` 的 default_port）；`read_timeout` 默认 60s。
  [c10d_rendezvous_backend.py#L31-L35](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/c10d_rendezvous_backend.py#L31-L35)
- 状态 key 就是 `"torch.rendezvous." + run_id`，值是 pickle 后的整份 `_RendezvousState`；因为 store 的 `get` 会阻塞，
  实现先 `compare_set(key, "", "Y2FuaW1hZGFt")` 塞一个哨兵值，读到哨兵即视作 None。
  [c10d_rendezvous_backend.py#L52-L72](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/c10d_rendezvous_backend.py#L52-L72)
- 写入用 `compare_set(key, token, new_state)` 做 CAS；store 的 `compare_set` 不返回「是否成功」，所以实现用「本地状态与远端状态逐字节比较」来推断。
  [c10d_rendezvous_backend.py#L83-L108](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/c10d_rendezvous_backend.py#L83-L108)

关于 `TryCreate`/`Join`：当前 dynamic rendezvous **没有**名为 `TryCreate` 的函数。create 语义由上面第一次 `compare_set`
（从空值到哨兵）承担；join 语义由 `_RendezvousJoinOp` 返回的 action 表达：
`ADD_TO_PARTICIPANTS` → `ADD_TO_WAIT_LIST`/`ADD_TO_REDUNDANCY_LIST` → `MARK_RENDEZVOUS_COMPLETE`。
`try_create_rendezvous()` 这个名字只保留在 etcd legacy handler 里。
[Join op](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L893-L1000)、
[etcd_rendezvous.py#L463](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/etcd_rendezvous.py#L463)

轮次完成条件（代码确认）：参与数达到 `max_nodes` 立即完成；否则等到 `min_nodes` 后再等 `last_call`（默认 30s）才封轮。
所以 `--nnodes=4:8` 在只有 4 个节点时会稳定地多等 30s，这不是 hang。
[dynamic_rendezvous.py#L768-L772](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L768-L772)、
[RendezvousTimeout 默认值](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L145-L150)

keep-alive：`keep_alive_interval` 默认 5s、`keep_alive_max_attempt` 默认 3；状态同步时把
`now - keep_alive_interval*keep_alive_max_attempt` 之前没心跳的节点从 participants/wait_list 里剔除，
即「约 15s 收不到心跳就判定死亡」。心跳本身由后台 `_PeriodicTimer` 驱动。
[dynamic_rendezvous.py#L1044-L1046](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L1044-L1046)、
[剔除逻辑](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L495-L510)、
[心跳启动](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L1382-L1392)

re-rendezvous 的能力边界：torchrun 的做法是「杀掉全部本地 worker，重新走一次 `next_rendezvous()`，用新 rank/world size 重新启动进程」。
而训练脚本里的 `init_method="env://"` 本身是一次性的——`_env_rendezvous_handler` 在 yield 之后直接
`raise RuntimeError("Unable to perform re-rendezvous using env:// method")`。弹性来自 agent，不来自 process group。
[rendezvous.py#L290-L297](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/rendezvous.py#L290-L297)

失败表现：连不上 rdzv store → `RendezvousConnectionError("The connection to the C10d store has failed...")`；
等人超时 → `RendezvousTimeoutError`；作业已关闭 → `RendezvousClosedError`；状态反序列化失败 → `RendezvousStateError`。
[dynamic_rendezvous.py#L1210-L1222](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/dynamic_rendezvous.py#L1210-L1222)、
[异常定义](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/rendezvous/api.py#L35-L57)

### 1.4 init_process_group：timeout、store barrier、backend、device_id、new_group

两种初始化：显式 `store+rank+world_size`，或 `init_method`（默认 `env://`）；两者互斥。
[distributed_c10d.py#L2292-L2300](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2292-L2300)

`env://` 硬性要求 `RANK`、`WORLD_SIZE`、`MASTER_ADDR`、`MASTER_PORT`，缺任何一个都直接抛
`env:// rendezvous: environment variable X expected, but not set`；store 由 rank 0 做 server、其余做 client。
[rendezvous.py#L252-L294](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/rendezvous.py#L252-L294)

agent store 复用：当 `TORCHELASTIC_USE_AGENT_STORE=True` 且 `MASTER_ADDR:MASTER_PORT` 正是 agent 自己的端点时，
所有 rank 都只建 client（`start_daemon=False`），即 torchrun 的 TCPStore 与训练进程的 store 是同一个；否则 rank 0 以
`multi_tenant=True` 自建 server。torchtitan 的注释解释了为什么这一点重要：端口若在「探测空闲」与「真正 bind」之间被别人抢走，
rank 0 会 `EADDRINUSE`，torchrun 的做法是 rank 0 先起 server 再分发端口。
[rendezvous.py#L156-L215](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/rendezvous.py#L156-L215)、
[torch_elastic.py#L15-L33](https://github.com/pytorch/torchtitan/blob/692c9bb5b26f606e5fb739acd55effb6f8850bc9/torchtitan/rl/actors/monarch/torch_elastic.py#L15-L33)

store 前缀是三层叠加：`PrefixStore("default_pg", store)` → `PrefixStore(f"{group_name}/", ...)` → `PrefixStore(f"{device}/", ...)`。
所以「同一个 store、多个 group、多个 backend」不会撞 key，也解释了为什么排查时 store 里看到的 key 长成 `default_pg/<group>/cuda/...`。
[distributed_c10d.py#L2513](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2513)、
[#L2828](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2828)、
[#L2858](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2858)

默认 timeout（代码确认）：非 NCCL 30 分钟（`kProcessGroupDefaultTimeout`），NCCL 10 分钟（`kProcessGroupNCCLDefaultTimeout`）；
`init.cpp` 把两者导出为 `_DEFAULT_PG_TIMEOUT`/`_DEFAULT_PG_NCCL_TIMEOUT`，`_get_default_timeout()` 按 backend 名分派（`nccl-legacy`/`nccl-lazy` 也算 NCCL 一族）。
[ProcessGroup.hpp#L25-L26](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/ProcessGroup.hpp#L25-L26)、
[NCCLCommon.hpp#L141-L142](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/NCCLCommon.hpp#L141-L142)、
[distributed_c10d.py#L1369-L1382](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L1369-L1382)、[init.cpp#L5367-L5370](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/init.cpp#L5367-L5370)

`_store_based_barrier` 只在 `TORCH_DIST_INIT_BARRIER=1` 时执行；**默认不执行**。它的 key 是
`store_based_barrier_key:<group_name>`，每个 rank `add(key,1)` 后 `wait(last_worker_key)`，
超时报 `Timed out initializing process group in store based barrier on rank ...`——这是「初始化看起来卡住」的经典文本。
[distributed_c10d.py#L1952-L1957](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L1952-L1957)、
[#L1560-L1615](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L1560-L1615)

backend 选择（代码确认）：显式 `backend` 优先；只给 `device_id` 则查 `Backend.default_device_backend_map`（cuda→nccl、cpu→gloo、xpu→xccl）；
两者都没有则 `"undefined"` 懒初始化；也支持 `"cpu:gloo,cuda:nccl"` 这种多后端字符串。
[distributed_c10d.py#L2447-L2462](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2447-L2462)

`device_id` 的语义被文档写得很清楚：给 NCCL 时 communicator **立即** 建（`ncclCommInit*`，而非懒建），子组尽量用 `ncclCommSplit`；
「想尽早暴露 NCCL 初始化错误」正是它的用途。
[distributed_c10d.py#L2348-L2360](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2348-L2360)

`new_group` 的关键约束：所有 world rank 都必须调用（即使不是成员），且调用顺序必须一致；非成员返回 `NON_GROUP_MEMBER`；
`device_id` 同样触发 eager init；`use_local_synchronization=True` 时非成员不参与 barrier（可显著提速，但重叠建组会死锁，且不支持 MPI）。
[distributed_c10d.py#L6964-L7033](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L6964-L7033)

### 1.5 NCCL 初始化：uniqueId 怎么过去、watchdog 与 timeout 现状

c10d 的 NCCL 后端实现在本 commit 已重构到 `torch/csrc/distributed/c10d/nccl2/`（`nccl` 后端名，另有 `nccl-legacy`）。构造时读两个关键开关：
`TORCH_NCCL_ASYNC_ERROR_HANDLING`（默认 `SkipCleanUp`=3）与 `TORCH_NCCL_BLOCKING_WAIT`（默认 false）。
[ProcessGroupNCCLBackend.cpp#L227-L232](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/ProcessGroupNCCLBackend.cpp#L227-L232)、
[ErrorHandlingMode](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/NCCLCommon.hpp#L146-L153)

uniqueId 传播（代码确认，取代了老的 `_broadcastUniqueId` 路径）：`NCCLBootstrap` 按
`TORCH_NCCL_RANKS_PER_ROOT`（默认 128）把 rank 分块，块首 rank 调 `ncclGetUniqueId()` 并把 128 字节写入
`PrefixStore(group_name)` 下的 key `nccl_storekey_<generation>`；其余 rank `store->wait(keys, timeout)` 后 `multiGet`。
块数 >1 时走 `ncclCommInitRankScalable`（多 root 的 uniqueId 数组），否则 `ncclCommInitRankConfig`。
[NCCLBootstrap.cpp#L58-L90](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/NCCLBootstrap.cpp#L58-L90)、
[#L194-L227](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/NCCLBootstrap.cpp#L194-L227)

这句 `store->wait(keys, timeout_)` 的 timeout 就是 process group 的 timeout（NCCL 默认 10 分钟）：
**root 卡住 → 其他 rank 在 comm init 里静默等 10 分钟**，然后报 `Failed to initialize NCCL communicator`。
`createNcclComm` 在失败时还会 `commAbort` 一次，避免半成品 communicator 泄漏。
[NCCLBootstrap.cpp#L229-L256](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/NCCLBootstrap.cpp#L229-L256)

未显式给 device 时，device 由 `rank % device_count` 推断——多进程共享 GPU 或 `CUDA_VISIBLE_DEVICES` 配错时，
这一步会静默把多个 rank 绑到同一张卡上，随后 NCCL 才报错或死锁。
[NCCLBootstrap.cpp#L42-L49](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/NCCLBootstrap.cpp#L42-L49)

watchdog（代码确认）：`!blocking_wait_` 时启动 `timeout_thread_`；线程每 1s 醒一次，先 `checkWorkQueue()`
（`garbageCollect` 判定 work 超时/出错），再 `commGetAsyncError()` 探测 communicator 级异步错误，
命中后 `handleWatchdogFailure()` 按 async error 模式决定 abort comm / 杀进程。
[ProcessGroupNCCLUtils.cpp#L335-L410](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/ProcessGroupNCCLUtils.cpp#L335-L410)

heartbeat 语义要分清实现：`TORCH_NCCL_ENABLE_MONITORING`（默认 1）与 `TORCH_NCCL_HEARTBEAT_TIMEOUT_SEC`（默认 480s）
在文档里被标为 **nccl-legacy only**；当前 `nccl` 后端没有独立 heartbeat 线程，唯一轮询者是上面的 1s watchdog。
[torch_nccl_environment_variables.md#L41-L44](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/torch_nccl_environment_variables.md#L41-L44)

`TORCH_NCCL_BLOCKING_WAIT` / `TORCH_NCCL_ASYNC_ERROR_HANDLING` 的现状（本 commit）：两者都**没有**标注 deprecated；
`BLOCKING_WAIT` 默认 0；`ASYNC_ERROR_HANDLING` 默认 3、torchrun 注入 1，其代码注释写着「最终想去掉这个变量、改用默认值 3」，
但目前仍生效且文档列出 0/1/2/3 四种语义。也就是说「已被废弃」的说法在这个版本不成立，属于版本相关结论。
[torch_nccl_environment_variables.md#L15-L22](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/torch_nccl_environment_variables.md#L15-L22)、
[init_process_group timeout 说明](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/distributed_c10d.py#L2333-L2339)

torchtitan 提供了一个与默认相反的工程选择：为了 Flight Recorder 能落盘，它强制把
`TORCH_NCCL_ASYNC_ERROR_HANDLING` 覆盖成 3（`=1` 时 watchdog 直接 abort，trace 就没了），这与 torchrun 注入 1 的行为冲突。
[utils.py#L569-L580](https://github.com/pytorch/torchtitan/blob/692c9bb5b26f606e5fb739acd55effb6f8850bc9/torchtitan/distributed/utils.py#L569-L580)

## 2. TensorFlow 路径（以官方文档为准）

`TF_CONFIG` 是一个 JSON 字符串，只有两个顶层字段：`cluster`（全集群一致）与 `task`（每进程不同）。
`cluster` 是 `job 名 -> [host:port, ...]` 的字典；`task` 是 `{"type": ..., "index": ...}`。合法 role 为
`chief`/`worker`/`ps`/`evaluator`，只有 ParameterServerStrategy 才应该有 `ps`。
[文档说明：Setting up the TF_CONFIG environment variable](https://www.tensorflow.org/guide/distributed_training#setting_up_the_tf_config_environment_variable)

职责划分（文档说明）：`worker` 干实际训练，worker 0 常常兼任 `chief`；`chief` 额外负责存 checkpoint、写 TensorBoard summary；
`ps` 只为参数服务器策略提供参数存储；`evaluator` 算评估指标。文档特别指出「index 0 被指定为 chief」不是约定而是
`tf.distribute.Strategy` 的实现方式。
[同一页](https://www.tensorflow.org/guide/distributed_training#setting_up_the_tf_config_environment_variable)、
[TFJob 角色说明](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/legacy-v1/user-guides/tensorflow.md#L138-L158)

`MultiWorkerMirroredStrategy` 的建组方式（文档说明）：每个 worker 跑同一份程序，
`TFConfigClusterResolver` 从 `TF_CONFIG` 读 `task_type`/`task_id` 与各 task 地址；strategy 用 `cluster_resolver.num_accelerators()`
决定用几张卡，所有 worker 的卡数必须一致，否则行为未定义。它有两套集合通信实现：
`CommunicationImplementation.RING`（基于 RPC/gRPC，CPU/GPU 都支持）与 `CommunicationImplementation.NCCL`（仅 GPU）。
[API 文档](https://www.tensorflow.org/api_docs/python/tf/distribute/MultiWorkerMirroredStrategy)、
[指南中的通信实现说明](https://www.tensorflow.org/guide/distributed_training)

一个反直觉但很重要的点：所有 `tf.distribute` 与非 `tf.distribute` API 都可能内部发起 collective，
**包括 checkpoint/save**（读 `ON_READ` 变量会触发 all-reduce）。因此不能只让一个 task 跑训练循环，
官方建议每个 worker 跑完全相同的程序，并明确说「按 task_type/task_id 分派是 error-prone 的」。
[API 文档](https://www.tensorflow.org/api_docs/python/tf/distribute/MultiWorkerMirroredStrategy)

checkpoint owner 的实际做法（文档说明）：chief 写到正式 model dir，非 chief 写到临时目录后删除，
原因是 checkpoint 时可能要对聚合变量做 all-reduce，必须所有 worker 参与；「只有 chief 那份才是权威」。
而 `ModelCheckpoint` 已不再提供容错恢复能力，容错要改用 `BackupAndRestore`。
[官方教程 Checkpoint 一节](https://www.tensorflow.org/tutorials/distribute/multi_worker_with_keras)

TF 没有 torchrun 式内建弹性（文档说明）：文档描述的是「某个 worker 被打断，整个集群暂停直到它重启，
其他 worker 也会重启并重新加入集群，然后各自从上次 checkpoint 恢复」。K8s 上这件事由
Training Operator 的 TFJob 承担：`restartPolicy`（Always/OnFailure/ExitCode/Never）按副本类型配置，
launcher/worker 的退出码决定是否重拉；`cleanPodPolicy` 决定作业结束后删哪些 Pod。
[TFJob restartPolicy](https://github.com/kubeflow/training-operator/blob/ae27d3faf401f627af88d451cab7092458083420/docs/legacy-v1/user-guides/tensorflow.md#L150-L158)

注意：本地的 training-operator checkout 是 V2（只有 `TrainJob`/`TrainingRuntime` controller），
**没有** v1 TFJob 的 controller 实现，因此上面 TFJob 的行为只能算「文档说明」，不能算「代码确认」（见第 7 节）。

## 3. MPI 路径

MPIJob 的进程模型是 launcher + worker 两组 Pod（代码确认）：worker 默认只跑 `sshd -De`，负责被 rsh 进去起 rank；
launcher 是一个普通 `batchv1.Job`，用户在它的 `command` 里自己写 `mpirun`/`mpiexec`。
[worker 默认命令](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1532-L1536)、
[launcher 是 Job](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1558-L1585)

hostfile 由 operator 生成，格式随实现而变（代码确认）：OpenMPI 是 `<pod>.<job>.<ns>.svc[.<clusterDomain>] slots=N`，
Intel MPI/MPICH 是 `<host>:N`；每行 slots 取 `spec.slotsPerWorker`（默认 1）；
`runLauncherAsWorker=true` 时 launcher 自己也会出现在 hostfile 第一行（于是 launcher 也承载一个 rank）。
[newConfigMap](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1335-L1379)

Launcher 侧的环境变量决定了 mpirun 去哪找 hostfile（代码确认）：OpenMPI 用
`OMPI_MCA_orte_default_hostfile`、`OMPI_MCA_orte_keep_fqdn_hostnames=true`、`OMPI_MCA_plm_rsh_args=-o ConnectionAttempts=10`；
Intel 用 `I_MPI_HYDRA_HOST_FILE`，MPICH 用 `HYDRA_HOST_FILE`；另外 `slotsPerWorker` 还会写成
`OMPI_MCA_orte_set_default_slots` / `I_MPI_PERHOST`。
[env 定义](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L181-L215)、
[launcher 注入](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/controller/mpi_job_controller.go#L1616-L1628)

`-np` 不是 operator 注入的：示例里由用户写 `mpirun -np 2 ...`（`pi` 示例用的是 `-n 2`），
operator 只保证 hostfile/slots 正确。rank 的「总数」于是由 `-np`（显式）或「所有 slots 之和」（隐式）决定，
二者与 `Worker.replicas * slotsPerWorker` 不一致时，要么少起 rank，要么撞上 oversubscribe 限制。
[示例 pi.yaml](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/examples/v2beta1/pi/pi.yaml#L21-L26)、
[示例 horovod](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/examples/v2beta1/horovod/tensorflow-mnist.yaml#L18-L24)、
[Open MPI mpirun 手册（hostfile/slots/-n 语义）](https://docs.open-mpi.org/en/main/man-openmpi/man1/mpirun.1.html)

rank 相关环境变量来自 MPI 运行时而不是 operator：Open MPI 提供
`OMPI_COMM_WORLD_RANK/SIZE/LOCAL_RANK/LOCAL_SIZE/NODE_RANK`；MPICH 的 PMI 接口常见 `PMI_RANK`/`PMI_SIZE`，PMIx 体系则是 `PMIX_RANK`。
[Open MPI FAQ: environment variables](https://www.open-mpi.org/faq/?category=running)

为什么 MPI 不能像 torchrun 那样 re-rendezvous（文档 + 代码确认）：

- `MPI_Init` 的 world model「在一个 MPI 进程生命周期内至多初始化一次」，`MPI_COMM_WORLD` 的成员在 `MPI_Init` 时就固定。
  [Open MPI MPI_Init 手册](https://docs.open-mpi.org/en/main/man-openmpi/man3/MPI_Init.3.html)
- 唯一的「加人」途径是 `MPI_Comm_spawn`：子进程有**自己的** `MPI_COMM_WORLD`，父进程通过 intercommunicator 与之通信；
  且 spawn 与子进程的 `MPI_Init` 构成跨父子的 collective（父不调 spawn，子 `MPI_Init` 不返回）。
  也就是「新增一个组」，而不是「把现有 `MPI_COMM_WORLD` 扩容」。
  [Open MPI MPI_Comm_spawn 手册](https://docs.open-mpi.org/en/main/man-openmpi/man3/MPI_Comm_spawn.3.html)
- 因此 MPIJob 的「重启」只能是 Kubernetes 语义：launcher Job 失败 → `BackoffLimit`/`restartPolicy` 决定重拉；
  worker 挂掉 → 该 Pod 按 `restartPolicy` 重建，但 launcher 侧的 mpirun 会话已经断了，整轮 rank 映射要重来。
  这也解释了 `launcherCreationPolicy: WaitForWorkersReady` 的存在：先把 worker 全部 Ready 再起 launcher，避免「launcher 先到、worker 没 DNS」。
  [LauncherCreationPolicy](https://github.com/kubeflow/mpi-operator/blob/a057ca529cb7c3b831207d8bbd37f18136057e0f/pkg/apis/kubeflow/v2beta1/types.go#L155-L165)

## 4. NCCL 内部：bootstrap、拓扑、channel、proxy、异步错误

bootstrap 由 uniqueId 承载（代码确认）：`ncclBootstrapHandle` 只有三个字段——`magic`、监听地址 `addr`、`nRanks`，
它被塞进 128 字节的 `ncclUniqueId`。`ncclGetUniqueId` 在非 `NCCL_COMM_ID` 模式下随机生成 magic、填入本机 bootstrap 网卡地址，
然后 `bootstrapCreateRoot()` **当场 listen**（后台线程 accept）。所以 uniqueId 里带的是「第一个 root 的 IP:port」。
[bootstrap.h#L14-L20](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/include/bootstrap.h#L14-L20)、
[bootstrap.cc#L408-L463](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/bootstrap.cc#L408-L463)、
[init.cc#L210-L221](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L210-L221)

`ncclCommInitRank` 的语义（文档 + 代码）：`rank` 必须在 `[0,nranks)` 且组内唯一、调用前需 `cudaSetDevice`；
它「隐式地与其它 rank 同步」，因此必须由不同线程/进程调用，或包在 `ncclGroupStart/End` 里。默认是阻塞的；
`config.blocking=0`（或 `TORCH_NCCL_USE_COMM_NONBLOCKING=1`）时返回 `ncclInProgress`，调用方必须轮询 `ncclCommGetAsyncError`。
[comms.rst#L56-L68](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/docs/userguide/source/api/comms.rst#L56-L68)、
[init.cc#L3062-L3080](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L3062-L3080)、
[异步错误查询](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/docs/userguide/source/api/comms.rst#L233-L252)

bootstrap 的连接建立不是「全员连 root」：每个 rank 先建自己的 listen socket，把自己的联系方式发给所属 root，
root 回给它「环上的下一个 peer」，随后两两 `socketRingConnect`；最后通过这个环 all-gather 所有 rank 的 proxy 地址与 P2P 地址。
所以 bootstrap 阶段任何一个 rank 不可达，表现都是「连接 root 超时/收到残缺环」，而不是一条明确的「rank N 挂了」。
[bootstrap.cc#L799-L900](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/bootstrap.cc#L799-L900)

拓扑与算法（代码确认）：init 时先 `ncclTopoComputePaths`，再分别搜索 ring（`NCCL_TOPO_PATTERN_RING`）与
balanced tree（`NCCL_TOPO_PATTERN_BALANCED_TREE`），可选 collnet/nvls；`comm->nChannels = min(tree, ring)`，
然后通过 `bootstrapAllGather` 把各 rank 的 graph 信息对齐，再按 channel 建连。
[init.cc#L1481-L1515](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L1481-L1515)、
[#L1589](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/init.cc#L1589)

P2P 选择（代码确认）：`ncclTopoCheckP2p` 先看 `hostHash`（不同主机直接不 P2P），再看 `shmDev`（同一个
`/dev/shm` 才能用 CUDA IPC/shm 传输）；然后比较 PCI 路径类型与 `NCCL_P2P_LEVEL`（默认 `PATH_PXB`），
用户可用 `NCCL_P2P_DISABLE`/`NCCL_P2P_LEVEL` 覆盖。跨 Pod 但同机、且没共享 IPC namespace 时，`shmDev` 不同 →
**同机流量也会退回网络**，这是 K8s 上「明明同机却只有 socket 带宽」的根因之一。
[paths.cc#L320-L400](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/graph/paths.cc#L320-L400)

传输与 proxy：节点内优先 NVLink/CUDA P2P，其次 shm（POSIX shm + CUDA IPC），节点间走 net 插件（IB verbs / socket）；
需要网络参与时由 proxy 进度线程推进（`src/proxy.cc`），proxy 的并发度也是常见调优点。
[transport/p2p.cc](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/transport/p2p.cc#L130-L152)、
[ncclProxyStart](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/proxy.cc#L1018-L1034)

collective 的异步语义（文档说明）：`ncclAllReduce` 这类带 stream 的函数只要把操作「压到 stream 上」就返回 `ncclSuccess`，
之后的错误只能通过 `ncclCommGetAsyncError` 观测；一旦 communicator 出错，已入队操作的完成性和正确性都不再有任何保证，
正确做法是 `ncclCommAbort` 后重建。
[comms.rst#L233-L252](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/docs/userguide/source/api/comms.rst#L233-L252)、
[collectives.cc#L204-L211](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/collectives.cc#L204-L211)

常用诊断/调优变量（照 PyTorch 文档与 NCCL 参数命名）：`NCCL_DEBUG=INFO`（打印初始化与明确告警）、
`NCCL_DEBUG_SUBSYS=COLL`（逐 collective）/`GRAPH`（拓扑），`NCCL_SOCKET_IFNAME`（bootstrap 网卡不对时最常改的一个），
`NCCL_IB_DISABLE`、`NCCL_NET_GDR_LEVEL`、`NCCL_ALGO`/`NCCL_PROTO`、`NCCL_P2P_DISABLE`、`NCCL_TOPO_DUMP_FILE`。
[PyTorch 分布式文档中的 NCCL 调试段](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/distributed.md#L145-L160)、
[路径选择与 LEVEL 覆盖](https://github.com/NVIDIA/nccl/blob/ad2d192c1f279aefcaf340f67e07880b65a1116b/src/graph/paths.cc#L303-L316)

## 5. 首个 step 的端到端时序（含每个窗口的典型失败）

| # | 窗口 | 发生什么 | 典型失败与日志特征 |
|---|---|---|---|
| 1 | 调度 | JobSet/operator 建 Pod，gang/队列准入，GPU 设备插件分配 | Pod `Pending`（GPU 不足、亲和性、quota）；镜像拉取失败；`FailedScheduling` 事件 |
| 2 | 容器启动 | entrypoint 起 torchrun/mpirun/python | 命令拼错；依赖缺失；`CUDA_VISIBLE_DEVICES` 与 `LOCAL_RANK` 不一致 |
| 3 | DNS/Service | worker 通过 headless Service 互相解析 | `Name or service not known`；`ConnectionAttempts=10` 后 mpirun 放弃；同机但跨 namespace 时 shm 退化 |
| 4 | rdzv store | rank 0 的 TCPStore（或 `--rdzv-endpoint` 指定的节点）被连接 | `RendezvousConnectionError: connection to the C10d store has failed`；端口被占（29500/29400）；endpoint 写错 |
| 5 | rdzv 成形 | 节点加入、等 `min_nodes`、`last_call` 30s 后封轮、分配 rank/world size | `RendezvousTimeoutError`（join 默认 600s）；`nnodes` 上限小于实际 pod 数 → 多出的节点在 wait_list 空转 |
| 6 | 环境注入 | `RANK/WORLD_SIZE/MASTER_ADDR/MASTER_PORT` 写入子进程 | 手工 `python train.py` 绕过 torchrun → `env:// rendezvous: environment variable RANK expected, but not set` |
| 7 | init_process_group | 建 store client/server、`PrefixStore`、选 backend、可选 store barrier | 默认无 barrier，故通常很快返回；一旦 `TORCH_DIST_INIT_BARRIER=1`，缺 rank 时报 `Timed out initializing process group in store based barrier on rank ...` |
| 8 | NCCL comm init | root 发 uniqueId → store → 各 rank `ncclCommInitRank*` → bootstrap 环 → proxy 地址 all-gather | root 卡住则全员等满 PG timeout（NCCL 默认 10min）；`Failed to initialize NCCL communicator`；`NCCL_DEBUG=INFO` 里卡在 `Bootstrap`/`NET/IB` |
| 9 | 首个 allreduce | 第一次 `all_reduce` 入队、建连、kernel 执行、`work.wait()` | 参数/调用次数不匹配 → 有的 rank 在等上一个 op，watchdog 超时后 `NCCL operation timed out` 并杀进程；`NCCL_DEBUG_SUBSYS=COLL` 可见 mismatch |
| 10 | optimizer step | 反传完成 + 梯度 allreduce 完成，第一次 `optimizer.step()` | 前面任一窗口的延迟都表现为「step 0 时间异常长」；此时若 NCCL 被 abort，异常在下一处 collective 才抛出 |

两个容易归因错误的点：

- 窗口 8 的「卡住」不是死锁而是 timeout：因为 `store->wait(keys, timeout)` 的 timeout 就是 PG timeout，
  job 会先安静 10 分钟再统一报错；把 `init_process_group(timeout=...)` 调小可以显著缩短 MTTR。
  [NCCLBootstrap.cpp#L82-L88](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/csrc/distributed/c10d/nccl2/NCCLBootstrap.cpp#L82-L88)
- 窗口 9 的 mismatch 在 NCCL 层没有「谁错了」的信息：NCCL 只能报本 rank 超时/异步错误，
  定位要靠 `TORCH_NCCL_TRACE_BUFFER_SIZE`/Flight Recorder 或 `TORCH_NCCL_DESYNC_DEBUG`（nccl-legacy）这类工具。
  [Flight Recorder 与环境变量](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/torch_nccl_environment_variables.md#L63-L66)

## 6. 跨框架对照

| 维度 | PyTorch / torchrun | TensorFlow / MWMS + TFJob | MPI / MPIJob |
|---|---|---|---|
| 角色 | 单一 role（`WorkerSpec.role`），rank 由 agent 分配 | `chief`/`worker`/`ps`/`evaluator`，index 0 惯例为 chief | `Launcher`（1 个）+ `Worker`（N 个），无应用层角色 |
| leader / 谁定 rank | rdzv 完成顺序 + `_assign_worker_ranks()` 决定 global/role rank | `TF_CONFIG` 里的 `task.type/index` 自报，无协商 | mpirun/hydra 按 hostfile+slots 顺序分配，进程只被告知 `OMPI_COMM_WORLD_RANK`/`PMI_RANK` |
| membership 建立 | 动态 rendezvous（CAS + keep-alive），round 概念 | 静态：每个 task 读同一份 `cluster`，集合通信要求全员到齐 | 静态：`MPI_Init` 时固定 `MPI_COMM_WORLD` |
| 弹性 / 加节点 | 支持（`nnodes=MIN:MAX`），re-rendezvous 后全员换 rank | 不支持，靠 K8s 重建 Pod/TFJob | 不支持，只能重启 launcher；扩缩 = 新建 MPIJob |
| 重启语义 | agent 重启 worker group，最多 `max_restarts` 次，进程被重新 exec | Pod 级重启（`restartPolicy`），从 checkpoint 恢复 | Pod 级重启；launcher mpirun 会话断开即整轮失败 |
| checkpoint owner | 训练脚本自己定（通常 rank 0），框架不管 | chief 写正式目录、非 chief 写临时目录（因 ON_READ 聚合需要全员参与） | 应用自己定（Horovod/框架），MPI 层不管 |
| 集合通信后端 | `nccl`（GPU）/`gloo`（CPU），可多后端 | `RING`（gRPC）/`NCCL` | 由 MPI 实现决定（Open MPI 的 BTL/UCX、Intel/MPICH 各自） |
| 失败可见性 | Python 异常 + agent 事件 + NCCL watchdog | Python 异常 + TF 日志；无全局 agent | mpirun 退出码 + Pod 状态；rank 级日志分散在各 worker |

## 7. 不确定 / 需复核

1. **`--max-restarts` 是否计入扩容事件**：代码里只有 FAILED/UNHEALTHY 分支递减 `_remaining_restarts`，
   HEALTHY + `num_nodes_waiting()>0` 的 re-rendezvous 不扣额度；但 quickstart 文档写的是
   「`--max-restarts` 控制总重启次数，不论失败还是扩缩容」。二者矛盾，需按目标版本复核。
   （[代码](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/torch/distributed/elastic/agent/server/api.py#L946-L973)、
   [quickstart 文档](https://github.com/pytorch/pytorch/blob/02e06c707ee33f8bbad64652dc8f695729a92766/docs/source/distributed/elastic/quickstart.md)）
2. **NCCL 后端重组**：本 commit 的 `nccl` 指向 `nccl2/`，`nccl-legacy` 保留旧实现；哪些环境变量对哪个实现生效
   在文档里已按 `nccl-legacy only` / `All NCCL backends` 标注，但旧版本（2.4~2.8）行为不同，跨版本结论需重验。
3. **`TORCH_NCCL_BLOCKING_WAIT` 是否「已废弃」**：本 commit 未标 deprecated，默认 0；但源码注释显示维护者希望
   最终去掉 `ASYNC_ERROR_HANDLING`、统一用默认值 3，`BLOCKING_WAIT` 也有弃用讨论，不宜在 wiki 里写死。
4. **TFJob 的 operator 实现**：本地 training-operator 是 V2，无 v1 TFJob controller，故 TFJob 的
   `restartPolicy`/`TF_CONFIG` 注入只能引文档，官方 v1 代码仓需另行核对。
5. **TF checkpoint owner 的两种表述**：MWMS API 文档说「每个 worker 都要 save」，教程说「chief 写正式目录、
   worker 写临时目录」；两者可以统一（都要参与，只有 chief 的那份权威），但引用时需说清语境。
6. **MPI rank 环境变量**：`OMPI_COMM_WORLD_*` 只适用于 Open MPI；MPICH/Hydra/PMIx 组合下变量名与可用性不同，
   mpi-operator 只负责 hostfile 与启动参数，不保证这些变量存在。
7. **NCCL channel 数与算法选择**：`nChannels = min(tree, ring)` 之后还会被 all-gather 对齐、受拓扑与
   `NCCL_MIN_NCHANNELS`/`MAX_NCHANNELS` 影响；具体数值无法从源码静态给出，只能定性。
8. **c10d rendezvous 的 `TryCreate`/`Join`**：当前 dynamic handler 没有这两个名字，create 由首次
   `compare_set` 表达、join 由 `_RendezvousJoinOp` 表达；若 wiki 想沿用 `TryCreate/Join` 术语，应注明是历史/概念命名。
