import type {
  User,
  DefaultUser,
  CreateUserHistory,
  ReviseUserHistory,
  UserKey,
  UserHistory,
  DeviceAdvertisement
} from './models'
import type { Scope } from '../authority/models'
import type { IBuilder } from '../common/builder.js'
import type { Signature } from '../common/signature.js'

export interface IUserEngine {
  addKey(key: UserKey, sign?: (digest: Uint8Array) => Promise<Signature>): Promise<void>
  connectDevice(): Promise<DeviceAdvertisement>
  create(user: CreateUserHistory, options?: { inviteSlotCid?: string; inviteSignature?: string }): Promise<void>
  getHistory(userId: string, forward: boolean): AsyncIterable<UserHistory>
  getSummary(): Promise<User | undefined>
  isPrivileged(scope: Scope, userId: string): Promise<boolean>
  revise(user: ReviseUserHistory): Promise<void>
  revokeKey(key: string, signature: Signature): Promise<void>
  /**
   * D-20 (49-05) — the canonical `revokeKey` pre-image (`Digest(UserId,
   * PubKey)`), computed engine-side so the caller signs exactly these bytes
   * and never recomputes a canonical digest form itself (D-03).
   */
  getRevokeKeyDigest(key: string): Promise<Uint8Array>
  buildCreate(): IUserCreateBuilder
  buildAddKey(): IUserAddKeyBuilder
  buildRevise(): IUserReviseBuilder
  buildRevokeKey(): IUserRevokeKeyBuilder
}

export interface IDefaultUserEngine {
  get(): Promise<DefaultUser | undefined>
  set(user: DefaultUser): Promise<void>
  buildSet(): IDefaultUserSetBuilder
}

export interface IUserCreateBuilder extends IBuilder<CreateUserHistory, void> {
  fromPayload(payload: CreateUserHistory): this
}

export interface IUserAddKeyBuilder extends IBuilder<UserKey, void> {
  fromPayload(payload: UserKey): this
}

export interface IUserReviseBuilder extends IBuilder<ReviseUserHistory, void> {
  fromPayload(payload: ReviseUserHistory): this
}

export interface IUserRevokeKeyBuilder extends IBuilder<string, void> {
  fromPayload(payload: string): this
}

export interface IDefaultUserSetBuilder extends IBuilder<DefaultUser, void> {
  fromPayload(payload: DefaultUser): this
}
