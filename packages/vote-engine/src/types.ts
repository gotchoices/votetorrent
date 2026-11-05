import type { Database } from '@quereus/quereus'
import type { User } from '@votetorrent/vote-core'
import type { IntakeOpener } from './intake/types.js'

export interface EngineContext {
  db: Database
  user?: User
  /**
   * D-49: the signed-in officer's opener for sealed registration content (62-14 `IntakeOpener`).
   * Set by the HOST on the established ctx (Authority engine factory, 62-27) when the device holds
   * an officer intake key. Never set on the Voter. Never persisted, serialized or logged. Absent
   * means every sealed `RegistrationRequest.Payload`/`RegistrantPrivate.PrivateDetails` read
   * degrades to `'no-opener'` (`sealed-registration-content.ts`).
   */
  intakeOpener?: IntakeOpener
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
