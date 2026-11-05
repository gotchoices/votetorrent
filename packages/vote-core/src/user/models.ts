import type { ImageRef, Signature, Timestamp } from '../common'

export interface DefaultUser {
  name: string
  imageRef?: ImageRef
}

export interface User {
  id: string
  name: string
  imageRef?: ImageRef
  activeKeys: UserKey[]
}

export interface UserKey {
  key: string
  type: UserKeyType
  expiration: Timestamp
}

export enum UserKeyType {
  mobile = 'M',
  yubico = 'Y',
  /**
   * D-03: the curve discriminant for a hardware-backed P-256 (secp256r1) key,
   * consumed by the schema's `SignatureValid` CHECKs (UserKey/AdminSigning/
   * OfficerSignature/Registrant/Association) to select which curve verifies
   * a given signer's signature. Introduced for the Authority app's device
   * Keystore key (Android Keystore cannot hold a secp256k1 key — D-01), but
   * this is NOT a transition state: the Voter app permanently keeps
   * secp256k1 as its own registration/identity signing key by design, so the
   * system is a permanently mixed-curve one, not one converging on P-256.
   */
  p256 = 'P',
}

export interface UserHistory {
  event: UserHistoryEvent
  timestamp: Timestamp
  signature: Signature
}

export type CreateUserHistory = UserHistory &
UserInit & {
  event: UserHistoryEvent.create
}

export type RevokeUserKeyHistory = UserHistory & {
  event: UserHistoryEvent.revokeKey
  key: string
}

export type AddUserKeyHistory = UserHistory & {
  event: UserHistoryEvent.addKey
  userKey: UserKey
}

export type ReviseUserHistory = UserHistory & {
  event: UserHistoryEvent.revise
  info: UserInfo
}

export interface UserInfo {
  name: string
  imageRef: ImageRef
}

export type UserInit = UserInfo & {
  userKey: UserKey
}

export enum UserHistoryEvent {
  create = 'C',
  revise = 'R',
  addKey = 'AK',
  revokeKey = 'RK',
}

export interface DeviceAdvertisement {
  multiAddress: string
  token: string
}
