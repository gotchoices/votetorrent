/**
 * D-30 founder intent moved to @votetorrent/workflows common/founder-intent.ts; this path stays so
 * engine-factory, joined-networks, authority-network-join and tests import it unchanged. It re-exports
 * the shared module by identity: ONE slot per process, shared with the strand factory, so a founding
 * window set through this path is the one `createStrandDbFactory` consumes.
 */
export {
	FounderIntentBusyError,
	isFounderIntentBusyError,
	JoinedNetworksUnreadableError,
	isJoinedNetworksUnreadableError,
	withFounding,
	withJoining,
	takeFounderIntent,
	resolveFounderFlag,
	wrapCreateWithFounding,
} from '@votetorrent/workflows';
export type { FounderIntent } from '@votetorrent/workflows';
