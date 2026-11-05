// src/intake/query-port.ts — Phase 62 Plan 14 (D-32)
//
// A read-only port both the Authority (a real `Database`) and the Voter (a
// P2P transport's `RegistrationStrandPort`) can satisfy, so `resolveIntakeRecipients`
// and the policy reader run the SAME code whichever side calls them. The
// type-only import of `RegistrationStrandPort` below is the compile-time
// proof that a strand port structurally fits — this module never imports
// anything else from the transports, and never calls `mutate`/`close`.

import type { Database, SqlValue } from '@quereus/quereus'
import type { RegistrationStrandPort } from '../registration/transport/p2p-registration-transport.js'

export interface IntakeQueryPort {
  query<T> (sql: string, params: Record<string, unknown>): Promise<T[]>
}

/** Collects `db.eval(sql, params)` rows into an array. */
export function intakeQueryPortFromDb (db: Database): IntakeQueryPort {
  return {
    async query<T> (sql: string, params: Record<string, unknown>): Promise<T[]> {
      const rows: T[] = []
      for await (const row of db.eval(sql, params as Record<string, SqlValue>)) {
        rows.push(row as T)
      }
      return rows
    }
  }
}

/**
 * Returns an object exposing ONLY `query`, bound to `port` — `mutate`/`close`
 * are unreachable through the result, so a sealer or recipient resolver that
 * only ever sees an `IntakeQueryPort` cannot write to or close the strand.
 */
export function intakeQueryPortFromStrandPort (port: RegistrationStrandPort): IntakeQueryPort {
  return {
    query: (sql: string, params: Record<string, unknown>) => port.query(sql, params)
  }
}
