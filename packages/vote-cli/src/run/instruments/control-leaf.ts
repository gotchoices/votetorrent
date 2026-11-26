// A port of the phase-64 instrument tools/lean-rig/lib/control-leaf.mjs. The reads below are LOCAL
// ONLY: getBlock never fetches or restores, and the result carries revs and 8-character action
// prefixes, never a block id, a peer id or a full action id.
//
// A control fork is two Authorities holding the SAME CadrePeer revision with DIFFERENT content:
// db-p2p's promise-round digest check then refuses every later write of either side for good. A
// fork precheck is a STOP gate before every run part and after every app restart. This module is the
// instrument, shared by the orchestrator side and the daemon preload.
//
// Access path, in words: the app context's node gives the control libp2p node through
// getControlNode(); its storageRepo creates a block storage per block id. The collection header block
// (collection id default/cadrecontrol/CadrePeer, block type TRE) names the tree root (the leaf) and
// the log tail by rootId and tailId. The leaf and the tail are each read with one getLatest() (rev and
// actionId); the header's own latest rev lags the leaf (it changes only when the tail block changes),
// so the ids come from the header block and are never hard-coded. A transaction-layer action id on a
// Node CadreNode carries a constant tx-colon namespace prefix (the device's ids are 22 base64url
// characters with none); the prefix is dropped before the first 8 characters are taken.

export const CADRE_PEER_COLLECTION = 'default/cadrecontrol/CadrePeer'
export const FORK_SPACING_MS = 5000
export const FORK_CAP_MS = 120000
export const FORK_FAIL_TOKENS: readonly string[] = Object.freeze(['fork-leaf', 'fork-tail', 'unreadable', 'role-missing', 'digest-mismatch-logged'])

const ROLE_RE = /^[a-z0-9-]{1,16}$/
const ACTION8_RE = /^[A-Za-z0-9_-]{8}$/
const KEYS = ['leafRev', 'leafAction8', 'tailRev', 'tailAction8']

export interface ControlLeafRead {
  leafRev: number
  leafAction8: string
  tailRev: number
  tailAction8: string
}

export interface ControlLeafUnreadable {
  unreadable: string
}

export type ControlLeafResult = ControlLeafRead | ControlLeafUnreadable

export type ControlLeafValues = ControlLeafRead

export interface ForkRoundClass {
  verdict: string
  values?: ControlLeafValues
}

// Hermes-safe: `function` and `var` only, no comment anywhere in the text.
export const CONTROL_LEAF_SOURCE = [
  'function (node, A) {',
  '  function bad(t) { return { unreadable: t }; }',
  '  function a8(x) { if (x === undefined || x === null) return null; var s = String(x); if (s.indexOf("tx:") === 0) s = s.slice(3); s = s.slice(0, 8); return /^[A-Za-z0-9_-]{8}$/.test(s) ? s : null; }',
  '  function okRev(v) { return v && typeof v.rev === "number" && Math.floor(v.rev) === v.rev && v.rev >= 0; }',
  '  try {',
  '    var cn = node && typeof node.getControlNode === "function" ? node.getControlNode() : null;',
  '    if (!cn) return Promise.resolve(bad("no-control-node"));',
  '    var repo = cn.storageRepo;',
  '    if (!repo || typeof repo.createBlockStorage !== "function") return Promise.resolve(bad("no-storage-repo"));',
  '    var coll = A && typeof A.collection === "string" && A.collection ? A.collection : ' + JSON.stringify(CADRE_PEER_COLLECTION) + ';',
  '    var h = repo.createBlockStorage(coll);',
  '    return Promise.resolve(h.getLatest()).then(function (hl) {',
  '      if (!hl || typeof hl.rev !== "number") return bad("no-header");',
  '      return Promise.resolve(h.getBlock(hl.rev)).then(function (got) {',
  '        var b = got && got.block;',
  '        if (!b || typeof b.rootId !== "string" || !b.rootId || typeof b.tailId !== "string" || !b.tailId) return bad("header-shape");',
  '        var lb = repo.createBlockStorage(b.rootId);',
  '        var tb = repo.createBlockStorage(b.tailId);',
  '        return Promise.resolve(lb.getLatest()).then(function (leaf) {',
  '          if (!leaf) return bad("no-leaf");',
  '          return Promise.resolve(tb.getLatest()).then(function (tail) {',
  '            if (!tail) return bad("no-tail");',
  '            var la = a8(leaf.actionId);',
  '            var ta = a8(tail.actionId);',
  '            if (!okRev(leaf) || !okRev(tail) || !la || !ta) return bad("shape");',
  '            return { leafRev: leaf.rev, leafAction8: la, tailRev: tail.rev, tailAction8: ta };',
  '          });',
  '        });',
  '      });',
  '    }).then(null, function () { return bad("read-threw"); });',
  '  } catch (e) {',
  '    return Promise.resolve(bad("read-threw"));',
  '  }',
  '}'
].join('\n')

