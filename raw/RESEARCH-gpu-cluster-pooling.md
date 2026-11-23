# RESEARCH: CUDA 层跨节点 GPU 算力/显存池化

调研日期：2026-11-23。目标：盘点「应用视角单卡、底层按拓扑把算力和显存分散到集群 GPU」的方案。
结论摘要见 `src/docs/Machine_Learning/High_Performance_Computing/gpu-cluster-pooling.md`。

## 核心结论

1. 生产环境不存在「任意 CUDA 程序零改动、跨节点把 N 卡当 1 卡」的通用系统。
2. 能透明的是**地址空间/显存容量**；**算力**的跨卡扩展必须显式切分 kernel（库或框架层）。
3. 跨节点透明内存的官方底座是 MNNVL + IMEX + `CU_MEM_HANDLE_TYPE_FABRIC`（CUDA 12.4+），
   机架内可形成 72 GPU 的单一 NVLink 域；再往上是 NVSHMEM / NCCL symmetric memory / FlashInfer 等库。
4. API remoting（rCUDA/GVirtuS/Bitfusion/HAMi Lupine）给的是「远程单卡」视角，不扩展容量/算力。
5. 显存池化（EMA、Memory Harvesting、VUGVA、CXL）只解决容量弹性，算力仍在本地。

## 关键事实与出处

### CUDA Unified Memory / VMM
- UVM：单一地址空间，CPU/GPU 并发访问，页错误驱动迁移；`cudaMemAdvise`、`cudaMemPrefetchAsync` 可调优。
  https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/unified-memory.html
- Full UVM 要求：CC 7.5+、Linux HMM 6.1.24+/6.2.11+/6.3+、driver 535+、Open Kernel Modules。
- VMM：`cuMemAddressReserve` / `cuMemCreate` / `cuMemMap` / `cuMemSetAccess`，VA 与物理解耦，可把多卡物理内存映射进同一段 VA。
  https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/virtual-memory-management.html
- Fabric Memory：CUDA 12.4 引入 `CU_MEM_HANDLE_TYPE_FABRIC`；需 IMEX daemon；可在多节点 NVLink 域内跨节点共享。
  `CU_DEVICE_ATTRIBUTE_HANDLE_TYPE_FABRIC_SUPPORTED`。
- Multicast：`cuMulticastCreate` / `cuMulticastAddDevice` / `cuMulticastBindMem` + `multimem` PTX，利用 NVLink SHARP 做广播/规约。
- EGM：`CU_MEM_LOCATION_TYPE_HOST_NUMA`，GPU 线程经 NVLink-C2C 访问 CPU 附加内存；当前文档支持单节点单卡、单节点多卡、多节点多卡拓扑。
- Thread Block Cluster / DSMEM：CC 9.0，最多 8 个 block 协同调度到同一 GPC，共享的是**单卡内** shared memory，不是跨卡。
- Compute Fabric Transport（CUDA 13.x）：logical endpoint（32-bit id + 64-bit offset）+ 异步 put/get/red/pullred/atom，
  显式完成状态与错误上报；资源中心模型，面向 NCCL/NVSHMEM 库作者。
  https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/compute-fabric-transport.html

### MNNVL / IMEX
- MNNVL：18 个 compute tray（每 tray 2 Grace + 4 Blackwell）= 72 GPU；9 个 NVLink switch tray。
  https://docs.nvidia.com/multi-node-nvlink-systems/mnnvl-user-guide/overview.html
- IMEX = Internode Memory EXchange：跨 OS domain 映射 GPU 内存；管理面 TCP/gRPC，数据面 NVLink；
  `/dev/nvidia-caps-imex-channels/channelN`；VA→PA→Fabric Address 映射模型。
  https://docs.nvidia.com/multi-node-nvlink-systems/imex-guide/overview.html
- Fabric Manager 配置 NVSwitch fabric 为单一内存 fabric；NVLSM 负责 LID/转发表。
- NVL72 默认是单个 72 GPU NVLink Partition；可用 User Partition 切分；最大 72 个单卡 partition。
  https://docs.nvidia.com/mission-control/docs/systems-administration-guide/2.0.0/high-speed-fabric-management.html
- DGX GB200：72 Blackwell / 36 Grace / 13.4 TB HBM3e / 576 TB/s HBM / 1.8 TB/s GPU 间 NVLink / 30.2 TB total fast memory。
  https://www.nvidia.com/en-us/data-center/dgx-gb200/

### K8s / DRA
- `ComputeDomain`（resource.nvidia.com/v1beta1）封装 MNNVL IMEX domain；每 Pod 一个 IMEX channel；
  `nvidia.com/gpu.clique` 保证同一 NVLink clique；driverManaged 模式下每节点最多一个活跃 ComputeDomain。
  https://dra-driver-nvidia-gpu.sigs.k8s.io/docs/concepts/compute-domains/
