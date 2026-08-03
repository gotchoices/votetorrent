/**
 * Phase 08 -- BUILD-ELEC-02 / FACT-02..04 / VALID-01..03 / SER-01,02,04.
 * Concrete ElectionInviteKeyholderBuilder implementing
 * IElectionInviteKeyholderBuilder as an additive layer over
 * ElectionEngine.inviteKeyholder.
 *
 * second-keyholder-invite-unique fix: `signatureOrCallback` was added
 * alongside `keyholder`/`electionId` when `inviteKeyholder` was rewired to
 * mirror AuthorityEngine.saveInviteWithSigning's signing ceremony. The
 * validator/setter/draft shape below mirrors
 * `AuthoritySaveInviteWithSigningBuilder`'s `signature` field exactly.
 */

import type {
  BuilderError,
  IElectionEngine,
  IElectionInviteKeyholderBuilder,
  KeyholderInvite,
  MissingField,
  SerializedBuilder,
  Signature
} from '@votetorrent/vote-core'
import {
  BuilderAlreadyCommittedError,
  BuilderValidationError
} from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

interface Draft {
  keyholder?: KeyholderInvite
  electionId?: string
  signatureOrCallback?: SignatureOrCallback
}

type EngineInput = { keyholder: KeyholderInvite; electionId: string; signatureOrCallback: SignatureOrCallback }

type FrozenDraft = Readonly<Draft>
type DraftValidator = (draft: FrozenDraft) => BuilderError[]

export class ElectionInviteKeyholderBuilder implements IElectionInviteKeyholderBuilder {
  static readonly KIND = 'election.inviteKeyholder'
  static readonly KIND_VERSION = 1

  private committed = false

  private static readonly VALIDATORS: readonly DraftValidator[] = [
    ElectionInviteKeyholderBuilder.validateKeyholder,
    ElectionInviteKeyholderBuilder.validateElectionId,
    ElectionInviteKeyholderBuilder.validateSignatureOrCallback
  ]

  constructor (
    private readonly engine: IElectionEngine,
    private readonly draft: FrozenDraft = {}
  ) {}

  // ---- per-setter validators ----

  private static validateKeyholder (draft: FrozenDraft): BuilderError[] {
    if (draft.keyholder === undefined) return []
    const errors: BuilderError[] = []
    if (typeof draft.keyholder.name !== 'string' || draft.keyholder.name.trim() === '') {
      errors.push({ path: 'keyholder.name', code: 'EMPTY', message: 'keyholder.name required', kind: 'per-setter' })
    }
    if (typeof draft.keyholder.inviteKey !== 'string' || draft.keyholder.inviteKey.trim() === '') {
      errors.push({ path: 'keyholder.inviteKey', code: 'EMPTY', message: 'keyholder.inviteKey required', kind: 'per-setter' })
    }
    return errors
  }

  private static validateElectionId (draft: FrozenDraft): BuilderError[] {
    if (draft.electionId === undefined) return []
    if (typeof draft.electionId !== 'string' || draft.electionId.trim() === '') {
      return [{ path: 'electionId', code: 'EMPTY', message: 'electionId required', kind: 'per-setter' }]
    }
    return []
  }

  private static validateSignatureOrCallback (draft: FrozenDraft): BuilderError[] {
    if (draft.signatureOrCallback === undefined || draft.signatureOrCallback === null) return []
    // signatureOrCallback may be a completed Signature object OR a per-digest
    // sign callback (device-signer pattern) — mirrors
    // AuthoritySaveInviteWithSigningBuilder.validateSignature.
    if (typeof draft.signatureOrCallback === 'function') return []
    const sig = draft.signatureOrCallback
    if (
      typeof sig !== 'object' ||
      Array.isArray(sig) ||
      typeof sig.signature !== 'string' || sig.signature.trim() === '' ||
      typeof sig.signerKey !== 'string' || sig.signerKey.trim() === '' ||
      typeof sig.signerUserId !== 'string' || sig.signerUserId.trim() === ''
    ) {
      return [{
        path: 'signatureOrCallback',
        code: 'INVALID',
        message: 'signatureOrCallback must be a function or a Signature with non-empty signature, signerKey, and signerUserId',
        kind: 'per-setter'
      }]
    }
    return []
  }

