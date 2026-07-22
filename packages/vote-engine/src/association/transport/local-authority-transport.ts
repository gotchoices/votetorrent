import type { AssociateInit, AttestationChallenge, IAssociationEngine, Signature } from '@votetorrent/vote-core'
import type { IAuthorityTransport } from './authority-transport.js'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * LocalAuthorityTransport — the in-process implementation of
 * `IAuthorityTransport` (D-11, D-03: the authority peer runs the verifier
 * + engine in-process, NOT as a dedicated backend service). Delegates
 * `submitAssociate` 1:1 to the injected `IAssociationEngine.associate`,
 * proving the full challenge -> produce -> associate round-trip on Node
 * with zero live P2P dependency.
 *
 * `sendChallenge` is a documented no-op: the challenge was already issued
 * in-process by the same engine this transport wraps, so there is nothing
 * to send across a wire. A real P2P transport implementing the same
 * interface will actually deliver the challenge to the producing device.
 */
export class LocalAuthorityTransport implements IAuthorityTransport {
  constructor (private readonly engine: IAssociationEngine) {}

  async sendChallenge (_challenge: AttestationChallenge): Promise<void> {
    // No-op (D-03 in-process placement): the challenge already lives
    // in-process, issued directly by `this.engine.issueAttestationChallenge`.
    // A real P2P transport delivers it to the producing device here.
  }

  async submitAssociate (init: AssociateInit, signatureOrCallback: SignatureOrCallback): Promise<void> {
    await this.engine.associate(init, signatureOrCallback)
  }
}
