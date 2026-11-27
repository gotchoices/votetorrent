/**
 * legacy-cursor-schema.ts — a strand schema whose cursor CHECKs are the pre-V-4 `CursorWidth` shape.
 *
 * Rows written before V-4 (staging tables) or before the decision tables gained `CursorWellFormed`,
 * and rows from mixed-version peers, still live on strands (NoDelete, D-07), and the engine must
 * tolerate them. Specs that model such legacy rows (62-44, CR-01) run on this fixture so a later
 * schema tightening cannot invalidate them.
 */

import { setSchemaSql } from '../../src/database/initialize.js'
import { VOTETORRENT_SCHEMA_SQL } from '../../src/database/schema-sql.js'
import { createP2pStagingFixture } from './p2p-staging-fixture.js'
import type { P2pStagingFixture } from './p2p-staging-fixture.js'

const MARKER = 'constraint CursorWellFormed check'
const LEGACY = 'constraint CursorWidth check (length(new.Cursor) = 16)'

/** Index of the `)` matching the `(` at `open`, ignoring parentheses inside '...' literals. */
function matchingParen (sql: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === "'") inString = false
      continue
    }
    if (ch === "'") inString = true
    else if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('legacyCursorSchema: unbalanced parentheses in a CursorWellFormed block')
}

function replaceBlocks (sql: string): { out: string, count: number } {
  let out = ''
  let pos = 0
  let count = 0
  for (;;) {
    const at = sql.indexOf(MARKER, pos)
    if (at < 0) break
    // Skip occurrences inside `--` comment lines.
    const lineStart = sql.lastIndexOf('\n', at) + 1
    if (/^\s*--/.test(sql.slice(lineStart, at))) {
      out += sql.slice(pos, at + MARKER.length)
      pos = at + MARKER.length
      continue
    }
    const open = sql.indexOf('(', at + MARKER.length)
    const close = matchingParen(sql, open)
    out += sql.slice(pos, at) + LEGACY
    pos = close + 1
    count += 1
  }
  out += sql.slice(pos)
  return { out, count }
}

/** Number of `CursorWellFormed` blocks `legacyCursorSchema` replaces in `sql`. */
export function legacyCursorSchemaReplacements (sql: string): number {
  return replaceBlocks(sql).count
}

/** `sql` with every `CursorWellFormed` CHECK replaced by the pre-V-4 `CursorWidth` CHECK. */
export function legacyCursorSchema (sql: string): string {
  const { out, count } = replaceBlocks(sql)
  if (count < 3) throw new Error(`legacyCursorSchema: replaced ${count} blocks, expected at least 3`)
  const leftover = out.split('\n').filter((line) => !/^\s*--/.test(line) && line.includes('constraint CursorWellFormed'))
  if (leftover.length > 0) throw new Error('legacyCursorSchema: a CursorWellFormed constraint survived')
  return out
}

/** A staging fixture on the legacy-cursor schema; the override is always reset. */
export async function createLegacyCursorStagingFixture (): Promise<P2pStagingFixture> {
  setSchemaSql(legacyCursorSchema(VOTETORRENT_SCHEMA_SQL))
  try {
    return await createP2pStagingFixture()
  } finally {
    setSchemaSql(undefined)
  }
}
