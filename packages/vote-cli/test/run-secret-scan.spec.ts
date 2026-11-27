import { expect } from 'chai'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SECRET_MIN_LENGTH,
  SECRET_WINDOW,
  SecretRegistry,
  createLineMasker,
  registerRelay,
  relayIsPrivate
} from '../src/run/secret-scan.js'

// Synthetic values only: a fake peer id and a fake 40-char value made of plain text.
const PEER = '12D3KooWSyntheticPeerRedactSamp1eXyzABCDEFGHJKMNPQRSTUVWxyz'
const VALUE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0'
const HEX64 = 'ab'.repeat(32)
const TAIL = '/tcp/4001/ws/p2p/' + PEER

describe('run: secret scan', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-run-scan-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('mask hides a registered value whole and as any 16-char window', () => {
    expect(SECRET_MIN_LENGTH).to.equal(8)
    expect(SECRET_WINDOW).to.equal(16)
    const reg = new SecretRegistry()
    expect(reg.register(VALUE, { windows: true })).to.equal(undefined)
    expect(reg.size).to.equal(1)
    expect(reg.mask(`x ${VALUE} y`)).to.equal('x <secret> y')
    const partial = VALUE.slice(4, 24)
    const masked = reg.mask(`pre${partial}post`)
    expect(masked).to.equal('pre<secret>post')
    expect(masked).to.not.include(partial.slice(0, 16))
    expect(reg.mask(`a${VALUE.slice(0, 16)}b${VALUE.slice(20, 36)}c`)).to.equal('a<secret>b<secret>c')
    const noWindows = new SecretRegistry()
    noWindows.register(VALUE)
    expect(noWindows.mask(`pre${partial}post`)).to.equal(`pre${partial}post`)
    expect(noWindows.mask(VALUE)).to.equal('<secret>')
  })

  it('values shorter than 8 characters are not registered', () => {
    const reg = new SecretRegistry()
    reg.register('seven7!')
    reg.register(12345678 as unknown as string)
    reg.register(undefined as unknown as string)
    expect(reg.size).to.equal(0)
    expect(reg.mask('seven7! 12345678')).to.equal('seven7! 12345678')
    reg.register('eight8!!')
    expect(reg.size).to.equal(1)
    expect(reg.mask('eight8!!')).to.equal('<secret>')
  })

  it('scanTree counts whole and window hits per file and secret like the rig', () => {
    const reg = new SecretRegistry()
    reg.register(VALUE, { windows: true })
    writeFileSync(join(dir, 'clean.log'), 'nothing to see\n')
    writeFileSync(join(dir, 'whole.log'), `the value is ${VALUE} twice ${VALUE}\n`)
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'window.log'), `partial ${VALUE.slice(10, 26)} and ${VALUE.slice(20, 36)}\n`)
    expect(reg.scanTree([dir], { exclude: [] })).to.deep.equal({ whole: 1, windows: 1, files: 3 })
    const second = new SecretRegistry()
    second.register(VALUE, { windows: true })
    second.register('another-value-' + 'XYZ', { windows: true })
    writeFileSync(join(dir, 'whole.log'), `${VALUE} and another-value-XYZ\n`)
    expect(second.scanTree([dir], { exclude: [] })).to.deep.equal({ whole: 2, windows: 1, files: 3 })
  })

  it('scanTree finds a hit that straddles a chunk boundary', () => {
    const reg = new SecretRegistry()
    reg.register(VALUE, { windows: true })
    const chunk = 8 * 1024 * 1024
    const total = 9 * 1024 * 1024
    const buf = Buffer.alloc(total, 0x2e)
    buf.write(VALUE, chunk - 20, 'utf8')
    writeFileSync(join(dir, 'big.log'), buf)
    expect(reg.scanTree([dir], { exclude: [] })).to.deep.equal({ whole: 1, windows: 0, files: 1 })
    const win = new SecretRegistry()
    win.register(VALUE, { windows: true })
    const buf2 = Buffer.alloc(total, 0x2e)
    buf2.write(VALUE.slice(0, 16), chunk - 8, 'utf8')
    writeFileSync(join(dir, 'big.log'), buf2)
    expect(win.scanTree([dir], { exclude: [] })).to.deep.equal({ whole: 0, windows: 1, files: 1 })
  })

  it('scanTree skips excluded roots and symlinks and reports files scanned', () => {
    const reg = new SecretRegistry()
    reg.register(VALUE, { windows: true })
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, VALUE)
    const root = join(dir, 'root')
    mkdirSync(join(root, 'secrets'), { recursive: true })
    writeFileSync(join(root, 'secrets', 'code.txt'), VALUE)
    writeFileSync(join(root, 'clean.log'), 'clean')
    writeFileSync(join(root, 'skipped.bin'), VALUE)
    symlinkSync(outside, join(root, 'link.log'))
    const scan = reg.scanTree([root], { exclude: [join(root, 'secrets')], include: (p) => p.endsWith('.log') })
    expect(scan).to.deep.equal({ whole: 0, windows: 0, files: 1 })
    expect(reg.scanTree([root], { exclude: [join(root, 'secrets')] })).to.deep.equal({ whole: 1, windows: 0, files: 2 })
    expect(reg.scanTree([root, join(root, 'secrets')], { exclude: [] })).to.deep.equal({ whole: 3, windows: 0, files: 4 })
    expect(reg.scanTree([join(dir, 'absent')], { exclude: [] })).to.deep.equal({ whole: 0, windows: 0, files: 0 })
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked')
      mkdirSync(locked)
      writeFileSync(join(locked, 'x.log'), 'x')
      chmodSync(locked, 0o000)
      try {
        expect(reg.scanTree([locked], { exclude: [] }).whole).to.equal(-1)
      } finally {
        chmodSync(locked, 0o700)
      }
    }
  })

  it('relayIsPrivate matches loopback, LAN, link-local, ULA and .local but not a public relay', () => {
    const table: Array<[string, boolean]> = [
      ['/ip4/127.0.0.1' + TAIL, true],
      ['/ip4/10.1.2.3' + TAIL, true],
      ['/ip4/192.168.1.2' + TAIL, true],
      ['/ip4/172.20.0.1' + TAIL, true],
      ['/ip4/169.254.1.1' + TAIL, true],
      ['/ip6/::1' + TAIL, true],
      ['/ip6/fd12:3456::1' + TAIL, true],
      ['/ip6/fe80::1' + TAIL, true],
      ['/dns4/box.local' + TAIL, true],
      ['/dns4/localhost' + TAIL, true],
      ['/dns4/relay.example.org' + TAIL, false],
      ['/ip4/8.8.8.8' + TAIL, false],
      ['/ip4/172.32.0.1' + TAIL, false]
    ]
    for (const [addr, want] of table) expect(relayIsPrivate(addr), addr.slice(0, 24)).to.equal(want)
    expect(relayIsPrivate('/ip4/8.8.8.8' + TAIL, '8.8.8.8')).to.equal(true)
    expect(relayIsPrivate('/dns4/relay.example.org' + TAIL, '192.168.9.9')).to.equal(false)
    expect(relayIsPrivate('/dns4/relay.example.org' + TAIL, '')).to.equal(false)
  })

  it('registerRelay registers a private relay address and peer id, never a public one, and always LAN_IP', () => {
    const lan = '192.168.77.77'
    const priv = '/ip4/127.0.0.1' + TAIL
    const pub = '/dns4/relay.example.org' + TAIL
    const envPath = join(dir, 'relay.env')
    writeFileSync(envPath, `RELAY_MULTIADDR=${priv}\nPEER_ID=${PEER}\nLAN_IP=${lan}\nSTARTED_AT=x\n`, { mode: 0o600 })
    const reg = new SecretRegistry()
    expect(registerRelay(reg, envPath, priv)).to.deep.equal({ private: true })
    expect(reg.mask(`dial ${priv}`)).to.equal('dial <secret>')
    expect(reg.mask(`peer ${PEER}`)).to.equal('peer <secret>')
    expect(reg.mask(`ip ${lan}`)).to.equal('ip <secret>')
    const pubReg = new SecretRegistry()
    writeFileSync(envPath, `RELAY_MULTIADDR=${pub}\nPEER_ID=${PEER}\nLAN_IP=${lan}\n`, { mode: 0o600 })
    expect(registerRelay(pubReg, envPath, pub)).to.deep.equal({ private: false })
    expect(pubReg.mask(`dial ${pub}`)).to.equal(`dial ${pub}`)
    expect(pubReg.mask(`peer ${PEER}`)).to.equal(`peer ${PEER}`)
    expect(pubReg.mask(`ip ${lan}`)).to.equal('ip <secret>')
    expect(pubReg.size).to.equal(1)
    const bare = new SecretRegistry()
    writeFileSync(envPath, `RELAY_MULTIADDR=${priv}\n`, { mode: 0o600 })
    expect(registerRelay(bare, envPath, priv)).to.deep.equal({ private: true })
    expect(bare.size).to.equal(2)
  })

  it('registerFile registers a file\'s trimmed content without returning it', () => {
    const reg = new SecretRegistry()
    const p = join(dir, 'code.txt')
    writeFileSync(p, `  ${VALUE}\n`, { mode: 0o600 })
    expect(reg.registerFile(p, { windows: true })).to.equal(undefined)
    expect(reg.size).to.equal(1)
    expect(reg.mask(`code ${VALUE}`)).to.equal('code <secret>')
    expect(reg.mask(`part ${VALUE.slice(3, 19)}`)).to.equal('part <secret>')
    writeFileSync(join(dir, 'short.txt'), 'abc\n')
    reg.registerFile(join(dir, 'short.txt'))
    expect(reg.size).to.equal(1)
  })

  it('the line masker redacts full peer ids to the last 8, hex64, LAN ips and the state dir', () => {
    const reg = new SecretRegistry()
    reg.register(VALUE, { windows: true })
    const stateDir = join(dir, 'state')
    const mask = createLineMasker({ registry: reg, stateDir })
    const line = `peer=${PEER} key=${HEX64} ip=192.168.77.77 dir=${stateDir}/ev/x home=${homedir()}/y v=${VALUE} w=${VALUE.slice(2, 18)} e=Torn` + 'Action' + 'Error'
    const out = mask(line)
    expect(out).to.equal(`peer=<peer:${PEER.slice(-8)}> key=<hex64> ip=<lan> dir=<run>/ev/x home=<home>/y v=<secret> w=<secret> e=torn-refusal`)
    expect(out).to.not.include(PEER.slice(0, 20))
    expect(out).to.not.include(HEX64.slice(0, 16))
    expect(out).to.not.include(VALUE.slice(2, 18))
  })
})