- KEP-1259：LWS/DisaggregatedSet 自动管理 ComputeDomain，per-replica / per-(slice,revision) 隔离。
  https://github.com/kubernetes-sigs/lws/blob/main/keps/1259-auto-compute-domain/README.md

### 通信库
- NVSHMEM：PGAS，symmetric heap，`nvshmem_malloc`，GPU 发起的 put/get/atomic，跨 NVLink/PCIe/IB。
  https://docs.nvidia.com/nvshmem/api/introduction.html
- NCCL 2.27：symmetric memory，单 NVLink 域内低延迟集合通信（NVL72 / NVL8）。
  https://developer.nvidia.com/blog/enabling-fast-inference-and-resilient-training-with-nccl-2-27/
- NCCL GIN（GPU-initiated networking）自 2.28.7。
- cuBLASMp / cuFFTMp / cuSOLVERMp：基于 NVSHMEM 的多卡/多节点库（NVIDIA HPC SDK）。

### API Remoting
- rCUDA：拦截 CUDA Runtime API，经 IB/RoCE 转发到远端 server；应用不改；公开白皮书基线 CUDA 8.0。
  http://rcuda.net/
- GVirtuS：开源，frontend/backend 插件框架，TCP 或 InfiniBand RDMA，CUDA 10.2+。
  https://github.com/gvirtus/GVirtuS
- vCUDA / mrCUDA：API remoting + 迁移/本地回退。
- VMware Bitfusion：GPU 网络池化；EOA 2023-05-05，EOL 2025-05-05。
  https://knowledge.broadcom.com/external/article/322267/end-of-availability-eoa-for-vsphere-bitf.html
- HAMi Lupine（v2.11.0+）：K8s 原生远端 GPU，客户端可为纯 CPU 节点，CUDA 调用在 GPU server 执行。
  https://project-hami.io/docs/next/userguide/nvidia-device/remote-gpu

### 显存池化 / 弹性
- EMA（arXiv 2609.27040，2026）：单机多卡互相借还显存，prefetch 隐藏远端访问；borrower +52% throughput，
  达到 2x 容量系统的 96%，lender 可随时回收。
- Memory Harvesting（USENIX ATC'22）：层次化 UVM，收集空闲 GPU 显存。
  https://dblp.org/rec/conf/usenix/ChoiKJAJKA22.html
- GPUswap（VEE'15）：透明 GPU 显存换出/超额订阅。
  https://doi.org/10.1145/2731186.2731192
- VUGVA（Zenodo 2026，preprint）：CUDA runtime 拦截 + NUMA-aware P2P 虚拟分页，统一非 NVLink 多卡 VRAM；
  宣称达到 NVLink 方案的 85% 性能、<15% 成本。
  https://zenodo.org/records/21549808
- Beluga（SIGMOD'26，arXiv 2511.20172）：GPU 经 CXL switch 直接 load/store 访问共享内存池；
  vs RDMA 方案 TTFT -89.6%、吞吐 7.35x。
- TRANSIT（arXiv 2610.07593，2026）：多节点 LLM 训练透明 scale-in，最多少用 50% GPU，保留 >90% 吞吐；64×H100 + RoCE。

### 非 NVIDIA
- AMD ROCm：`hipMallocManaged` + HMM；`HSA_XNACK=1` 开启页错误驱动迁移；CDNA2+ 支持 system allocator；
  MI200 SR-IOV 不支持 XNACK。
  https://rocm.docs.amd.com/projects/HIP/en/latest/how-to/hip_runtime_api/memory_management/unified_memory.html
- MI300A：24 Zen4 + 228 CDNA3，共享最高 128 GB unified HBM3，CPU/GPU 无需显式拷贝。
  https://instinct.docs.amd.com/projects/amdgpu-docs/en/docs-30.10/gpu-partitioning/mi300a/index.html
- Intel Level Zero USM：device/host/shared allocations，shared 由驱动迁移；有 page migration 成本和 ping-pong。
  https://www.intel.com/content/www/us/en/docs/oneapi/optimization-guide-gpu/2024-0/unified-shared-memory-allocations.html
- Linux HMM：CPU 页表镜像 + `ZONE_DEVICE` + `migrate_vma_*`。
  https://docs.kernel.org/mm/hmm.html
- NVLink Fusion：允许第三方 CPU/XPU 以 NVLink 接入 NVIDIA 机架（NVLink 6，72 XPU all-to-all）。
  https://www.nvidia.com/en-us/data-center/nvlink-fusion/
