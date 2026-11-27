// Secret scan over a run dir (port of the lean rig's scanSecrets): counts only, never a matched value or
// a path. Symbolic links are never followed and never counted, so a planted link cannot pull an outside
// file into the scan.

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretRegistry } from './redact.js'

const WINDOW = 16

export interface SecretScan {
  /** Files holding a whole registered secret (summed per file and per secret); -1 when the walk failed. */
  whole: number
  /** Files holding a 16-char window of a windowed secret but not the whole value. */
  windows: number
  /** Regular files read. */
  files: number
}

export function scanSecrets(root: string, registry: SecretRegistry): SecretScan {
  let whole = 0
  let windows = 0
  let files = 0
  const entries = [...registry.entries()]
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!st.isFile()) continue
      files++
      const text = readFileSync(p, 'utf8')
      for (const [s, windowed] of entries) {
        if (text.includes(s)) {
          whole++
          continue
        }
        if (!windowed || s.length < WINDOW) continue
        for (let i = 0; i + WINDOW <= s.length; i++) {
          if (text.includes(s.slice(i, i + WINDOW))) {
            windows++
            break
          }
        }
      }
    }
  }
  try {
    walk(root)
  } catch {
    whole = -1
  }
  return { whole, windows, files }
}
