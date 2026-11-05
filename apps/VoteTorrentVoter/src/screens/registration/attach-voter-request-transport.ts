import type {
	VoterAssociationRequestTransport,
	VoterRegistrationRequestTransport,
	VoterRegistrationRoute,
	VoterRequestTransports,
	VoterRequestTransportSource,
} from '../../engines/voter-request-transports';
import {VOTER_REQUEST_TRANSPORTS_ENGINE} from '../../engines/voter-request-transports';

/**
 * attach-voter-request-transport.ts — Phase 62 Plan 22 (D-28/D-29/D-32).
 *
 * The production request-delivery entry point: the thin, async consumer-facing resolver both
 * `ConfirmationScreen.tsx` and `engines/registration-status.ts` call.
 *
 *   - P2P is the default registration route, and association is ALWAYS P2P (D-28) — the Voter
 *     is a P2P peer, and its established network's own strand database carries every staged
 *     request.
 *   - The authority-configured REST bridge is a working production option for registration
 *     (D-29), read from the replicated, signed `AuthorityIntakePolicy`. No `__DEV__` gate, no
 *     hardcoded base URL and no dev constant exist anywhere in this module or
 *     `voter-request-transports.ts` — the release Android bundle carries both routes.
 *   - The joined network is the delivery target (D-32): `strandId` is the established network's
 *     own `networkHash`, and every staged payload is sealed to the current officers resolved
 *     from replicated rows.
 *   - `undefined` means this device cannot deliver anything right now (no network established,
 *     or the network is not strand-backed — a dev local-DB escape hatch, or a CadreNode that
 *     has not yet booted). The caller shows the existing "cannot reach the authority" failure UX
 *     — this is never a crash.
 *
 * Label: code-complete, unverified on devices (P2P-11 proof debt, tracked by 62-30).
 */

export type {
	VoterAssociationRequestTransport,
	VoterRegistrationRequestTransport,
	VoterRegistrationRoute,
	VoterRequestTransports,
};

export interface VoterRequestTransportDeps {
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>;
	authorityId: string;
}

export async function resolveVoterRequestTransports(
	deps: VoterRequestTransportDeps,
): Promise<VoterRequestTransports | undefined> {
	const source = await deps.getEngine<VoterRequestTransportSource>(VOTER_REQUEST_TRANSPORTS_ENGINE);
	return source.resolve(deps.authorityId);
}
