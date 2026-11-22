# Production-Grade Kubernetes Operator — Research Notes

Date: 2026-11-22
Scope: how a production-grade Kubernetes Operator is built and operated end to end:
CRD/API design, API server request path, list/watch consistency, informer/workqueue,
state convergence, idempotency, cleanup, concurrency, upgrades, observability and testing.

This note is the evidence baseline for:

- `src/docs/Cloud_Native/Kubernetes/production-operator.md`

## 1. Evidence baseline (pinned checkouts)

| Project | Version | Commit | Local checkout |
|---|---|---|---|
| Kubernetes | v1.37.2 | `c50e5395f1ae2d4a2c05f28fdcc38c0916cc1a32` | `.repos/upstream/kubernetes` |
| controller-runtime | v0.25.2 | `5d8467b3065818a3b382d8f6941147a801fd1969` | `.repos/upstream/controller-runtime` |
| sample-controller | main @ 2026-11 | `7204184eb240515173848d28f2e1f3788104a4d1` | `.repos/upstream/sample-controller` |
| Cluster API | v1.14.4 | `4356c154f4a76b8939748ef7ebc2d0793ffe47e8` | `.repos/upstream/cluster-api` |

Documentation bases: kubernetes.io (v1.37 docs), kubebuilder book, Operator SDK / OLM docs,
Kubernetes community API conventions. Doc markdown snapshots used while writing are under
`.repos/docs-cache/` (not part of the wiki content).

## 2. CRD and API server facts

- A CRD has `spec.group`, `names`, `scope`, `versions`, `conversion`; exactly one version must
  have `storage: true` (validation error otherwise). Version names are ordered kube-aware for
  discovery; `served` controls the REST endpoint.
  `staging/src/k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1/types.go:41-73,170-210`
  and `.../validation/validation.go:448`.
- `apiextensions.k8s.io/v1` requires a structural schema; non-structural schemas are rejected.
  Structural rules and pruning/defaulting behavior are documented in
  `content/en/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions.md`
  (`## Specifying a structural schema`, `### Field pruning`, `### Defaulting`).
- With the status subresource enabled: create ignores `status`; update on the main resource
  restores the old `status`; generation increments when non-metadata content changes; `/status`
  writes only the status stanza. Code:
  `.../pkg/registry/customresource/strategy.go:144-187`.
- CRD storage version selection and per-version conversion:
  `.../pkg/apiserver/customresource_handler.go:616-720` (build serving info, storage version,
  converter) and `:860-879` (`decoderVersion` = requested version, `encoderVersion` = storage
  version). This is why a non-storage version read/write/watch may invoke the conversion webhook,
  while a storage-version request does not.
- CRD conversion webhook skips objects already in the desired version:
  `.../pkg/apiserver/conversion/webhook_converter.go:122-142`. Failure of the webhook fails the
  API request for versions that need conversion.
- CRD serving path: `crdHandler.ServeHTTP` resolves `<resource>.<group>`, checks scope, served
  version, `NamesAccepted`/`Established`, builds per-version request scopes and subresource
  handlers. `.../pkg/apiserver/customresource_handler.go:228-368`.
- CRD spec updates tear down cached storage; in-flight requests can get errors and are expected
  to retry. `.../pkg/apiserver/customresource_handler.go:478-533`.
- CRD deletion is guarded by `customresourcecleanup.apiextensions.k8s.io`; the finalizer deletes
  all CR instances via delete-collection before removing the finalizer.
  `.../pkg/controller/finalizer/crd_finalizer.go:181-232`.
- Custom finalizer names must be qualified (`example.com/name`); validation uses
  `IsQualifiedName`. `staging/src/k8s.io/apimachinery/pkg/api/validation/objectmeta.go:116-125`.

## 3. List / watch / informer / workqueue facts

- `resourceVersion` is opaque but orderable as a monotonically increasing integer for the same
  resource type (1.35+ conformance). `resourceVersionMatch` controls list consistency; `410 Gone`
  means the requested RV is no longer retained; bookmarks carry an RV without an object change;
  streaming lists (`sendInitialEvents=true` + `resourceVersionMatch=NotOlderThan`) replace the
  initial list. Sources: `api-concepts.md` sections `Resource versions`,
  `Semantics for watch`, `410 Gone responses`, `Streaming lists`.
- WatchList feature gate: beta/default true since 1.34; client-go `WatchListClient` default true
  since 1.35. `staging/src/k8s.io/apiserver/pkg/features/kube_features.go:487-494` and
  `staging/src/k8s.io/client-go/features/known_features.go:141-145`.
- Watch cache history expiry returns `NewResourceExpired("too old resource version: ...")`:
  `.../pkg/storage/cacher/watch_cache_history.go:216-240`.
- Reflector: initial list (RV=0, paginated), watch from list RV, fall back to full list on
  `Expired`/`TooLargeResourceVersion`, handle bookmarks. `.../tools/cache/reflector.go:463-530,
  675-790, 1030-1078`.
- DeltaFIFO: per-object delta accumulation, dedup, tombstones, `Replace`/`Sync`.
  `.../tools/cache/delta_fifo.go:75-120`.
- Shared informer: same-RV update is a resync and only propagated to listeners that requested
  resync. `.../tools/cache/shared_informer.go:1083-1125`.
- Workqueue: `dirty` + `processing` sets; Add while processing marks dirty and re-queues after
  Done; per-item rate limiter plus optional bucket. `.../util/workqueue/queue.go:224-300` and
  `.../util/workqueue/default_rate_limiters.go:45-60`.
