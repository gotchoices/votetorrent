/**
 * join-bootstrap.ts — binding over the shared join-bootstrap and joined-networks stores, which moved to
 * `packages/workflows/src/common/join-bootstrap.ts` and `packages/workflows/src/common/joined-networks.ts`
 * (phase 67 plan 08). This path stays so existing importers (CadreNodeProvider, VoterAppProvider,
 * engine-factory, vote-send-flow, voter-network-join) and tests keep working; this is where the Voter
 * supplies its key-value store. The Voter's sanitizer keeps any peer-bound address and its joined list
 * keeps its lenient reader (unreadable reads as []); both persisted keys moved verbatim and are pinned.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
	VOTER_JOIN_BOOTSTRAP_KEY,
	VOTER_JOINED_NETWORKS_KEY,
	createJoinBootstrapStore,
	createJoinedNetworksStore,
	sanitizeVoterJoinBootstrap,
} from '@votetorrent/workflows';

export {VOTER_JOIN_BOOTSTRAP_KEY as JOIN_BOOTSTRAP_KEY, sanitizeVoterJoinBootstrap as sanitizeJoinBootstrap} from '@votetorrent/workflows';
/** The hashes of networks this phone joined from a join code (boot reopens the most recent one). */
export {VOTER_JOINED_NETWORKS_KEY as JOINED_NETWORKS_KEY} from '@votetorrent/workflows';

export const {readJoinBootstrap, rememberJoinBootstrap} = createJoinBootstrapStore(AsyncStorage, VOTER_JOIN_BOOTSTRAP_KEY, sanitizeVoterJoinBootstrap);
export const {readJoinedNetworkHashes, rememberJoinedNetwork} = createJoinedNetworksStore(AsyncStorage, VOTER_JOINED_NETWORKS_KEY, {unreadable: 'empty'});
