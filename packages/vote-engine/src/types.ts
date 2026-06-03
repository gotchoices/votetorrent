import type { Database } from '@quereus/quereus'
import type { User } from '@votetorrent/vote-core'

export interface EngineContext {
  db: Database
  user?: User
}
