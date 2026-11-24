import { expect } from 'chai'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayEnvError, readRelayEnv, writeRelayEnv } from '../src/relay/relay-env.js'

/** A well-formed loopback address with a placeholder peer id: a fixture value, not a real relay. */
const ADDR = '/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWFixtureFixtureFixtureFixtureFixtureFixture1'

function refusal (fn: () => unknown): RelayEnvError {
  try {
    fn()
  } catch (err) {
    expect(err).to.be.instanceOf(RelayEnvError)
    expect((err as Error).name).to.equal('RelayEnvError')
    return err as RelayEnvError
  }
  expect.fail('readRelayEnv did not throw')
}

describe('relay-env', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vt-relay-env-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a multiaddr through writeRelayEnv and readRelayEnv with mode 0600', () => {
    const p = join(dir, 'relay.env')
    writeRelayEnv(p, ADDR)
    expect(statSync(p).mode & 0o777).to.equal(0o600)
    const text = readFileSync(p, 'utf8')
    expect(text.split('\n')).to.deep.equal([`RELAY_MULTIADDR=${ADDR}`, ''])
    expect(readRelayEnv(p)).to.deep.equal({ multiaddr: ADDR })
  })

  it('refuses a missing file with code missing', () => {
    const err = refusal(() => readRelayEnv(join(dir, 'absent.env')))
    expect(err.code).to.equal('missing')
  })

  it('refuses a group-writable relay.env with code mode', () => {
    const p = join(dir, 'relay.env')
    writeRelayEnv(p, ADDR)
    chmodSync(p, 0o620)
    const err = refusal(() => readRelayEnv(p))
    expect(err.code).to.equal('mode')
  })

  it('refuses a file without a RELAY_MULTIADDR line with code no-multiaddr', () => {
    const p = join(dir, 'relay.env')
    writeFileSync(p, 'STARTED_AT=today\nPEER_ID=\n', { mode: 0o600 })
    const err = refusal(() => readRelayEnv(p))
    expect(err.code).to.equal('no-multiaddr')
  })

  it('refuses a malformed address with code shape and does not echo it', () => {
    const bad = '/ip4/127.0.0.1/tcp/1/ws/SENTINELADDR'
    const p = join(dir, 'relay.env')
    writeFileSync(p, `RELAY_MULTIADDR=${bad}\n`, { mode: 0o600 })
    const read = refusal(() => readRelayEnv(p))
    expect(read.code).to.equal('shape')
    expect(read.message).to.not.include('SENTINELADDR')
    const write = refusal(() => writeRelayEnv(join(dir, 'other.env'), bad))
    expect(write.code).to.equal('shape')
    expect(write.message).to.not.include('SENTINELADDR')
  })
})
