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
