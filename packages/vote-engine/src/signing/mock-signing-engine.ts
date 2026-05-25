import { type ISigningEngine, type ISigningSignBuilder, type ISigningStartSigningSessionBuilder, type Scope, type Signature, type SigningResult } from '@votetorrent/vote-core'
import { SigningSignBuilder } from './builders/signing-sign-builder.js'
import { SigningStartSigningSessionBuilder } from './builders/signing-start-signing-session-builder.js'

export class MockSigningEngine implements ISigningEngine {
  constructor () {}
  async sign (nonce: string, signature: Signature): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async startSigningSession (authorityId: string, digest: string, scope: Scope, signature: Signature): Promise<SigningResult> {
    throw new Error('Method not implemented.')
  }

  buildSign (): ISigningSignBuilder {
    return new SigningSignBuilder(this)
  }

  buildStartSigningSession (): ISigningStartSigningSessionBuilder {
    return new SigningStartSigningSessionBuilder(this)
  }
}