- controller-runtime reconcile loop: error -> rate-limited requeue; `TerminalError` -> no requeue;
  `RequeueAfter` -> Forget + AddAfter; success -> Forget.
  `pkg/internal/controller/controller.go:478-517`.
- controller-runtime defaults: MaxConcurrentReconciles=1, CacheSyncTimeout=2m, rate limiter is
  per-item exponential 5ms..1000s when priority queue is used. `pkg/controller/controller.go:48-101,
  260-277`.
- Cache reads: `client.Get`/`List` hit the informer cache unless the object is configured as
  uncached. `pkg/client/client.go:430-460`. Cache resync default 10h with jitter, triggers a
  synthetic same-RV update. `pkg/cache/cache.go:94-128`.
- Manager startup order: HTTP servers -> webhooks -> caches -> other runnables -> leader election.
  Webhooks must start before caches to avoid conversion-webhook/cache deadlock.
  `pkg/manager/internal.go:426-452`.
- Leader election defaults: LeaseDuration 15s, RenewDeadline 10s, RetryPeriod 2s.
  `pkg/manager/manager.go:219-236`.

## 4. Convergence / idempotency / cleanup / concurrency / upgrade facts

- Kubernetes APIs are level-based, not edge-based; spec is desired state, status is observed
  state; PUT expects the whole object; `/status` subresource is separate. API conventions
  `## Spec and Status`.
- `resourceVersion` optimistic concurrency: update with stale RV returns 409 conflict; the
  correct client action is GET, re-apply, retry. API conventions `## Concurrency Control and
  Consistency`; code `.../registry/generic/registry/store.go:792-809`; etcd `GuaranteedUpdate`
  retries on stale cache: `.../storage/etcd3/store.go:473-570`.
- SSA: apply is a full intent, field ownership tracked in `managedFields`; conflicts are 409;
  `force` overrides and transfers ownership. Controllers are advised to force conflicts on
  objects they own. API docs `## Using Server-Side Apply in a controller`; code
  `.../endpoints/handlers/patch.go:485-530` and
  `.../util/managedfields/internal/fieldmanager.go:187-215`.
- Finalizers: delete sets `deletionTimestamp` and returns 202; object remains until all
  finalizers are removed; no new finalizers after deletion starts. Docs `Finalizers`; code
  `.../registry/generic/registry/store.go:1203-1292,1116-1180`.
- OwnerReferences: same-namespace only (namespaced owner), cluster-scoped dependent only
  cluster-scoped owner; `controller` and `blockOwnerDeletion` semantics; GC foreground/
  background/orphan. Docs `Owners and Dependents`, `Garbage Collection`; code
  `.../apis/meta/v1/types.go:326-355`.
- Cluster API production patterns: add finalizer first to avoid init/delete race; defer a patch
  helper that updates status and only sets `observedGeneration` on success; retry condition
  patches on conflict with optimistic lock. `core/reconcilers/machine/machine_controller.go:190-290`,
  `util/finalizers/finalizers.go:28-49`, `util/patch/patch.go:340-385`.
- CAPI conversion preserves hub-only data in an annotation on down-conversion, so a
  spoke->hub->spoke round trip is lossless. `util/conversion/conversion.go:40-120` and
  `bootstrap/kubeadm/webhooks/conversion/kubeadmconfig.go:225-232`; fuzz round-trip helper
  `util/conversion/conversion.go:195-230`.
- Upgrade workflow for CRDs: add version, deploy conversion webhook, serve new version, switch
  storage, migrate stored objects (StorageVersionMigration or rewrite), then remove old version;
  `status.storedVersions` gates removal. Docs `custom-resource-definition-versioning.md`
  sections `Overview`, `Version removal`, `Upgrade existing objects to a new stored version`.
- Schema evolution: validation ratcheting allows adding validation without breaking unchanged
  invalid data; `required`/`properties`/list-type changes are not ratcheted. Docs
  `custom-resource-definitions.md` `### Validation ratcheting`.
- Operator packaging: OLM CSV declares owned/required CRDs and install strategy; update graph
  uses `replaces`/`skips`/`skipRange`. Docs `ClusterServiceVersion`, `Creating an update graph
  with OLM`. Operator SDK best practices: one operator per managed application, one controller
  per CRD, configurable watch namespace, no self-registered CRDs, meaningful status, support
  older operands, conversion webhooks, least privilege.
- Capability levels: L1 basic install, L2 seamless upgrades, L3 full lifecycle, L4 deep insights,
  L5 autopilot. Source: Operator SDK `Operator Capability Levels`.

## 5. Version-specific caveats

- WatchList is beta (default on since 1.34); streaming list is not yet GA.
- `ShardedListAndWatch` is alpha (1.36+) and gated; do not assume it is available.
- controller-runtime v0.25.2 defaults to a priority queue; when it is enabled the default
  rate limiter is per-item exponential only, not the MaxOf(bucket, exponential) combo. If a
  global retry QPS cap is required, pass a `MaxOfRateLimiter` explicitly.
- In controller-runtime, caches start before leader election, so standby replicas also list/watch.
  Plan API server/watch-cache capacity for all replicas, not only the leader.
- `conversion` webhooks have no `failurePolicy` equivalent; a down webhook blocks requests for
  non-storage versions. Run them HA and decouple their lifecycle from the controller being
  upgraded.
