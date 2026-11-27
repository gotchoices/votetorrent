import { expect } from 'chai'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELFCHECK_IDS, runSelfcheck } from '../src/run/selfcheck.js'

const SELFCHECK_SRC = fileURLToPath(new URL('../src/run/selfcheck.ts', import.meta.url))

const leftovers = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('vt-selfcheck-'))

describe('run: selfcheck', () => {
  it('runSelfcheck prints SELFCHECK: PASS 8/8 and returns 0', async () => {
    const lines: string[] = []
    const code = await runSelfcheck({ out: (t) => { lines.push(t) } })
    expect(code).to.equal(0)
    expect(SELFCHECK_IDS).to.deep.equal(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
    expect(lines.at(-1)).to.equal('SELFCHECK: PASS 8/8')
    const checks = lines.filter((l) => /^(PASS|FAIL) [A-H] /.test(l))
    expect(checks).to.have.length(8)
    expect(checks.map((l) => l.split(' ')[1])).to.deep.equal([...SELFCHECK_IDS])
    expect(checks.every((l) => l.startsWith('PASS '))).to.equal(true)
    expect(lines.join('\n')).to.not.match(/12D3KooW[1-9A-HJ-NP-Za-km-z]{30,}/)
  })

  it('selfcheck imports no engine, node or network module', () => {
    const src = readFileSync(SELFCHECK_SRC, 'utf8')
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!)
    expect(specifiers.length).to.be.at.least(5)
    for (const s of specifiers) {
      expect(s, s).to.not.match(/vote-engine|cadre-core|node:net|node:http|child_process|daemon|election|launcher|options/)
      expect(s.startsWith('./') || s.startsWith('node:'), s).to.equal(true)
    }
    expect(code).to.not.match(/\bimport\(/)
    expect(code).to.not.match(/\brequire\(/)
    for (const s of ['./output.js', './secret-scan.js', './peer-budget.js', './legs.js', './results.js']) expect(specifiers).to.include(s)
  })

  it('selfcheck leaves no temp dir behind', async () => {
    const before = leftovers()
    const code = await runSelfcheck({ out: () => {} })
    expect(code).to.equal(0)
    const after = leftovers()
    expect(after.filter((n) => !before.includes(n))).to.deep.equal([])
    expect(leftovers().filter((n) => !before.includes(n))).to.deep.equal([])
    const d = join(tmpdir(), 'vt-selfcheck-')
    expect(d.length).to.be.greaterThan(0)
  })
})
