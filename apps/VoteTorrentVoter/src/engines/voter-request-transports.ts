/**
 * voter-request-transports.ts — Phase 62 Plan 22 (D-28/D-29/D-32).
 *
 * Route selection and D-32 sealing over the Voter's OWN established-network strand. This module
 * never holds key material: every signature arrives as a `createDeviceSigner` (62-08) callback or
 * an already-resolved `Signature`, never a raw private key.
 *
 * Routing rule (Claude's discretion within D-28/D-29, recorded in 62-22-PLAN.md's `<interfaces>`):
 *   - not peer-backed: `resolve()` returns `undefined` before touching the strand port at all —
 *     association is P2P-only, so a non-strand-backed network has no delivery path, and the bridge
 *     URL is only knowable from replicated rows this device does not have without a strand.
 *   - peer-backed: association ALWAYS goes over P2P (D-28). Registration goes to the
 *     authority-configured REST bridge exactly when the replicated `AuthorityIntakePolicy` carries
 *     a non-null `restBridgeUrl` that also passes `isValidRestBridgeUrl` (D-29); otherwise P2P
 *     (the D-28 default). There is no automatic fallback between the two routes — a double path
 *     could stage the same request twice.
 *   - the REST route cannot carry 62-15's `extras` (the D-45 registration code) — recorded for
 *     62-28, which must branch on `registrationRoute` before minting one.
 *
 * Label: code-complete, unverified on devices (P2P-11 proof debt, tracked by 62-30).
 */
import type {
	AssociationAttestationAnswer,
	AssociationIdentityField,
	AssociationRequestInit,
	RegistrationRequestInit,
	Signature,
} from '@votetorrent/vote-core'
import {
	createIntakeSealer,
	intakeQueryPortFromStrandPort,
	isValidRestBridgeUrl,
	P2pAssociationTransport,
	P2pRegistrationTransport,
	readIntakePolicyFrom,
} from '@votetorrent/vote-engine/rn'
import {
	createAssociationAttestationDigestFn,
	createAssociationRequestDigestFn,
	createRegistrationRequestDigestFn,
	listOwnStagedAssociationRequestIds,
	listOwnStagedRegistrationRequestIds,
} from './strand-port-adapter'
import type { VoterStrandPort } from './strand-port-adapter'

export const VOTER_REQUEST_TRANSPORTS_ENGINE = 'requestTransports'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export type VoterRegistrationRoute = 'peer' | 'rest-bridge'

export interface VoterRegistrationRequestTransport {
	submitRequest(
		init: RegistrationRequestInit,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
		extras?: { registrationCode?: string },
	): Promise<string>
	pollDecisions(
		sinceCursor?: string,
	): Promise<Array<{ requestId: string; status: string; reason?: string; cursor: string }>>
}

export interface VoterAssociationRequestTransport {
	submitRequest(
		init: AssociationRequestInit,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
		extras?: { registrationCode?: string; identityFields?: readonly AssociationIdentityField[] },
	): Promise<string>
	submitAttestation(
		answer: AssociationAttestationAnswer,
		requesterKey: string,
		signatureOrCallback: SignatureOrCallback,
	): Promise<void>
	pollDecisions(
		sinceCursor?: string,
	): Promise<
		Array<{ requestId: string; status: string; challengeNonce?: string; reason?: string; cursor: string }>
	>
}

export interface VoterRequestTransports {
	registrationTransport: VoterRegistrationRequestTransport
	/** Always P2P (D-28) — association never routes to the REST bridge. */
	associationTransport: VoterAssociationRequestTransport
	registrationRoute: VoterRegistrationRoute
	ownAssociationRequestIds(requesterKey: string): Promise<string[]>
	/** Phase 62 Plan 28 (D-45) — own `RegistrationRequestStaging` row ids, scoped by `RequesterKey`.
	 * Wired on BOTH routes: the strand port exists whenever transports resolve, and on
	 * 'rest-bridge' it simply finds no row (the REST route never stages locally). */
	ownStagedRegistrationRequestIds(requesterKey: string): Promise<string[]>
}

export interface VoterRequestStrand {
	strandId: string
	port: VoterStrandPort
	/** Whether the established network's DbFactory went through the strand path
	 * (`EngineFactory`'s `strandBackedNetworks` marker) rather than the solo/local-DB fallback. */
	peerBacked: boolean
}

export interface VoterRequestTransportSource {
	/** `undefined` when `!peerBacked`. Re-reads the policy on every call; the sealer re-resolves
	 * recipients on every seal (D-04/D-32). */
	resolve(authorityId: string): Promise<VoterRequestTransports | undefined>
}

/** Deep RELATIVE dist-path require for the REST bridge option (D-29) — mirrors the established
 * idiom in `attach-sync-bindings.ts`/the pre-rewrite `attach-voter-request-transport.ts`: a bare
 * `@votetorrent/vote-engine` specifier is blocked from reaching a deep subpath by the package's own
 * `exports` map under `unstable_enablePackageExports`, while a relative import bypasses that map
 * entirely (it governs bare-specifier resolution only). NOT `__DEV__`-gated — D-29 ships the REST
 * bridge in a release build too. */
function loadRestRegistrationTransport(): new (options: { baseUrl: string }) => VoterRegistrationRequestTransport {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return require('../../../../packages/vote-engine/dist/registration/transport/rest-registration-transport.js')
		.RestRegistrationTransport
}

export function createVoterRequestTransportSource(strand: VoterRequestStrand): VoterRequestTransportSource {
	return {
		async resolve(authorityId: string): Promise<VoterRequestTransports | undefined> {
			if (!strand.peerBacked) return undefined

			// VoterStrandPort structurally satisfies both RegistrationStrandPort and
			// AssociationStrandPort (query/mutate/close) — no cast needed.
			const reads = intakeQueryPortFromStrandPort(strand.port)
			const sealer = createIntakeSealer({ port: reads, authorityId })
			const openStrand = async (): Promise<VoterStrandPort> => strand.port

			const associationTransport = new P2pAssociationTransport({
				openStrand,
				computeDigest: createAssociationRequestDigestFn(strand.port),
				computeAttestationDigest: createAssociationAttestationDigestFn(strand.port),
				strandId: strand.strandId,
				sealer,
			})

			const policy = await readIntakePolicyFrom(reads, authorityId)

			let registrationTransport: VoterRegistrationRequestTransport
			let registrationRoute: VoterRegistrationRoute
			if (policy.restBridgeUrl !== null && isValidRestBridgeUrl(policy.restBridgeUrl)) {
				const RestRegistrationTransport = loadRestRegistrationTransport()
				registrationTransport = new RestRegistrationTransport({ baseUrl: policy.restBridgeUrl })
				registrationRoute = 'rest-bridge'
			} else {
				registrationTransport = new P2pRegistrationTransport({
					openStrand,
					computeDigest: createRegistrationRequestDigestFn(strand.port),
					strandId: strand.strandId,
					sealer,
				})
				registrationRoute = 'peer'
			}

			return {
				registrationTransport,
				associationTransport,
				registrationRoute,
				ownAssociationRequestIds: (requesterKey: string) =>
					listOwnStagedAssociationRequestIds(strand.port, strand.strandId, requesterKey),
				ownStagedRegistrationRequestIds: (requesterKey: string) =>
					listOwnStagedRegistrationRequestIds(strand.port, strand.strandId, requesterKey),
			}
		},
	}
}
