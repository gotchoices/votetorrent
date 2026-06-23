/**
 * Ticket: optimystic-coordinator-read-repair
 *
 * `CoordinatorRepo.get` now consults cluster peers not only when a block is
 * entirely missing locally, but also when the local copy might be stale —
 * gated by the `readRepairMode` policy on `ClusterConsensusConfig`. These
 * specs pin the three modes (off / lazy / paranoid) and the window+sample
 * behavior for the lazy mode, so a peer that missed the post-majority commit
 * broadcast catches up on the next read instead of serving indefinitely-stale
 * data.
 */
export {};
//# sourceMappingURL=coordinator-repo-read-repair.spec.d.ts.map