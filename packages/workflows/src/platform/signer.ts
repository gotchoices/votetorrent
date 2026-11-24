/**
 * signer.ts: the sign-callback seam.
 *
 * `SignCallback` takes canonical digest bytes and resolves a vote-core `Signature`, i.e.
 * `{ signature, signerKey, signerUserId }`. An implementation never returns or exposes key material:
 * the private key stays closed over on the implementing side (a hardware key, the app's device user
 * key, or the CLI's signer) and never crosses into a workflow. A workflow may call it many times, and
 * engines call it lazily, so an implementation must be safe to invoke repeatedly.
 *
 * This is the same shape as both apps' device-signer `SignCallback` (the D-09 frozen shape in
 * `apps/VoteTorrentAuthority/src/engines/device-signer.ts` and
 * `apps/VoteTorrentVoter/src/engines/device-signer.ts`); the apps' parity tests pin the equality.
 */

import type { Signature } from '@votetorrent/vote-core'

export type { Signature } from '@votetorrent/vote-core'

export type SignCallback = (digest: Uint8Array) => Promise<Signature>
