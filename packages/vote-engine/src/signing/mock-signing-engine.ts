import { type ISigningEngine, type Scope, type Signature, type SigningResult } from '@votetorrent/vote-core'

export class MockSigningEngine implements ISigningEngine {
  constructor () {}
  async sign (nonce: string, signature: Signature): Promise<boolean> {
    throw new Error('Method not implemented.')
  }

  async startSigningSession (authorityId: string, digest: string, scope: Scope, signature: Signature): Promise<SigningResult> {
    throw new Error('Method not implemented.')
  }
}
