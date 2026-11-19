# Kubernetes Control Plane HA / DR / Incident Handling — Research Notes

Date: 2026-11-19
Scope: how the Kubernetes control plane achieves high availability, how it is backed up and
restored (disaster recovery), and how control-plane incidents are detected, triaged and handled.
This note is the source-baseline for the wiki pages:

- `src/docs/Cloud_Native/Kubernetes/控制面高可用方案.md`
- `src/docs/Cloud_Native/Kubernetes/控制面灾备与恢复.md`
- `src/docs/Cloud_Native/Kubernetes/控制面事故处理手册.md`

## 1. Evidence baseline (pinned checkouts)

| Project | Version | Commit | Local checkout |
|---|---|---|---|
| Kubernetes | v1.37.2 | `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` | `.repos/upstream/kubernetes` (sparse + blobless) |
| etcd | v3.7.4 | `2e8a5c99e4982c8d4c521be15364ea4c5c68a489` | `.repos/upstream/etcd` |
| Velero | v1.18.4 | `4ee1e79a7aed367fd9b767b8219ec65bd0c96892` | `.repos/upstream/velero` |
| Cluster API | v1.14.4 | `4356c154f4a76b8939748ef7ebc2d0793ffe47e8` | `.repos/upstream/cluster-api` |
| kube-vip | v1.3.1 | `6da770eac1eed9409a9feaccda3d782c94424c24` | `.repos/upstream/kube-vip` |

Kubernetes v1.37.2 pins etcd **3.7.0-0** as the kubeadm default
(`build/dependencies.yaml`, `cmd/kubeadm/app/constants/constants.go` `DefaultEtcdVersion`), so
etcd evidence uses the 3.7.4 patch checkout of the same minor.

Documentation bases: kubernetes.io (v1.37 docs), etcd.io/docs/v3.7, velero.io/docs/v1.18,
cluster-api.sigs.k8s.io, kube-vip.io/docs, cloud provider SLA/control-plane docs.
All links in the wiki pages are pinned to the SHAs above and were validated with
`.repos/verify-links.py` (file exists, line range valid, checkout HEAD == pinned SHA).

## 2. Control-plane HA: verified facts

### 2.1 Component state model

- kube-apiserver reads/writes etcd per request (`staging/src/k8s.io/apiserver/pkg/storage/etcd3/store.go`);
  its in-memory state (watch cache, long-running connections) is rebuildable. API servers are
  active-active behind a stable endpoint.
- etcd is the only persistent store for API objects. Quorum is `(n/2)+1`; 3 members tolerate 1
  failure, 5 tolerate 2; adding a member to reach an even size buys no extra tolerance
  (etcd FAQ). kubeadm joins new control-plane members as etcd **learners** and promotes them after
  catch-up (`cmd/kubeadm/app/util/etcd/etcd.go`).
- kube-controller-manager, kube-scheduler and cloud-controller-manager run multi-replica but only
  one instance acts: client-go leader election over `coordination.k8s.io/v1` Leases
  (`staging/src/k8s.io/client-go/tools/leaderelection/`). Defaults are
  `leaseDuration=15s`, `renewDeadline=10s`, `retryPeriod=2s`
  (`staging/src/k8s.io/component-base/config/v1alpha1/defaults.go#L37-L44`), so failover is
  on the order of 15–17s, not sub-second. The lock has no fencing; controllers rely on
  optimistic concurrency (resourceVersion), not the lease, for correctness.
- kubeadm runs control-plane components as static pods
  (`cmd/kubeadm/app/phases/etcd/local.go`, `cmd/kubeadm/app/phases/controlplane/`), sourced from
  files under `/etc/kubernetes/manifests` (`pkg/kubelet/config/file.go`), which is why static
  pods survive API outages.

### 2.2 Topologies

- **stacked etcd** (control plane and etcd co-located): minimum 3 hosts. Failure coupling: one
  host loss = one API server + one etcd member. With 3 members quorum still holds at 2/3.
- **external etcd**: 3 control-plane + 3 etcd hosts (twice the hosts), decoupled failure domains;
  apiserver points at external endpoints via `ClusterConfiguration.etcd.external` →
  `--etcd-servers`.