  private runValidators (): readonly BuilderError[] {
    const errors: BuilderError[] = []
    for (const validator of ElectionInviteKeyholderBuilder.VALIDATORS) {
      errors.push(...validator(this.draft))
    }
    return Object.freeze(errors)
  }

  // ---- setters ----

  setKeyholder (keyholder: KeyholderInvite): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, keyholder }) as this
  }

  setElectionId (electionId: string): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, electionId }) as this
  }

  setSignatureOrCallback (signatureOrCallback: SignatureOrCallback): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, signatureOrCallback }) as this
  }

  // ---- IBuilder<{ keyholder; electionId; signatureOrCallback }, void> surface ----

  build (): EngineInput {
    return this.toEngineInput()
  }

  toEngineInput (): EngineInput {
    const errors = this.runValidators()
    const missing = this.missingFields()
    if (errors.length > 0 || missing.length > 0) {
      const allErrors: BuilderError[] = [...errors]
      for (const m of missing) {
        allErrors.push({ path: m.path, code: 'MISSING', message: m.reason, kind: 'per-setter' })
      }
      throw new BuilderValidationError(allErrors)
    }
    return {
      keyholder: this.draft.keyholder!,
      electionId: this.draft.electionId!,
      signatureOrCallback: this.draft.signatureOrCallback!
    }
  }

  commit (): Promise<void> {
    if (this.committed) {
      throw new BuilderAlreadyCommittedError(ElectionInviteKeyholderBuilder.KIND)
    }
    const input = this.toEngineInput()
    this.committed = true
    return this.engine.inviteKeyholder(input.keyholder, input.electionId, input.signatureOrCallback)
  }

  isValid (): boolean {
    const errors = this.runValidators()
    const missing = this.missingFields()
    return errors.length === 0 && missing.length === 0
  }

  errors (): readonly BuilderError[] {
    const validatorErrors = this.runValidators()
    const missing = this.missingFields()
    if (missing.length === 0) return validatorErrors
    const all: BuilderError[] = [...validatorErrors]
    for (const m of missing) {
      all.push({ path: m.path, code: 'MISSING', message: m.reason, kind: 'per-setter' })
    }
    return Object.freeze(all)
  }

  missingFields (): readonly MissingField[] {
    const missing: MissingField[] = []
    if (this.draft.keyholder === undefined) missing.push({ path: 'keyholder', reason: 'required' })
    if (this.draft.electionId === undefined) missing.push({ path: 'electionId', reason: 'required' })
    if (this.draft.signatureOrCallback === undefined) missing.push({ path: 'signatureOrCallback', reason: 'required' })
    return Object.freeze(missing)
  }

  update (partial: Partial<EngineInput>): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft, ...partial }) as this
  }

  reset (): this {
    return new ElectionInviteKeyholderBuilder(this.engine) as this
  }

  clone (): this {
    return new ElectionInviteKeyholderBuilder(this.engine, { ...this.draft }) as this
  }

  toJSON (): SerializedBuilder<Draft> {
    return {
      kind: ElectionInviteKeyholderBuilder.KIND,
      version: ElectionInviteKeyholderBuilder.KIND_VERSION,
      draft: { ...this.draft }
    }
  }

  dispose (): void {}

  fromPayload (payload: EngineInput): this {
    return new ElectionInviteKeyholderBuilder(this.engine, {
      keyholder: payload.keyholder,
      electionId: payload.electionId,
      signatureOrCallback: payload.signatureOrCallback
    }) as this
  }

  static fromJSON (json: SerializedBuilder<unknown>, engine: IElectionEngine): ElectionInviteKeyholderBuilder {
    if (json.kind !== ElectionInviteKeyholderBuilder.KIND) {
      throw new Error(
        `ElectionInviteKeyholderBuilder.fromJSON: unknown kind "${json.kind}" (expected "${ElectionInviteKeyholderBuilder.KIND}")`
      )
    }
    if (json.version !== ElectionInviteKeyholderBuilder.KIND_VERSION) {
      throw new Error(
        `ElectionInviteKeyholderBuilder.fromJSON: unsupported version ${json.version} (expected ${ElectionInviteKeyholderBuilder.KIND_VERSION})`
      )
    }
    const draft = json.draft
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new Error('ElectionInviteKeyholderBuilder.fromJSON: draft must be a plain object')
    }
    return new ElectionInviteKeyholderBuilder(engine, draft as Draft)
  }
}
