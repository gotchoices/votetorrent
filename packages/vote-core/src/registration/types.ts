import type { Signature } from '../common/index.js'
import type { IBuilder } from '../common/builder.js'
import type {
  DisclosedSelective,
  ElectionRegistrant,
  ElectionRegistrationField,
  RegisterInit,
  Registrant,
  RegistrantPrivate,
  RegistrantPublic,
  RegistrantSelective,
  RegistrantStatus
} from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

export interface IRegistrationEngine {
  /** D-02: Register is a builder — multi-field draft + signing + serialization. */
  buildRegister(): IRegistrationRegisterBuilder

  /**
   * Direct register — the Register builder's commit() delegates 1:1 to this
   * method. Drives the multi-row ceremony (Registrant + optional Public/
   * Private/Selective tiers) under one or more 'vrg'-scoped AdminSignatures.
   */
  register(init: RegisterInit, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Core Registrant row read. */
  getRegistrant(registrantId: string): Promise<Registrant | undefined>

  /** Public tier read. */
  getRegistrantPublic(registrantId: string): Promise<RegistrantPublic | undefined>

  /** Private tier read — authority-side only, never disclosed. */
  getRegistrantPrivate(registrantId: string): Promise<RegistrantPrivate | undefined>

  /** Selective tier read — authority-side, full (undisclosed) record. */
  getRegistrantSelective(registrantId: string): Promise<RegistrantSelective | undefined>

  /**
   * D-14: reveal a per-field subset of a registrant's selective-disclosure
   * set, filtered by `ElectionDisclosurePolicy` for `audience` (or the
   * 'everyone' audience). Returns `null` when the registrant has no
   * `RegistrantSelective` row. The returned `{ disclosed, hidden }` subset
   * independently verifies against `root` via the crypto plugin's
   * `setVerify` — withheld leaves never appear as more than opaque digests.
   */
  getDisclosedSelective(electionId: string, registrantId: string, audience: string): Promise<DisclosedSelective | null>

  /**
   * D-16: change Status ('a' | 's' | 'r'). Status transitions stay permissive —
   * any 'vrg'-admin-signed change is allowed; the AdminSignature is the control.
   */
  changeStatus(registrantId: string, status: RegistrantStatus, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-16: renewal — change Expiration under a fresh 'vrg'-signed mutation. */
  changeExpiration(registrantId: string, expiration: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster enrollment ('vrg'-signed insert). */
  enrollElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** D-17: authority-only roster removal ('vrg'-signed delete). */
  removeElectionRegistrant(electionId: string, registrantId: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  /** Roster read for an election. */
  getElectionRegistrants(electionId: string): Promise<ElectionRegistrant[]>

  /** D-08/D-09/D-10: per-election field policy CRUD ('mel'-signed, election-scoped). */
  addElectionRegistrationField(field: ElectionRegistrationField, signatureOrCallback: SignatureOrCallback): Promise<void>

  removeElectionRegistrationField(electionId: string, fieldName: string, signatureOrCallback: SignatureOrCallback): Promise<void>

  getElectionRegistrationFields(electionId: string): Promise<ElectionRegistrationField[]>
}

export interface IRegistrationRegisterBuilder extends IBuilder<RegisterInit, void> {
  fromPayload(payload: RegisterInit): this
}
