// src/crypto/envelope-types.ts — the envelope types that type-only consumers
// need, with NO imports. `envelope.ts` re-exports them unchanged, so the
// crypto barrel's public surface is identical. Keeping this file import-free
// keeps `src/types.ts` (on the `./browser` graph) clear of @noble specifiers;
// see test/browser-entry-purity.spec.ts BROWSER-PURITY-a/-b.

export interface EnvelopeRecipient {
  readonly userId: string
  readonly publicKey: string
}

export interface EnvelopeBinding {
  readonly requestId: string
  readonly digest: string
}

export type EnvelopeOpenFailureReason =
  | 'invalid-argument'
  | 'malformed-envelope'
  | 'unsupported-version'
  | 'not-a-recipient'
  | 'authentication-failed'
