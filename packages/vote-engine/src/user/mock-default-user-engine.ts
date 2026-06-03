import { MOCK_DEFAULT_USER } from '../mock-data.js'
import type { DefaultUser, IDefaultUserEngine, IDefaultUserSetBuilder } from '@votetorrent/vote-core'
import { DefaultUserSetBuilder } from './builders/index.js'

export class MockDefaultUserEngine implements IDefaultUserEngine {
  private mockDefaultUser: DefaultUser = MOCK_DEFAULT_USER

  async get (): Promise<DefaultUser | undefined> {
    return this.mockDefaultUser
  }

  async set (user: DefaultUser): Promise<void> {
    this.mockDefaultUser = user
  }

  buildSet (): IDefaultUserSetBuilder {
    return new DefaultUserSetBuilder(this)
  }
}