- Managed control planes (EKS/GKE/AKS): provider owns API servers/etcd; users still own node
  pools, workload HA, object/PV backups. GKE regional = replicas across zones (99.95% SLA) vs
  zonal (99.5%); EKS control plane endpoint public/private; AKS control-plane AZ placement is
  provider-defined.
- hosted control planes (Kamaji-style, CAPI ControlPlane providers) move the control plane into a
  management cluster, adding a "management cluster must itself be HA" dependency.

### 2.3 Entry path

- Ports: 6443 apiserver, 2379 etcd client, 2380 etcd peer, 2381 kubeadm etcd metrics/health.
- Stable entry is `--control-plane-endpoint` (VIP or L4 LB DNS). The endpoint is baked into
  certificate SANs, so changing it later implies re-issuing certificates.
- kubeconfig has one `Cluster.Server` URL; client-go does not fail over across multiple API
  servers. Failover must come from DNS/VIP/LB.
- kube-vip implements the VIP via ARP (L2) or BGP (L3); its control-plane election itself uses a
  Lease through the same apiserver, so a total API outage also freezes VIP movement.
- Load balancers should health-check `/readyz` with a tolerant failure threshold (shared etcd
  blips can otherwise remove every backend); TCP-only checks can keep routing to an API server
  that cannot reach etcd.

### 2.4 Failure analysis

- With all control planes down, the data plane freezes rather than crashes: running containers
  and kubelets continue, static pods continue, but no writes, scheduling, reconciliation,
  EndpointSlice updates or `kubectl exec/logs`. kube-proxy keeps the last iptables/IPVS rules;
  CoreDNS keeps serving cached records until TTL/cache miss (implementation-dependent, not an SLA).
- kubelet reports node status every 10s via node lease (default 40s); KCM marks NotReady after
  `nodeMonitorGracePeriod=50s`, evicts after `PodEvictionTimeout=5m`. After a long control-plane
  outage, all node leases are stale, so recovery can trigger mass NotReady/eviction if kubelets
  cannot reconnect quickly — restore connectivity first.

## 3. DR: verified facts

- Objects to protect: etcd data; PKI (`ca.key`, `front-proxy-ca.key`, `etcd/ca.key`, `sa.key`);
  apiserver encryption config + KMS keys; kubeconfigs; static pod manifests and `kubeadm-config`;
  PV data; external dependencies (registry, DNS, LB/VIP, IAM, KMS); IaC/GitOps sources.
- `etcdctl snapshot save` (etcd 3.7 still ships `save` only under `etcdctl`) streams a bbolt
  snapshot from one endpoint over `Maintenance.Snapshot`, with a SHA256 suffix; `status`/`restore`
  live in `etcdutl` (`etcdutl snapshot status|restore`).
- `etcdutl snapshot restore` builds a **new logical cluster**: it writes the DB, trims membership
  from the backend (`TrimMembershipFromBackend`), and accepts new `--name`,
  `--initial-cluster`, `--initial-advertise-peer-urls`. Kubernetes restores should use
  `--bump-revision` + `--mark-compacted` so existing watchers/caches invalidate and clients re-list.
- Consistent restore sequence (official guidance): stop **all** API servers (and KCM/scheduler),
  restore every etcd member from the **same** snapshot, start etcd, then restart the rest of the
  control plane. kubeadm itself has no etcd restore subcommand; recovery is etcdutl + manual
  static-pod orchestration (or external etcd operator).
- Quorum loss: two paths — restore from snapshot (preferred; loses writes after the snapshot) or
  `--force-new-cluster` (keeps one member's data, strongly discouraged per etcd docs: panics if
  other members are still alive, can leave zombie members). Verify `member list` afterwards.
- Full rebuild: keep PKI to preserve identities; `kubeadm init` skips existing CA/cert pairs;
  external etcd allows rebuilding only the control plane against intact etcd. Cluster API
  `clusterctl move` pivots management objects between management clusters, but upstream explicitly
  says it is not a backup/restore mechanism (no Status restore, no guarantees for in-flight
  mutations).
