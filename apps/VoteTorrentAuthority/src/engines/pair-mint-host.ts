/**
 * pair-mint-host.ts — binding. The owner-side pair-mint host moved to
 * `packages/workflows/src/authority/pair-mint-host.ts` (phase 67 plan 17) so the vt CLI shares it. This path
 * stays so CadreNodeProvider, the screens, the tests, their jest mocks and the lean rig keep working, and it
 * is the one place the app supplies its platform: AsyncStorage for the own-network reader, the pairing-owner
 * store's switch (an unreadable switch is OFF for mints, fail closed), mint log and revocation store, and
 * cadre-core's encoder through `lazy-cadre-invitation-codec`, all read at call time so every existing jest
 * mock keeps governing the result. `overrides` keep their old meaning and win over the app defaults.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CadreInvitation } from '@serfab/cadre-core';
import {
	hostPairMint as sharedHostPairMint,
	readActiveNetworkHash as sharedReadActiveNetworkHash,
	startPairMintHost as sharedStartPairMintHost,
	type PairMintHost,
	type PairMintHostInput,
	type PairMintHostNode,
	type PairMintHostOverrides,
} from '@votetorrent/workflows/authority';
import { lazyCadreInvitationCodec } from './lazy-cadre-invitation-codec';
import { createPairMintLog, listRevocationCandidates, markMintRevocation, readPairingSwitch } from './pairing-owner-store';

export {
	ACTIVE_NETWORKS_KEY,
	REVOCATION_TABLE,
	REVOCATION_BACKSTOP_MS,
	REVOCATION_SWEEP_MAX_LOOKUPS,
	REVOCATION_SWEEP_MAX_ACTIONS,
	planRevocationActions,
} from '@votetorrent/workflows/authority';
export type { RevocationAction, PairMintHostNode, PairMintHostDeps, PairMintHostOverrides, PairMintHost } from '@votetorrent/workflows/authority';

/** The hash of the network this phone's app has open, read from AsyncStorage. Never throws. */
export function readActiveNetworkHash(): Promise<string | null> {
	return sharedReadActiveNetworkHash(AsyncStorage);
}

function appInput(overrides: PairMintHostOverrides): PairMintHostInput {
	return {
		readOwnNetworkHash: overrides.readOwnNetworkHash ?? readActiveNetworkHash,
		// An unreadable switch is OFF for mints (fail closed).
		isEnabled: overrides.isEnabled ?? (() => readPairingSwitch().catch(() => false)),
		mintLog: overrides.mintLog ?? createPairMintLog(),
		revocationStore: {
			listRevocationCandidates: overrides.revocationStore?.listRevocationCandidates ?? listRevocationCandidates,
			markMintRevocation: overrides.revocationStore?.markMintRevocation ?? markMintRevocation,
		},
		encodeInvitation: (invitation) => lazyCadreInvitationCodec.encodeCadreInvitation(invitation as CadreInvitation),
		now: overrides.now,
		verifiers: overrides.verifiers,
		subscribeRevocations: overrides.subscribeRevocations,
	};
}

/** Serve the pair-mint service on `node`'s control node with the app's platform. */
export function hostPairMint(node: PairMintHostNode, overrides: PairMintHostOverrides = {}): Promise<PairMintHost> {
	return sharedHostPairMint(node, appInput(overrides));
}

/** Host the service only on an owner phone (null otherwise) with the app's platform. */
export function startPairMintHost(node: PairMintHostNode, overrides: PairMintHostOverrides = {}): Promise<PairMintHost | null> {
	return sharedStartPairMintHost(node, appInput(overrides));
}
