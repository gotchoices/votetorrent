/**
 * voter-request-transports.ts — binding over the shared request-transport source
 * (`packages/workflows/src/voter/voter-request-transports.ts`, phase 67 plan 30). The path stays so the
 * engine factory, the registration screens and their tests keep working; this file supplies the one
 * platform seam, the REST registration transport loaded from the bundled vote-engine dist (D-29). The
 * route selection and the D-32 sealing live ONLY in the shared file.
 */
import { createVoterRequestTransportSource as createSharedVoterRequestTransportSource } from '@votetorrent/workflows/voter'
import type { VoterRegistrationRequestTransport, VoterRequestStrand, VoterRequestTransportSource } from '@votetorrent/workflows/voter'

export { VOTER_REQUEST_TRANSPORTS_ENGINE } from '@votetorrent/workflows/voter'
export type {
	VoterRegistrationRoute,
	VoterRegistrationRequestTransport,
	VoterAssociationRequestTransport,
	VoterRequestTransports,
	VoterRequestStrand,
	VoterRequestTransportSource,
} from '@votetorrent/workflows/voter'

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

/** The app's source over the shared one: the REST loader stays lazy, called only on the REST branch. */
export function createVoterRequestTransportSource(strand: VoterRequestStrand): VoterRequestTransportSource {
	return createSharedVoterRequestTransportSource(strand, {
		createRestRegistrationTransport: (options) => new (loadRestRegistrationTransport())(options),
	})
}
