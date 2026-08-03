import type { Database } from '@quereus/quereus'
import type { User } from '@votetorrent/vote-core'

export interface EngineContext {
  db: Database
  user?: User
}

/**
 * Factory function injected into NetworksEngine that produces a Quereus Database
 * for a given network hash. The hash allows persistent backends to name the store
 * correctly (e.g. `votetorrent-<hash>`).
 *
 * Phase 14 D-01/D-02/D-03: vote-engine itself only knows this type; the concrete
 * RN factory lives in the app layer (Plan 02). The default in-memory factory
 * (`async (_hash) => new Database()`) keeps all existing tests passing unchanged.
 */
export type DbFactory = (networkHash: string) => Promise<Database>