- Velero backs up selected API objects + PV data (native/CSI snapshots or node-agent file-system
  backup via kopia). It cannot back up etcd-level state or the control plane itself; backups are
  not strictly atomic; Status is not restored; file-system backup uses a static shared encryption
  key (bucket access ≈ plaintext access). Object storage is the source of truth, so a rebuilt
  cluster can re-sync backup records from the same bucket.
- DR drills are the only reliable RTO measurement: restore-to-temp-dir weekly/monthly, etcd member
  loss quarterly, quorum-loss restore half-yearly, full rebuild yearly; verify object counts,
  RBAC, PV data, certificates, encryption readability.

## 4. Incident handling: verified facts

- Health endpoints: `/livez` = should the process be restarted; `/readyz` = can it serve
  (readiness checks add `etcd-readiness` and watch-cache init); `/healthz` = deprecated compat.
  The `etcd` health group is added via `AddHealthChecks` to healthz/livez/readyz — `/livez` is
  not a pure process-liveness check; only `etcd-readiness` is readyz-only
  (`staging/src/k8s.io/apiserver/pkg/server/healthz.go`, `server/options/etcd.go`).
- Key signals: `apiserver_request_total{code=~"5.."}`, request duration, `apiserver_current_inflight_requests`,
  APF `apiserver_flowcontrol_rejected_requests_total` / queue depth; etcd `etcd_server_has_leader`,
  `etcd_server_leader_changes_seen_total`, `etcd_disk_wal_fsync_duration_seconds`,
  `etcd_disk_backend_commit_duration_seconds`, `etcd_mvcc_db_total_size_in_bytes`; webhook
  `apiserver_admission_webhook_rejection_count`; node lease/status.
- Default limits: 400 non-mutating + 200 mutating in-flight (APF enabled by default; total
  concurrency = 600, shared by nominal shares); etcd backend quota 2GiB default / 8GiB suggested
  max; NOSPACE alarm triggers when the quota is exceeded (fix order: compaction → defrag each
  member → alarm disarm, after confirming space is freed).
- Certificates: kubeadm leaf certs 1 year, CA 10 years; `kubeadm certs renew` does not renew the
  CA; cluster/component certificates can be monitored via
  `apiserver_client_certificate_expiration_seconds`; kubelet client cert rotation requires a
  reachable API server (CSR), otherwise re-bootstrap is needed.
- Common control-plane failure modes covered in the runbook: all-API down, single API crash-loop,
  etcd no-leader/leader flapping, NOSPACE, quorum loss, certificate expiry (incl. CA), admission/
  aggregated-API outages blocking writes, APF overload/429, controller-manager/scheduler election
  flapping, node NotReady/disk pressure, accidental deletion, failed upgrades/version skew.
- Latency decomposition (apiserver slow but serving): `apiserver_request_duration_seconds` includes
  admission-webhook time and APF queue wait, while `apiserver_request_sli_duration_seconds` excludes both;
  `etcd_request_duration_seconds` isolates storage time, and webhook latency has its own
  `apiserver_admission_webhook_admission_duration_seconds`. Non-long-running requests exceeding
  `--request-timeout` (default 60s) get 504.
- Incident process: detect → classify (P0–P3) → name IC + freeze changes → stop the bleeding →
  verify recovery → root cause → postmortem; collect evidence before restarting
  (`kubectl cluster-info dump`, `crictl logs`, `journalctl -u kubelet`, etcd status/alarms/members
  and — if feasible — a snapshot), keep a timestamped timeline.

## 5. Known gaps / caveats

- Managed-cluster specifics (EKS/GKE/AKS consoles, SLA numbers, support flows) are only covered at
  the responsibility-boundary level; vendor docs should be checked per environment.
- All RTO/RPO numbers in the wiki pages are experience ranges, not vendor commitments.
- The snapshot→stacked-etcd restore procedure is a composition of the official etcd restore
  semantics with kubeadm's static-pod layout; there is no single official kubeadm page for
  multi-member etcd restore in v1.37, so operators must rehearse it in a sandbox first.
- "CoreDNS serves cached records / kube-proxy keeps last rules while the API is down" is
  implementation semantics, not an availability guarantee.
