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

export interface IUserEngine {
  addKey(key: UserKey): Promise<void>
  connectDevice(): Promise<DeviceAdvertisement>
  create(user: CreateUserHistory): Promise<void>
  getHistory(userId: string, forward: boolean): AsyncIterable<UserHistory>
  getSummary(): Promise<User | undefined>
  isPrivileged(scope: Scope, userId: string): Promise<boolean>
  revise(user: ReviseUserHistory): Promise<void>
  revokeKey(key: string): Promise<void>
}

export interface IDefaultUserEngine {
  get(): Promise<DefaultUser | undefined>
  set(user: DefaultUser): Promise<void>
}
