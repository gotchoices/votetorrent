import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRelayEnv } from '../src/relay/relay-env.js'
import {
  PROBE_HOST_DIR,
  RELAY_ONLY,
  relayChildEnv,
  startLoopbackRelay,
  type LoopbackRelay
} from './support/loopback-relay.js'

/**
 * loopback-relay.spec.ts: one relay for the whole describe. Nothing in this file prints the relay's
 * address or peer id; assertions compare values and report booleans.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function portIsFree (port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => { resolve(false) })
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.close(() => { resolve(true) })
    })
  })
}

describe('loopback relay fixture', function () {
  this.timeout(180000)
  let relay: LoopbackRelay

  before(async () => {
    relay = await startLoopbackRelay()
  })

  after(async () => {
    if (relay !== undefined) {
      await relay.stop()
      rmSync(relay.dir, { recursive: true, force: true })
    }
  })

  it('writes a 0600 relay.env with exactly one RELAY_MULTIADDR line in a 0700 dir', () => {
    expect(statSync(relay.dir).mode & 0o777).to.equal(0o700)
    expect(statSync(relay.relayEnvPath).mode & 0o777).to.equal(0o600)
    const lines = readFileSync(relay.relayEnvPath, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(lines).to.have.lengthOf(1)
    expect(lines.filter((l) => l.startsWith('RELAY_MULTIADDR=')).length).to.equal(1)
    expect(readRelayEnv(relay.relayEnvPath).multiaddr === relay.multiaddr).to.equal(true)
    expect(relay.peerId8).to.have.lengthOf(8)
    expect(relay.multiaddr.endsWith(relay.peerId8)).to.equal(true)
  })

  it('listens on an ephemeral port that is not a shared Metro port', () => {
    expect(relay.port).to.be.at.least(1024)
    expect(relay.port).to.be.at.most(65535)
    expect([8081, 8091, 8097]).to.not.include(relay.port)
    expect(relay.multiaddr.includes(`/tcp/${relay.port}/`)).to.equal(true)
  })

  it('keeps the key and bootstrap files inside the fixture dir and outside the repo', () => {
    const key = join(relay.dir, 'relay-key.pb')
    expect(existsSync(key)).to.equal(true)
    expect(statSync(key).mode & 0o777).to.equal(0o600)
    expect(existsSync(join(relay.dir, 'bootstrap.json'))).to.equal(true)
    expect(existsSync(relay.logPath)).to.equal(true)
    expect(statSync(relay.logPath).mode & 0o777).to.equal(0o600)
    expect(relay.dir.startsWith(REPO_ROOT)).to.equal(false)
    expect(relay.dir.startsWith(REPO_ROOT.replace(/\/$/, '') + sep)).to.equal(false)
  })

  it('a probe client reserves a circuit through the relay', function () {
    this.timeout(120000)
    const result = spawnSync(
      process.execPath,
      [RELAY_ONLY, '--probe-client', relay.multiaddr, '--timeout-ms', '45000'],
      { cwd: PROBE_HOST_DIR, env: relayChildEnv(), encoding: 'utf8', timeout: 90000 }
    )
    expect(result.error).to.equal(undefined)
    const lines = result.stdout.split('\n').filter((l) => l.startsWith('PROBE_CLIENT '))
    expect(lines).to.have.lengthOf(1)
    const probe = JSON.parse((lines[0] ?? '').slice('PROBE_CLIENT '.length)) as {
      reserved: boolean
      ms: number
      circuitViaRelay: boolean
      directAddrs: number
      error: string | null
    }
    expect(probe.reserved).to.equal(true)
    expect(probe.circuitViaRelay).to.equal(true)
    expect(probe.error).to.equal(null)
    // Recorded for the run summary, never asserted: the client's own address count and the time to reserve.
    const record = `PROBE directAddrs=${probe.directAddrs} ms=${probe.ms}`
    expect(record.startsWith('PROBE ')).to.equal(true)
    process.stdout.write(`      ${record}\n`)
  })

  it('stop() ends the relay with RELAY_STOPPED and frees the port', async function () {
    this.timeout(60000)
    const result = await relay.stop()
    expect(result.stopped).to.equal(true)
    expect(result.exitCode).to.equal(0)
    expect(await portIsFree(relay.port)).to.equal(true)
    const again = await relay.stop()
    expect(again).to.deep.equal(result)
  })
})
