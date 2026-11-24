/**
 * First-sync gate helper — treats cadre-core's retryable `StrandAwaitingFirstSyncError`
 * as "still syncing", not a failure to open the network.
 *
 * Shared with the Authority through @votetorrent/workflows common/strand-first-sync.ts (cadre-core is a
 * TYPE-only import there; D-03's rule is about vote-engine, which still never imports it). This path stays
 * so the factory tests import it unchanged. Pure re-export, by identity.
 */
export {
	MIN_FIRST_SYNC_RETRY_INTERVAL_MS,
	isStrandAwaitingFirstSyncError,
	StrandWaitCancelledError,
	StrandLaunchFailedError,
	STRAND_ERROR_POLL_MS,
	failOnStrandError,
	waitForStrandWritable,
} from '@votetorrent/workflows';
export type { StrandStatusHost, StrandWritableHost } from '@votetorrent/workflows';
