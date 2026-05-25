import type { Scope } from '../authority'
import type { Signature } from '../common'
import type { SigningResult } from './models'
import type { IBuilder } from '../common/builder.js'

export interface ISigningEngine {
  sign(nonce: string, signature: Signature): Promise<boolean> // true if the threshold has been reached and an AdminSignature has been created
  startSigningSession(
    authorityId: string,
    digest: string,
    scope: Scope,
    signature: Signature
  ): Promise<SigningResult>
  buildSign(): ISigningSignBuilder
  buildStartSigningSession(): ISigningStartSigningSessionBuilder
}

export interface ISigningSignBuilder extends IBuilder<{ nonce: string; signature: Signature }, boolean> {
  fromPayload(payload: { nonce: string; signature: Signature }): this
}

export interface ISigningStartSigningSessionBuilder extends IBuilder<{ authorityId: string; digest: string; scope: Scope; signature: Signature }, SigningResult> {
  fromPayload(payload: { authorityId: string; digest: string; scope: Scope; signature: Signature }): this
}
