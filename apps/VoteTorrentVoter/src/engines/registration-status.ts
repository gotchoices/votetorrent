/**
 * registration-status.ts — binding over the shared registration-status read
 * (`packages/workflows/src/voter/registration-status.ts`, phase 67 plan 30). The path stays so the
 * Timeline panel, the engine factory and their tests keep working; this file supplies the two platform
 * seams: the screen's `resolveVoterRequestTransports` as the default transport lookup and the dev console
 * as the error log. The four-outcome derivation (D-06 via D-23) lives ONLY in the shared file.
 */
import {resolveRegistrationStatus as resolveSharedRegistrationStatus} from '@votetorrent/workflows/voter';
import type {RegistrationStatusDeps as SharedRegistrationStatusDeps, RegistrationStatusResult} from '@votetorrent/workflows/voter';
import {resolveVoterRequestTransports} from '../screens/registration/attach-voter-request-transport';
import type {VoterRequestTransportDeps, VoterRequestTransports} from '../screens/registration/attach-voter-request-transport';

export type {RegistrationStatusKind, RegistrationStatusResult} from '@votetorrent/workflows/voter';

/** The app's deps: the shared ones with the transport lookup optional (it defaults to the screen's resolver). */
export interface RegistrationStatusDeps extends Omit<SharedRegistrationStatusDeps, 'resolveTransports' | 'logError'> {
	/** Defaults to `resolveVoterRequestTransports` — injected so every branch is testable without the real
	 * P2P/strand transport source (D-28/D-32). */
	resolveTransports?: (deps: VoterRequestTransportDeps) => Promise<VoterRequestTransports | undefined>;
}

export function resolveRegistrationStatus(deps: RegistrationStatusDeps): Promise<RegistrationStatusResult> {
	return resolveSharedRegistrationStatus({
		...deps,
		resolveTransports: deps.resolveTransports ?? ((d) => resolveVoterRequestTransports(d)),
		// the dev console, as before: the raw error text never reaches the UI (T-59-09-03)
		logError: (where, err) => console.error(where, err),
	});
}
