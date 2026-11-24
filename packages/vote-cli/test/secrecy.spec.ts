import { expect } from 'chai'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAN_RE, PEER_RE, SecretRegistry, last8, redact } from '../src/secrecy/redact.js'
import { scanSecrets } from '../src/secrecy/scan-secrets.js'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

// A fake peer id built at runtime so no real-looking id sits in the source: '12D3KooW' + 44 base58 chars.
function fakePeerId(): string {
  let id = '12D3KooW'
  for (let i = 0; i < 44; i++) id += BASE58[(i * 7 + 3) % BASE58.length]
  return id
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('secrecy: redact and scanSecrets', () => {
  const tmpDirs: string[] = []
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'vt-secrecy-'))
    tmpDirs.push(d)
    return d
  }

  it('replaces a registered whole secret with <secret>', () => {
    const reg = new SecretRegistry()
    const value = 'spec-whole-' + 'w'.repeat(12)
    expect(reg.add(value)).to.equal(value)
    expect(reg.size).to.equal(1)
    const out = redact(`code=${value} again ${value}.`, reg)
    expect(out).to.equal('code=<secret> again <secret>.')
    expect(out).to.not.include(value)
  })

  it('ignores values shorter than 8 characters', () => {
    const reg = new SecretRegistry()
    expect(reg.add('short7c')).to.equal('short7c')
    expect(reg.size).to.equal(0)
    expect(reg.add(42)).to.equal('42')
    expect(reg.size).to.equal(0)
    expect(redact('short7c stays', reg)).to.equal('short7c stays')
  })

  it('masks any 16-character window of a windowed secret', () => {
    const reg = new SecretRegistry()
    const value = 'spec-window-' + 'abcdefghijklmnopqrstuvwxyz01'
    expect(value.length).to.equal(40)
    reg.add(value, { windows: true })
    expect(reg.windowCount).to.equal(40 - 16 + 1)
    expect(reg.hasWindow(value.slice(3, 19))).to.equal(true)
    const sub = value.slice(10, 30)
    const out = redact(`before ${sub} after`, reg)
    expect(out).to.equal('before <secret> after')
    expect(count(out, '<secret>')).to.equal(1)
    expect(out).to.not.include(sub)
    expect(out).to.not.include(sub.slice(0, 4))
  })

  it('replaces 64-hex runs with <hex64>', () => {
    const hex = 'ab'.repeat(32)
    expect(hex.length).to.equal(64)
    const out = redact(`token ${hex} and ${hex.toUpperCase()} end`, new SecretRegistry())
    expect(out).to.equal('token <hex64> and <hex64> end')
    expect(redact('short ' + 'ab'.repeat(8))).to.equal('short ' + 'ab'.repeat(8))
  })

  it('shows a peer id only as its last 8 characters', () => {
    const id = fakePeerId()
    expect(id.length).to.equal(52)
    expect(PEER_RE.test(id)).to.equal(true)
    PEER_RE.lastIndex = 0
    expect(last8(id)).to.equal(id.slice(-8))
    const out = redact(`peer ${id} dialed`, new SecretRegistry())
    expect(out).to.equal(`peer <peer:${id.slice(-8)}> dialed`)
    expect(out).to.not.include(id.slice(0, 20))
  })

  it('replaces private LAN IPv4 addresses with <lan>', () => {
    expect(LAN_RE.test('192.168.1.7')).to.equal(true)
    LAN_RE.lastIndex = 0
    const out = redact('a 10.1.2.3 b 192.168.0.9 c 172.20.1.1 d 8.8.8.8 e 192.168.1.7', new SecretRegistry())
    expect(out).to.equal('a <lan> b <lan> c <lan> d 8.8.8.8 e <lan>')
  })

  it('replaces the longest registered path first, then the home dir', () => {
    const home = '/vt-fake-home/user'
    const opts = { paths: [[home + '/runs', '<runs>'], [home + '/runs/a', '<a>']] as const, home }
    const reg = new SecretRegistry()
    expect(redact(home + '/runs/a/x', reg, opts)).to.equal('<a>/x')
    expect(redact(home + '/runs/b', reg, opts)).to.equal('<runs>/b')
    expect(redact(home + '/z', reg, opts)).to.equal('<home>/z')
    expect(redact('none here', reg, opts)).to.equal('none here')
  })

  it('scanSecrets counts whole hits, window hits and files over a nested run dir', () => {
    const root = tmp()
    const reg = new SecretRegistry()
    const whole = 'spec-scan-whole-' + 'h'.repeat(8)
    const windowed = 'spec-scan-windowed-' + 'ijklmnopqrstuvwxyz'
    reg.add(whole)
    reg.add(windowed, { windows: true })
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(root, 'one.log'), `line with ${whole} inside\n`)
    writeFileSync(join(root, 'nested', 'deeper', 'two.log'), `partial ${windowed.slice(5, 21)} only\n`)
    writeFileSync(join(root, 'nested', 'three.log'), 'nothing to see\n')
    expect(scanSecrets(root, reg)).to.deep.equal({ whole: 1, windows: 1, files: 3 })
  })

  it('scanSecrets does not follow a symlink out of the run dir', () => {
    const root = tmp()
    const outside = tmp()
    const reg = new SecretRegistry()
    const value = 'spec-scan-outside-' + 'o'.repeat(8)
    reg.add(value, { windows: true })
    writeFileSync(join(outside, 'leak.txt'), value + '\n')
    writeFileSync(join(root, 'clean.txt'), 'clean\n')
    symlinkSync(join(outside, 'leak.txt'), join(root, 'leak-link'))
    symlinkSync(outside, join(root, 'dir-link'))
    expect(scanSecrets(root, reg)).to.deep.equal({ whole: 0, windows: 0, files: 1 })
  })

  it('scanSecrets reports whole -1 when the root cannot be read', () => {
    const root = join(tmp(), 'does-not-exist')
    const result = scanSecrets(root, new SecretRegistry())
    expect(result.whole).to.equal(-1)
    expect(result.files).to.equal(0)
  })

  it('two registries do not share secrets', () => {
    const a = new SecretRegistry()
    const b = new SecretRegistry()
    const sa = 'spec-registry-a-' + 'a'.repeat(8)
    const sb = 'spec-registry-b-' + 'b'.repeat(8)
    a.add(sa)
    b.add(sb, { windows: true })
    expect(a.size).to.equal(1)
    expect(b.size).to.equal(1)
    expect(a.windowCount).to.equal(0)
    expect(redact(sa, b)).to.equal(sa)
    expect(redact(sb, a)).to.equal(sb)
    expect(redact(sa, a)).to.equal('<secret>')
    expect(redact(sb, b)).to.equal('<secret>')
    expect(a.redactor()(sb)).to.equal(sb)
    expect(b.redactor()(sb)).to.equal('<secret>')
  })
})
