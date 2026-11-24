// platform-types.spec.ts: compile-time pins on the ./platform seams (phase 67 plan 03). The assertions
// below are checked by `tsc --noEmit -p tsconfig.test.json`; ts-node runs transpileOnly and skips them,
// so the one runtime `it` only makes mocha report the file.
import { expect } from 'chai'
import type { AttestationChallenge, DeviceAttestation } from '@votetorrent/vote-core'
import type {
  AttestationProducer,
  KeyVaultStorage,
  KvStorage,
  SignCallback,
  Signature,
  VoteSigningProducer,
  WrapKeySecurityLevel,
} from '../src/platform/index.js'

/** Strict identity: true only when A and B are the same type (not merely mutually assignable). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assignable<A, B> = [A] extends [B] ? true : false

type MinimalProducer = {
  provisionDeviceKey(): Promise<{ publicKey: string }>
  getCurrentDeviceKey(): Promise<{ publicKey: string }>
  produce(challenge: AttestationChallenge): Promise<DeviceAttestation>
}

const keyVaultStorageIsKvStorage: Equal<KeyVaultStorage, KvStorage> = true
const voteSigningProducerIsAProducer: Assignable<VoteSigningProducer, AttestationProducer> = true
const minimalProducerIsAProducer: Assignable<MinimalProducer, AttestationProducer> = true
const signCallbackShape: Equal<SignCallback, (digest: Uint8Array) => Promise<Signature>> = true
const securityLevels: Equal<WrapKeySecurityLevel, 'strongbox' | 'tee' | 'software' | 'keychain' | 'unknown' | 'test-stub'> = true

describe('@votetorrent/workflows/platform types', () => {
  it('the compile-time pins hold (checked by tsc -p tsconfig.test.json)', () => {
    expect([
      keyVaultStorageIsKvStorage,
      voteSigningProducerIsAProducer,
      minimalProducerIsAProducer,
      signCallbackShape,
      securityLevels,
    ]).to.deep.equal([true, true, true, true, true])
  })
})
