/**
 * D-30 founder intent (ported from the Authority, notes 19 E75) now lives in @votetorrent/workflows
 * common/founder-intent.ts. This path stays so engine-factory and the tests import it unchanged. There is
 * ONE slot per process, and the shared strand factory reads it. peekFounderIntent is the D-98 non-consuming
 * read.
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
	peekFounderIntent,
} from '@votetorrent/workflows';
export type { FounderIntent } from '@votetorrent/workflows';
