import type { DefaultUser, IDefaultUserEngine, LocalStorage } from '@votetorrent/vote-core'

/**
 * USER-08 — DefaultUserEngine backed by {@link LocalStorage}.
 *
 * The default user (name + optional imageRef) is the bootstrap identity
 * the app uses before any Network has been opened. Persistence is
 * device-local (LocalStorage / AsyncStorage) — there is no DB row.
 */
export class DefaultUserEngine implements IDefaultUserEngine {
  private static readonly STORAGE_KEY = 'defaultUser'

  constructor (private readonly localStorage: LocalStorage) {}

  async get (): Promise<DefaultUser | undefined> {
    return await this.localStorage.getItem<DefaultUser>(
      DefaultUserEngine.STORAGE_KEY
    )
  }

  async set (user: DefaultUser): Promise<void> {
    await this.localStorage.setItem(DefaultUserEngine.STORAGE_KEY, user)
  }
}
