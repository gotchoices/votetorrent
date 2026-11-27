/**
 * harness-import-anchor-guard.spec.ts — CR-R2-01 (62 review round 2).
 *
 * Since 62-102, `NetworksEngine.importFoundingBundle` refuses with `anchor-required` when it is
 * called without an out-of-band anchor, before any parse or DbFactory call. A two-node harness spec
 * that forgets the anchor therefore imports nothing and still reports its other legs, which made
 * the O-02 instrument vacuous at HEAD. The harness specs are opt-in (RUN_P2P_HARNESS=1), so this
 * guard runs in the ordinary suite and reads their source instead.
 */

import { expect } from 'chai'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const ANCHOR = /\bexpected(Fingerprint|Digest|NetworkHash)\s*:/

/** The argument text of every `importFoundingBundle(` call in `source` (balanced parentheses). */
function importCallArguments (source: string): string[] {
  const out: string[] = []
  const marker = '.importFoundingBundle('
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at < 0) return out
    let depth = 1
    let i = at + marker.length
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    out.push(source.slice(at + marker.length, i - 1))
    from = i
  }
}

function unanchoredCalls (source: string): string[] {
  return importCallArguments(source).filter((args) => !ANCHOR.test(args))
}

function harnessSources (): Array<{ file: string; source: string }> {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.harness.spec.ts')).map((f) => join(TEST_DIR, f))
  const helperDir = join(TEST_DIR, 'harness')
  for (const f of readdirSync(helperDir)) if (f.endsWith('.ts')) files.push(join(helperDir, f))
  return files.map((file) => ({ file, source: readFileSync(file, 'utf8') }))
}

describe('harness specs import founding bundles WITH an out-of-band anchor (CR-R2-01)', () => {
  it('negative control: the checker flags an unanchored call and accepts each anchor kind', () => {
    expect(unanchoredCalls('await engineB.importFoundingBundle(text, undefined)')).to.have.lengthOf(1)
    expect(unanchoredCalls('await engineB.importFoundingBundle(text, undefined, {})')).to.have.lengthOf(1)
    expect(unanchoredCalls('await e.importFoundingBundle(text, undefined, { expectedFingerprint: x.fingerprint })')).to.have.lengthOf(0)
    expect(unanchoredCalls('await e.importFoundingBundle(t, u, { expectedDigest: b.digest })')).to.have.lengthOf(0)
    expect(unanchoredCalls('await e.importFoundingBundle(t, u, { expectedNetworkHash: h })')).to.have.lengthOf(0)
  })

  it('every importFoundingBundle call in a harness spec or harness helper carries an anchor', () => {
    const sources = harnessSources()
    const total = sources.reduce((n, s) => n + importCallArguments(s.source).length, 0)
    // Positive anchor: the scan really sees the harness imports (founding-bundle F-1/F-3/F-4 and O-02).
    expect(total, 'harness importFoundingBundle calls found').to.be.at.least(4)
    const offenders = sources.flatMap((s) => unanchoredCalls(s.source).map((args) => `${s.file}: importFoundingBundle(${args.replace(/\s+/g, ' ')})`))
    expect(offenders, 'an unanchored import is refused anchor-required and measures nothing').to.deep.equal([])
  })
})
