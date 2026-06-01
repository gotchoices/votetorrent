import type { AdminDigestArgs, ISigningEngine, ISigningSignBuilder, ISigningStartSigningSessionBuilder, Scope, Signature, SigningResult } from '@votetorrent/vote-core'
import { SigningSignBuilder } from './builders/signing-sign-builder.js'
import { SigningStartSigningSessionBuilder } from './builders/signing-start-signing-session-builder.js'

export class MockSigningEngine implements ISigningEngine {
  private nonceCounter = 0

  constructor () {}

  generateSigningNonce (): string {
    return `mock-nonce-${++this.nonceCounter}`
  }

  async sign (_nonce: string, _signature: Signature): Promise<boolean> {
    return true
  }

  async startSigningSession (
    _authorityId: string,
    _digestArgs: AdminDigestArgs | null,
    _scope: Scope,
    _signature: Signature,
    _nonce?: string
  ): Promise<SigningResult> {
    const usedNonce = _nonce !== undefined ? _nonce : `mock-nonce-${++this.nonceCounter}`
    return { nonce: usedNonce, thresholdReached: true }
  }

  buildSign (): ISigningSignBuilder {
    return new SigningSignBuilder(this)
  }

  buildStartSigningSession (): ISigningStartSigningSessionBuilder {
    return new SigningStartSigningSessionBuilder(this)
  }
}
