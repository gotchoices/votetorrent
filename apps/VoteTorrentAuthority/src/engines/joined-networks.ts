/**
 * joined-networks.ts — binding over the shared joined-networks store, which moved to
 * `packages/workflows/src/common/joined-networks.ts` (phase 67 plan 08). This path stays so engine-factory,
 * authority-network-join and the tests import it unchanged; this is where the Authority supplies its
 * key-value store and its D-30 reject mode: a joined hash never opens as founder, an unreadable, corrupt
 * or non-array list REJECTS `JoinedNetworksUnreadableError` (the shared class, through `./founder-intent`)
 * and `rememberJoinedNetwork` never writes over a list it could not read. Never logs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AUTHORITY_JOINED_NETWORKS_KEY, createJoinedNetworksStore} from '@votetorrent/workflows';
import {JoinedNetworksUnreadableError} from './founder-intent';

export {AUTHORITY_JOINED_NETWORKS_KEY} from '@votetorrent/workflows';

export const {readJoinedNetworkHashes, isJoinedNetwork, rememberJoinedNetwork} = createJoinedNetworksStore(AsyncStorage, AUTHORITY_JOINED_NETWORKS_KEY, {
	unreadable: 'reject',
	unreadableError: () => new JoinedNetworksUnreadableError(),
});
