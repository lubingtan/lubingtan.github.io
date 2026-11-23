# PLEG：Pod Lifecycle Event Generator

发现, 有僵尸进程时节点状态是 NodeNotReady, 同时 kubelet 日志显示:

```
PLEG is not healthy: pleg was last seen active
```



清除掉僵尸进程后, 节点状态恢复

