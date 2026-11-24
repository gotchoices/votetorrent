/**
 * vote-record-wrap.ts: the vote-record wrap seam (D-13, D-29), moved here from
 * `apps/VoteTorrentVoter/src/engines/vote-record-wrap.ts`, which now re-exports it.
 *
 * `wrap` seals a plaintext under an AAD with a per-call prompt and returns the wrapped shape only.
 * `unwrap` returns the plaintext to its caller and to nobody else: an implementation never logs,
 * caches or persists plaintext, and the interface has no debug or inspect member. The saved-choices
 * reader is the consumer.
 */

import type { SecretWrapPrompt, WrappedSecret } from './secret-wrap.js'

export interface VoteRecordWrapProvider {
  wrap(plaintext: Uint8Array, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<WrappedSecret>
  unwrap(wrapped: WrappedSecret, aad: Uint8Array, prompt: SecretWrapPrompt): Promise<Uint8Array>
}