type CompiledLeaf = (node: unknown, opts: { collection?: string }) => Promise<ControlLeafResult>

let compiled: CompiledLeaf | null = null

export function isReadable (r: ControlLeafResult): r is ControlLeafRead {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
  const k = Object.keys(r).sort().join(',')
  if (k !== [...KEYS].sort().join(',')) return false
  const c = r as ControlLeafRead
  return Number.isInteger(c.leafRev) && c.leafRev >= 0 && Number.isInteger(c.tailRev) && c.tailRev >= 0 &&
    typeof c.leafAction8 === 'string' && ACTION8_RE.test(c.leafAction8) &&
    typeof c.tailAction8 === 'string' && ACTION8_RE.test(c.tailAction8)
}

/** Resolves (never rejects) to a read or `{ unreadable: <token> }`. */
export async function readControlLeaf (node: unknown): Promise<ControlLeafResult> {
  if (compiled === null) compiled = new Function('return (' + CONTROL_LEAF_SOURCE + ')')() as CompiledLeaf
  try {
    return await compiled(node, {})
  } catch {
    return { unreadable: 'read-threw' }
  }
}

/** readsByRole: {role: read}. Returns {verdict, values?}; verdict is agree | fork-leaf | fork-tail | unreadable. */
export function classifyRound (readsByRole: Record<string, ControlLeafResult | null>): ForkRoundClass {
  const reads = readsByRole !== null && typeof readsByRole === 'object' ? Object.values(readsByRole) : []
  if (reads.length === 0 || !reads.every((r) => r !== null && isReadable(r))) return { verdict: 'unreadable' }
  const first = reads[0] as ControlLeafRead
  if (reads.some((r) => (r as ControlLeafRead).leafRev !== first.leafRev || (r as ControlLeafRead).leafAction8 !== first.leafAction8)) return { verdict: 'fork-leaf' }
  if (reads.some((r) => (r as ControlLeafRead).tailRev !== first.tailRev || (r as ControlLeafRead).tailAction8 !== first.tailAction8)) return { verdict: 'fork-tail' }
  return { verdict: 'agree', values: { leafRev: first.leafRev, leafAction8: first.leafAction8, tailRev: first.tailRev, tailAction8: first.tailAction8 } }
}

function rolesValid (roles: unknown): roles is string[] {
  if (!Array.isArray(roles) || roles.length < 2) return false
  if (!roles.every((r) => typeof r === 'string' && ROLE_RE.test(r))) return false
  return new Set(roles).size === roles.length
}

export interface ForkPrecheckInput {
  roles?: string[]
  verdict?: string
  values?: ControlLeafValues
  digestMismatch?: number
  reads?: number
  at?: string
}

