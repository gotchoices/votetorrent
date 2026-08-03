import type { Signature } from '../common/index.js'
import type { AuthorityPeer, PollingDevice } from './models.js'

/**
 * D-01/D-19: every mutating method's signing parameter is a `Signature` OR a
 * callback that receives the canonical digest bytes and returns one — NEVER
 * a raw private key. The engine never holds the key (D-01).
 */
type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * AuthorityId-keyed direct-CRUD engine for network-peer + in-person device
 * configuration (D-01). AuthorityPeer mutations are 'cap'-scoped (Configure
 * Authority Peers); PollingDevice mutations are 'vrg'-scoped (device
 * uniqueness waiver is a registration-validation concern).
 */
export interface IAuthorityConfigEngine {
  addAuthorityPeer(authorityId: string, peerId: string, signatureOrCallback: SignatureOrCallback): Promise<void>
  removeAuthorityPeer(authorityId: string, peerId: string, signatureOrCallback: SignatureOrCallback): Promise<void>
  getAuthorityPeers(authorityId: string): Promise<AuthorityPeer[]>

  addPollingDevice(
    authorityId: string,
    deviceHash: string,
    label: string | undefined,
    signatureOrCallback: SignatureOrCallback
  ): Promise<void>
  removePollingDevice(authorityId: string, deviceHash: string, signatureOrCallback: SignatureOrCallback): Promise<void>
  getPollingDevices(authorityId: string): Promise<PollingDevice[]>
}
