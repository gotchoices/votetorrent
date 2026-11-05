import type { AssociateInit, AttestationChallenge, IAssociationEngine, Signature } from '@votetorrent/vote-core'
import type { IAuthorityTransport } from './authority-transport.js'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * SUPERSEDED (D-04) for the register/associate flow, effective Phase 51.
 *
 * `IAssociationRequestTransport` (`association-request-transport.ts`) is
 * now the seam for that flow. This class's `sendChallenge` is a documented
 * no-op below, and it is wired into no app (verified by grep — zero
 * `LocalAuthorityTransport`/`IAuthorityTransport` references anywhere under
 * `apps/`, recorded in `51-04-SUMMARY.md`). It is retained ONLY as a
 * Node-side test fixture and as the historical record of the in-process
 * framing this doc comment states below. It MUST NOT be constructed by any
 * app code, and it is NOT one of D-08's two real bindings.
 *
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