/** The ONLY formatter of line 1 and the ONLY place the single-token precedence lives. */
export function forkPrecheckLine (v: ForkPrecheckInput | undefined): string {
  const x = v ?? {}
  const fail = (t: string): string => 'FORK-PRECHECK: FAIL ' + t
  if (!rolesValid(x.roles) || x.verdict === 'role-missing') return fail('role-missing')
  const dig = x.digestMismatch
  if (Number.isInteger(dig) && (dig as number) > 0) return fail('digest-mismatch-logged')
  if (x.verdict === 'agree') {
    const at = typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) && new Date(x.at).toISOString() === x.at
    if (x.values === undefined || !isReadable(x.values) || !Number.isInteger(dig) || dig !== 0 || !Number.isInteger(x.reads) || (x.reads as number) < 1 || !at) return fail('unreadable')
    const o = x.values
    return 'FORK-PRECHECK: PASS roles=' + (x.roles as string[]).join(',') + ' leafRev=' + o.leafRev + ' leafAction8=' + o.leafAction8 + ' tailRev=' + o.tailRev +
      ' tailAction8=' + o.tailAction8 + ' digestMismatch=0 reads=' + String(x.reads) + ' at=' + (x.at as string)
  }
  if (typeof x.verdict === 'string' && FORK_FAIL_TOKENS.includes(x.verdict)) return fail(x.verdict)
  return fail('unreadable')
}

export interface ForkPrecheckOptions {
  readers: Record<string, () => Promise<ControlLeafResult>>
  spacingMs?: number
  capMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  digestMismatch?: () => Promise<number> | number
}

export interface ForkPrecheckResult {
  line: string
  rounds: number
  last: Record<string, ControlLeafResult>
}

/**
 * readers: {role: () => Promise<read>} (at least 2, roles ^[a-z0-9-]{1,16}$). Rounds start at 0,
 * spacingMs, 2*spacingMs ... up to capMs; every round reads every role; the first agree round ends
 * the loop; then digestMismatch() (default 0) is read once. Resolves {line, rounds, last}.
 */
export async function forkPrecheck (opts: ForkPrecheckOptions): Promise<ForkPrecheckResult> {
  const spacingMs = opts.spacingMs ?? FORK_SPACING_MS
  const capMs = opts.capMs ?? FORK_CAP_MS
  const now = opts.now ?? ((): number => Date.now())
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const readers = opts.readers !== null && typeof opts.readers === 'object' ? opts.readers : {}
  const roles = Object.keys(readers)
  if (!rolesValid(roles) || !roles.every((r) => typeof readers[r] === 'function')) {
    return { line: forkPrecheckLine({ roles, verdict: 'role-missing', digestMismatch: 0, reads: 0, at: new Date(now()).toISOString() }), rounds: 0, last: {} }
  }
  const t0 = now()
  let rounds = 0
  let last: Record<string, ControlLeafResult> = {}
  let verdict = 'unreadable'
  let values: ControlLeafValues | undefined
  let at = new Date(t0).toISOString()
  for (let k = 0; k * spacingMs <= capMs; k++) {
    if (k > 0) {
      if (now() - t0 > capMs) break
      await sleep(spacingMs)
    }
    const round: Record<string, ControlLeafResult> = {}
    for (const role of roles) {
      try {
        round[role] = await readers[role]!()
      } catch {
        round[role] = { unreadable: 'read-threw' }
      }
    }
    rounds++
    last = round
    const c = classifyRound(round)
    verdict = c.verdict
    values = c.values
    at = new Date(now()).toISOString()
    if (verdict === 'agree') break
  }
  let digest = 0
  if (typeof opts.digestMismatch === 'function') {
    try {
      digest = Number(await opts.digestMismatch())
    } catch {
      digest = NaN
    }
  }
  if (!Number.isInteger(digest) || digest < 0) {
    return { line: forkPrecheckLine({ roles, verdict: 'unreadable', digestMismatch: 0, reads: rounds, at }), rounds, last }
  }
  return { line: forkPrecheckLine({ roles, verdict, values, digestMismatch: digest, reads: rounds, at }), rounds, last }
}
