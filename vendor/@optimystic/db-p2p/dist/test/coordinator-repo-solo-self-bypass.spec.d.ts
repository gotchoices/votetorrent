/**
 * Ticket: optimystic-solo-cluster-self-sync-bypass
 *
 * When a block's cluster resolves to only the local peer, `CoordinatorRepo`
 * must skip the cluster-latest callback entirely. Querying oneself is a
 * pointless round trip at best; in production it dials self via `SyncClient`,
 * which on nodes without listen addresses (solo bare-RN, WebSocket-only) can
 * hang the libp2p dial queue. This spec pins the bypass behavior.
 */
export {};
//# sourceMappingURL=coordinator-repo-solo-self-bypass.spec.d.ts.map