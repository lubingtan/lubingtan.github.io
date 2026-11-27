// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="graph_view.html">Graph View</a></span></li><li class="chapter-item "><li class="part-title">Cloud Native</li></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="ai_infrastructure.html">AI Infrastructure</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="accelerators.html">Accelerators</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Accelerators/hami-core.html">HAMi-core：容器内 CUDA 劫持与资源隔离</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Accelerators/hami.html">HAMi：Kubernetes 异构 AI 算力虚拟化与调度</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="agents.html">Agents</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Agents/agent-sandbox.html">Agent Sandbox: K8s 原生沙箱执行环境</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Agents/agent-substrate.html">Agent Substrate: 高密度 Agent 沙箱 Runtime</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Agents/kagent.html">kagent: K8s 原生 AI Agent 框架</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="distributed_training.html">Distributed Training</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Distributed_Training/checkpoint-preemption.html">Checkpoint 与抢占恢复：状态、恢复点与成员重建</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Distributed_Training/rl-post-training.html">RL 后训练与业务接入：阶段、版本与失败域</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Distributed_Training/overview.html">云原生分布式训练：编排与稳定性专题</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Distributed_Training/workload-modeling.html">工作负载建模：从 Pod 到可恢复的成员组</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Distributed_Training/failure-self-healing.html">训练失败与自愈：首发原因、恢复单元与失败预算</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="frameworks.html">Frameworks</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Frameworks/cordis-hello-world.html">Cordis Hello World：跑通可逆副作用与响应式依赖</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Frameworks/cordis.html">Cordis：时空可组合性元框架</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="cordis-hello-world.assets.html">cordis-hello-world.assets</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Frameworks/cordis-hello-world.assets/index.html">Cordis Hello World（本地可 build / run 的最小 demo）</a></span></li></ol></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="heterogeneous_resources.html">Heterogeneous Resources</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/overview.html">CPU / GPU 异构资源管理与设备运维：专题总览</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/cpu-memory-node.html">CPU、内存与节点资源基础</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/gpu-access-chain.html">GPU 软件栈与接入链路</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/gpu-operations.html">GPU 运维与故障处置</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/sharing-isolation-topology.html">共享、隔离与拓扑</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/AI_Infrastructure/Heterogeneous_Resources/training-inference-mix.html">训推混部与协同放置</a></span></li></ol></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="cluster_lifecycle.html">Cluster Lifecycle</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Cluster_Lifecycle/cluster-api.html">Cluster API: 声明式集群生命周期管理</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="kubernetes.html">Kubernetes</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="control_plane.html">Control Plane</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/flowschema.html">API Priority and Fairness：FlowSchema 与 PriorityLevelConfiguration</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/控制面事故处理手册.html">Kubernetes 控制面事故处理手册</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/控制面灾备与恢复.html">Kubernetes 控制面灾备与恢复</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/控制面高可用方案.html">Kubernetes 控制面高可用方案</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/2_kubernetes-api-server.html">kube-apiserver：原理、生产故障与参数调优</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Control_Plane/大规模多集群版本升级.html">大规模多集群 Kubernetes 版本升级：规划、执行与故障处理</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="extensibility.html">Extensibility</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Extensibility/client-go-list-watch.html">client-go List/Watch 原理：从 API 语义到 SharedInformer</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Extensibility/production-operator.html">生产级 Kubernetes Operator：从 CRD 到状态收敛与升级</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="fundamentals.html">Fundamentals</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Fundamentals/1_kubernetes概念.html">What is Kubernetes</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Fundamentals/1-1_k8s工作负载.html">Pod</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Fundamentals/rbac.html">RBAC</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="networking.html">Networking</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Networking/cni详解.html">CNI 详解：从 kubelet 到 veth、bridge 与 overlay</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Networking/k8s-network-path.html">Kubernetes 网络全链路：Pod、Service、LoadBalancer 与 DNS</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Networking/6_service相关.html">Service、kube-proxy 与 LoadBalancer：从 VIP 到后端 Pod</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Networking/multicluster-networking.html">多集群网络互联：发现、访问、成员地址与 NAT 穿透</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="node_runtime.html">Node Runtime</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Node_Runtime/kubelet原理.html">Kubelet 原理</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Node_Runtime/k8s之pleg.html">PLEG：Pod Lifecycle Event Generator</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Node_Runtime/容器运行时.html">容器运行时全链路：OCI、CRI、containerd、shim 与 RuntimeClass</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="scheduling.html">Scheduling</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/kueue.html">Kueue: Kubernetes 原生作业队列管理器</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/scheduling-framework.html">Scheduling Framework：扩展点、状态与并发语义</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/volcano-scheduler.html">Volcano 调度器：Session、Action 与队列模型</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/4_kube-scheduler源码分析.html">k8s scheduler 源码分析</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/native-scheduler.html">kube-scheduler：对象、队列与调度主流程</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/scheduling-overview.html">调度器源码与策略：专题导读</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/scheduling-evidence.html">调度正确性与优化证据：不变式、指标与同轨迹对比</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Kubernetes/Scheduling/scheduling-strategy.html">调度策略与约束：配额、Gang、拓扑与 DRA</a></span></li></ol></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="linux_container.html">Linux Container</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Linux_Container/OverlayFS与镜像层.html">OverlayFS 与镜像层：从联合挂载到 OCI 分层</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Linux_Container/容器知识备忘录.html">一份容器知识备忘录</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Linux_Container/镜像快照器snapshotter.html">镜像快照器（Snapshotter）：containerd 如何把层变成 rootfs</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Linux_Container/镜像懒加载.html">镜像懒加载：stargz、Nydus、SOCI 与 OverlayBD</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="platform_engineering.html">Platform Engineering</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/agent-era-devops.html">Agent 时代的 DevOps：从交付流水线到交付系统</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/ci-cd-quality-gates.html">CI/CD 与自动化质量保障：从流水线到证据链</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/devops-thinking.html">DevOps 理念与实践：从 CI/CD 到平台工程</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/observability-and-sre.html">可观测性与稳定性：从监控到可运营系统</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/platform-as-a-product.html">平台工程：把工程能力变成可复用的产品</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/platform-adoption.html">平台落地：协作、规范与效果评估</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Platform_Engineering/environment-as-a-service.html">环境即服务：云原生资源自助交付与治理</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="virtualization.html">Virtualization</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Cloud_Native/Virtualization/沙箱与虚拟化技术全景.html">沙箱与虚拟化技术全景：KVM、QEMU、Firecracker、Kata、gVisor</a></span></li></ol><li class="chapter-item "><li class="part-title">Distributed Systems</li></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Distributed_Systems/mesos.html">Apache Mesos: 分布式系统内核</a></span></li><li class="chapter-item "><li class="part-title">Machine Learning</li></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="distributed_training.html">Distributed Training</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/Distributed_Training/startup-communication.html">训练启动与通信：rank、rendezvous 与第一个 collective</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="high_performance_computing.html">High Performance Computing</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/High_Performance_Computing/gpu-cluster-pooling.html">GPU 算力/显存池化：从 CUDA 单卡视角到跨节点透明调度</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/High_Performance_Computing/ompi架构介绍.html">Open MPI 架构介绍</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/High_Performance_Computing/slurm.html">Slurm: HPC 集群工作负载管理器</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="inference.html">Inference</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/Inference/Model Mesh Serving: 一种可以大规模部署ML模型的解决方案.html">Model Mesh Serving: 一种可以大规模部署ML模型的解决方案</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Machine_Learning/Inference/vLLM Production Stack实战.html">vLLM Production Stack 实战</a></span></li></ol><li class="chapter-item "><li class="part-title">Operation</li></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="development_environment.html">Development Environment</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Operation/Development_Environment/Docker环境配置.html">Docker环境配置</a></span></li><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Operation/Development_Environment/WIndows开发环境配置.html">WIndows开发环境配置</a></span></li></ol><li class="chapter-item "><span class="chapter-link-wrapper"><a href="linux.html">Linux</a><a class="chapter-fold-toggle"><div>❱</div></a></span><ol class="section"><li class="chapter-item "><span class="chapter-link-wrapper"><a href="docs/Operation/Linux/Bash以及命令行工具技巧集合.html">Bash以及命令行工具技巧集合</a></span></li></ol></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split('#')[0].split('?')[0];
        if (current_page.endsWith('/')) {
            current_page += 'index.html';
        }
        const links = Array.prototype.slice.call(this.querySelectorAll('a'));
        const l = links.length;
        for (let i = 0; i < l; ++i) {
            const link = links[i];
            const href = link.getAttribute('href');
            if (href && !href.startsWith('#') && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The 'index' page is supposed to alias the first chapter in the book.
            if (link.href === current_page
                || i === 0
                && path_to_root === ''
                && current_page.endsWith('/index.html')) {
                link.classList.add('active');
                let parent = link.parentElement;
                while (parent) {
                    if (parent.tagName === 'LI' && parent.classList.contains('chapter-item')) {
                        parent.classList.add('expanded');
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', e => {
            if (e.target.tagName === 'A') {
                const clientRect = e.target.getBoundingClientRect();
                const sidebarRect = this.getBoundingClientRect();
                sessionStorage.setItem('sidebar-scroll-offset', clientRect.top - sidebarRect.top);
            }
        }, { passive: true });
        const sidebarScrollOffset = sessionStorage.getItem('sidebar-scroll-offset');
        sessionStorage.removeItem('sidebar-scroll-offset');
        if (sidebarScrollOffset !== null) {
            // preserve sidebar scroll position when navigating via links within sidebar
            const activeSection = this.querySelector('.active');
            if (activeSection) {
                const clientRect = activeSection.getBoundingClientRect();
                const sidebarRect = this.getBoundingClientRect();
                const currentOffset = clientRect.top - sidebarRect.top;
                this.scrollTop += currentOffset - parseFloat(sidebarScrollOffset);
            }
        } else {
            // scroll sidebar to current active section when navigating via
            // 'next/previous chapter' buttons
            const activeSection = document.querySelector('#mdbook-sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        const sidebarAnchorToggles = document.querySelectorAll('.chapter-fold-toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(el => {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define('mdbook-sidebar-scrollbox', MDBookSidebarScrollbox);


// ---------------------------------------------------------------------------
// Support for dynamically adding headers to the sidebar.

(function() {
    // This is used to detect which direction the page has scrolled since the
    // last scroll event.
    let lastKnownScrollPosition = 0;
    // This is the threshold in px from the top of the screen where it will
    // consider a header the "current" header when scrolling down.
    const defaultDownThreshold = 150;
    // Same as defaultDownThreshold, except when scrolling up.
    const defaultUpThreshold = 300;
    // The threshold is a virtual horizontal line on the screen where it
    // considers the "current" header to be above the line. The threshold is
    // modified dynamically to handle headers that are near the bottom of the
    // screen, and to slightly offset the behavior when scrolling up vs down.
    let threshold = defaultDownThreshold;
    // This is used to disable updates while scrolling. This is needed when
    // clicking the header in the sidebar, which triggers a scroll event. It
    // is somewhat finicky to detect when the scroll has finished, so this
    // uses a relatively dumb system of disabling scroll updates for a short
    // time after the click.
    let disableScroll = false;
    // Array of header elements on the page.
    let headers;
    // Array of li elements that are initially collapsed headers in the sidebar.
    // I'm not sure why eslint seems to have a false positive here.
    // eslint-disable-next-line prefer-const
    let headerToggles = [];
    // This is a debugging tool for the threshold which you can enable in the console.
    let thresholdDebug = false;

    // Updates the threshold based on the scroll position.
    function updateThreshold() {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const windowHeight = window.innerHeight;
        const documentHeight = document.documentElement.scrollHeight;

        // The number of pixels below the viewport, at most documentHeight.
        // This is used to push the threshold down to the bottom of the page
        // as the user scrolls towards the bottom.
        const pixelsBelow = Math.max(0, documentHeight - (scrollTop + windowHeight));
        // The number of pixels above the viewport, at least defaultDownThreshold.
        // Similar to pixelsBelow, this is used to push the threshold back towards
        // the top when reaching the top of the page.
        const pixelsAbove = Math.max(0, defaultDownThreshold - scrollTop);
        // How much the threshold should be offset once it gets close to the
        // bottom of the page.
        const bottomAdd = Math.max(0, windowHeight - pixelsBelow - defaultDownThreshold);
        let adjustedBottomAdd = bottomAdd;

        // Adjusts bottomAdd for a small document. The calculation above
        // assumes the document is at least twice the windowheight in size. If
        // it is less than that, then bottomAdd needs to be shrunk
        // proportional to the difference in size.
        if (documentHeight < windowHeight * 2) {
            const maxPixelsBelow = documentHeight - windowHeight;
            const t = 1 - pixelsBelow / Math.max(1, maxPixelsBelow);
            const clamp = Math.max(0, Math.min(1, t));
            adjustedBottomAdd *= clamp;
        }

        let scrollingDown = true;
        if (scrollTop < lastKnownScrollPosition) {
            scrollingDown = false;
        }

        if (scrollingDown) {
            // When scrolling down, move the threshold up towards the default
            // downwards threshold position. If near the bottom of the page,
            // adjustedBottomAdd will offset the threshold towards the bottom
            // of the page.
            const amountScrolledDown = scrollTop - lastKnownScrollPosition;
            const adjustedDefault = defaultDownThreshold + adjustedBottomAdd;
            threshold = Math.max(adjustedDefault, threshold - amountScrolledDown);
        } else {
            // When scrolling up, move the threshold down towards the default
            // upwards threshold position. If near the bottom of the page,
            // quickly transition the threshold back up where it normally
            // belongs.
            const amountScrolledUp = lastKnownScrollPosition - scrollTop;
            const adjustedDefault = defaultUpThreshold - pixelsAbove
                + Math.max(0, adjustedBottomAdd - defaultDownThreshold);
            threshold = Math.min(adjustedDefault, threshold + amountScrolledUp);
        }

        if (documentHeight <= windowHeight) {
            threshold = 0;
        }

        if (thresholdDebug) {
            const id = 'mdbook-threshold-debug-data';
            let data = document.getElementById(id);
            if (data === null) {
                data = document.createElement('div');
                data.id = id;
                data.style.cssText = `
                    position: fixed;
                    top: 50px;
                    right: 10px;
                    background-color: 0xeeeeee;
                    z-index: 9999;
                    pointer-events: none;
                `;
                document.body.appendChild(data);
            }
            data.innerHTML = `
                <table>
                  <tr><td>documentHeight</td><td>${documentHeight.toFixed(1)}</td></tr>
                  <tr><td>windowHeight</td><td>${windowHeight.toFixed(1)}</td></tr>
                  <tr><td>scrollTop</td><td>${scrollTop.toFixed(1)}</td></tr>
                  <tr><td>pixelsAbove</td><td>${pixelsAbove.toFixed(1)}</td></tr>
                  <tr><td>pixelsBelow</td><td>${pixelsBelow.toFixed(1)}</td></tr>
                  <tr><td>bottomAdd</td><td>${bottomAdd.toFixed(1)}</td></tr>
                  <tr><td>adjustedBottomAdd</td><td>${adjustedBottomAdd.toFixed(1)}</td></tr>
                  <tr><td>scrollingDown</td><td>${scrollingDown}</td></tr>
                  <tr><td>threshold</td><td>${threshold.toFixed(1)}</td></tr>
                </table>
            `;
            drawDebugLine();
        }

        lastKnownScrollPosition = scrollTop;
    }

    function drawDebugLine() {
        if (!document.body) {
            return;
        }
        const id = 'mdbook-threshold-debug-line';
        const existingLine = document.getElementById(id);
        if (existingLine) {
            existingLine.remove();
        }
        const line = document.createElement('div');
        line.id = id;
        line.style.cssText = `
            position: fixed;
            top: ${threshold}px;
            left: 0;
            width: 100vw;
            height: 2px;
            background-color: red;
            z-index: 9999;
            pointer-events: none;
        `;
        document.body.appendChild(line);
    }

    function mdbookEnableThresholdDebug() {
        thresholdDebug = true;
        updateThreshold();
        drawDebugLine();
    }

    window.mdbookEnableThresholdDebug = mdbookEnableThresholdDebug;

    // Updates which headers in the sidebar should be expanded. If the current
    // header is inside a collapsed group, then it, and all its parents should
    // be expanded.
    function updateHeaderExpanded(currentA) {
        // Add expanded to all header-item li ancestors.
        let current = currentA.parentElement;
        while (current) {
            if (current.tagName === 'LI' && current.classList.contains('header-item')) {
                current.classList.add('expanded');
            }
            current = current.parentElement;
        }
    }

    // Updates which header is marked as the "current" header in the sidebar.
    // This is done with a virtual Y threshold, where headers at or below
    // that line will be considered the current one.
    function updateCurrentHeader() {
        if (!headers || !headers.length) {
            return;
        }

        // Reset the classes, which will be rebuilt below.
        const els = document.getElementsByClassName('current-header');
        for (const el of els) {
            el.classList.remove('current-header');
        }
        for (const toggle of headerToggles) {
            toggle.classList.remove('expanded');
        }

        // Find the last header that is above the threshold.
        let lastHeader = null;
        for (const header of headers) {
            const rect = header.getBoundingClientRect();
            if (rect.top <= threshold) {
                lastHeader = header;
            } else {
                break;
            }
        }
        if (lastHeader === null) {
            lastHeader = headers[0];
            const rect = lastHeader.getBoundingClientRect();
            const windowHeight = window.innerHeight;
            if (rect.top >= windowHeight) {
                return;
            }
        }

        // Get the anchor in the summary.
        const href = '#' + lastHeader.id;
        const a = [...document.querySelectorAll('.header-in-summary')]
            .find(element => element.getAttribute('href') === href);
        if (!a) {
            return;
        }

        a.classList.add('current-header');

        updateHeaderExpanded(a);
    }

    // Updates which header is "current" based on the threshold line.
    function reloadCurrentHeader() {
        if (disableScroll) {
            return;
        }
        updateThreshold();
        updateCurrentHeader();
    }


    // When clicking on a header in the sidebar, this adjusts the threshold so
    // that it is located next to the header. This is so that header becomes
    // "current".
    function headerThresholdClick(event) {
        // See disableScroll description why this is done.
        disableScroll = true;
        setTimeout(() => {
            disableScroll = false;
        }, 100);
        // requestAnimationFrame is used to delay the update of the "current"
        // header until after the scroll is done, and the header is in the new
        // position.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                // Closest is needed because if it has child elements like <code>.
                const a = event.target.closest('a');
                const href = a.getAttribute('href');
                const targetId = href.substring(1);
                const targetElement = document.getElementById(targetId);
                if (targetElement) {
                    threshold = targetElement.getBoundingClientRect().bottom;
                    updateCurrentHeader();
                }
            });
        });
    }

    // Takes the nodes from the given head and copies them over to the
    // destination, along with some filtering.
    function filterHeader(source, dest) {
        const clone = source.cloneNode(true);
        clone.querySelectorAll('mark').forEach(mark => {
            mark.replaceWith(...mark.childNodes);
        });
        dest.append(...clone.childNodes);
    }

    // Scans page for headers and adds them to the sidebar.
    document.addEventListener('DOMContentLoaded', function() {
        const activeSection = document.querySelector('#mdbook-sidebar .active');
        if (activeSection === null) {
            return;
        }

        const main = document.getElementsByTagName('main')[0];
        headers = Array.from(main.querySelectorAll('h2, h3, h4, h5, h6'))
            .filter(h => h.id !== '' && h.children.length && h.children[0].tagName === 'A');

        if (headers.length === 0) {
            return;
        }

        // Build a tree of headers in the sidebar.

        const stack = [];

        const firstLevel = parseInt(headers[0].tagName.charAt(1));
        for (let i = 1; i < firstLevel; i++) {
            const ol = document.createElement('ol');
            ol.classList.add('section');
            if (stack.length > 0) {
                stack[stack.length - 1].ol.appendChild(ol);
            }
            stack.push({level: i + 1, ol: ol});
        }

        // The level where it will start folding deeply nested headers.
        const foldLevel = 3;

        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            const level = parseInt(header.tagName.charAt(1));

            const currentLevel = stack[stack.length - 1].level;
            if (level > currentLevel) {
                // Begin nesting to this level.
                for (let nextLevel = currentLevel + 1; nextLevel <= level; nextLevel++) {
                    const ol = document.createElement('ol');
                    ol.classList.add('section');
                    const last = stack[stack.length - 1];
                    const lastChild = last.ol.lastChild;
                    // Handle the case where jumping more than one nesting
                    // level, which doesn't have a list item to place this new
                    // list inside of.
                    if (lastChild) {
                        lastChild.appendChild(ol);
                    } else {
                        last.ol.appendChild(ol);
                    }
                    stack.push({level: nextLevel, ol: ol});
                }
            } else if (level < currentLevel) {
                while (stack.length > 1 && stack[stack.length - 1].level > level) {
                    stack.pop();
                }
            }

            const li = document.createElement('li');
            li.classList.add('header-item');
            li.classList.add('expanded');
            if (level < foldLevel) {
                li.classList.add('expanded');
            }
            const span = document.createElement('span');
            span.classList.add('chapter-link-wrapper');
            const a = document.createElement('a');
            span.appendChild(a);
            a.href = '#' + header.id;
            a.classList.add('header-in-summary');
            filterHeader(header.children[0], a);
            a.addEventListener('click', headerThresholdClick);
            const nextHeader = headers[i + 1];
            if (nextHeader !== undefined) {
                const nextLevel = parseInt(nextHeader.tagName.charAt(1));
                if (nextLevel > level && level >= foldLevel) {
                    const toggle = document.createElement('a');
                    toggle.classList.add('chapter-fold-toggle');
                    toggle.classList.add('header-toggle');
                    toggle.addEventListener('click', () => {
                        li.classList.toggle('expanded');
                    });
                    const toggleDiv = document.createElement('div');
                    toggleDiv.textContent = '❱';
                    toggle.appendChild(toggleDiv);
                    span.appendChild(toggle);
                    headerToggles.push(li);
                }
            }
            li.appendChild(span);

            const currentParent = stack[stack.length - 1];
            currentParent.ol.appendChild(li);
        }

        const onThisPage = document.createElement('div');
        onThisPage.classList.add('on-this-page');
        onThisPage.append(stack[0].ol);
        const activeItemSpan = activeSection.parentElement;
        activeItemSpan.after(onThisPage);
    });

    document.addEventListener('DOMContentLoaded', reloadCurrentHeader);
    document.addEventListener('scroll', reloadCurrentHeader, { passive: true });
})();

