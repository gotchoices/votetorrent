/**
 * join-bootstrap.ts — binding over the shared join-bootstrap store, which moved to
 * `packages/workflows/src/common/join-bootstrap.ts` (phase 67 plan 08). This path stays so existing
 * importers (CadreNodeProvider, pair-mint-client, authority-network-join, the lean rig) and tests keep
 * working; this is where the Authority supplies its key-value store. The Authority's sanitizer keeps
 * relay-circuit addresses only; the persisted key moved verbatim and is pinned in workflows and here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AUTHORITY_JOIN_BOOTSTRAP_KEY, createJoinBootstrapStore, sanitizeAuthorityJoinBootstrap} from '@votetorrent/workflows';

export {AUTHORITY_JOIN_BOOTSTRAP_KEY, sanitizeAuthorityJoinBootstrap as sanitizeJoinBootstrap} from '@votetorrent/workflows';

export const {readJoinBootstrap, rememberJoinBootstrap} = createJoinBootstrapStore(AsyncStorage, AUTHORITY_JOIN_BOOTSTRAP_KEY, sanitizeAuthorityJoinBootstrap);
