// relay.env: the one file every vt daemon takes as `--relay <relay.env>`. Same format as the lean
// rig (`RELAY_MULTIADDR=<addr>` on its own line), so an existing VT_LEAN_RELAY_ENV file still works.
//
// A private relay address (loopback or LAN) and its peer id are secrets under the rig's
// relayIsPrivate rule, so no error here ever carries file content or the address: the message names
// the code only. A group- or other-writable file is refused outright, because whoever can write it
// can point every daemon at another relay.

import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export type RelayEnvCode = 'missing' | 'mode' | 'no-multiaddr' | 'shape'

export class RelayEnvError extends Error {
  readonly code: RelayEnvCode

  constructor (code: RelayEnvCode) {
    super(`relay.env ${code}`)
    this.name = 'RelayEnvError'
    this.code = code
  }
}

const LINE = /^RELAY_MULTIADDR=(\S+)$/

/** The relay's own `multiaddr-shape` rule: leading `/`, a `/p2p/` segment, at most 256 chars, no whitespace. */
function hasMultiaddrShape (value: string): boolean {
  return value.startsWith('/') && value.includes('/p2p/') && value.length <= 256 && !/\s/.test(value)
}

export function readRelayEnv (path: string): { multiaddr: string } {
  let mode: number
  let text: string
  try {
    mode = statSync(path).mode
    text = readFileSync(path, 'utf8')
  } catch {
    throw new RelayEnvError('missing')
  }
  if ((mode & 0o022) !== 0) throw new RelayEnvError('mode')
  let multiaddr: string | undefined
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (m?.[1] !== undefined) {
      multiaddr = m[1]
      break
    }
  }
  if (multiaddr === undefined) throw new RelayEnvError('no-multiaddr')
  if (!hasMultiaddrShape(multiaddr)) throw new RelayEnvError('shape')
  return { multiaddr }
}

/** Write `RELAY_MULTIADDR=<addr>` as a 0600 file, via a per-process temp file and rename. */
export function writeRelayEnv (path: string, multiaddr: string): void {
  if (!hasMultiaddrShape(multiaddr)) throw new RelayEnvError('shape')
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `RELAY_MULTIADDR=${multiaddr}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
