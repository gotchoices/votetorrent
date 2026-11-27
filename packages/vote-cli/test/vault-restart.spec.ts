// Cross-process restart persistence: a child process writes through openDeviceVault, exits (or is
// SIGKILLed right after a write), and a NEW process reads the token-gated secret (with the token), the
// at-rest secret and the sealed identity store (without it). The child runs under the same ts-node
// hook and TS_NODE_PROJECT the package `test` script uses, read from package.json at test time.

import { expect } from 'chai'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateApprovalToken, writeApprovalTokenFile } from '../src/approval/token.js'
import { assertNoLeak } from './support/vault-leak-check.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CHILD = join('test', 'support', 'vault-restart-child.ts')

interface ChildRun {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | undefined
}

/** The node flags and TS_NODE_PROJECT of the package `test` script, so the child uses the SAME loader as mocha. */
function loaderFromManifest(): { nodeArgs: string[], tsNodeProject: string } {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { scripts: { test: string } }
  const script = manifest.scripts.test
  const project = /TS_NODE_PROJECT=(\S+)/.exec(script)?.[1]
  if (project === undefined) throw new Error('test script has no TS_NODE_PROJECT')
  const nodeArgs: string[] = []
  for (const m of script.matchAll(/--node-option=(\S+)/g)) nodeArgs.push(`--${m[1]!}`)
  if (nodeArgs.length === 0) throw new Error('test script has no --node-option')
  return { nodeArgs, tsNodeProject: project }
}

function findTmp(dir: string): string[] {
  const hits: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes('.tmp-')) hits.push(entry.name)
    if (entry.isDirectory()) hits.push(...findTmp(join(dir, entry.name)))
  }
  return hits
}

describe('vault restart', () => {
  let root: string
  let home: string
  let tokenPath: string
  let otherTokenPath: string
  let expectPath: string
  const token = generateApprovalToken()
  const otherToken = generateApprovalToken()
  const auth = randomBytes(32)
  const atRest = randomBytes(32)
  const probeSecret = randomBytes(32)
  const identityRaw = randomBytes(24)
  const probeRaw = randomBytes(24)
  const sensitive: Uint8Array[] = [token, otherToken, auth, atRest, probeSecret, identityRaw, probeRaw]
  const outputs: string[] = []

  function run(mode: string, tokenFile: string): ChildRun {
    const { nodeArgs, tsNodeProject } = loaderFromManifest()
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.DEBUG
    env.TS_NODE_PROJECT = tsNodeProject
    env.FORCE_COLOR = '0'
    const result = spawnSync(
      process.execPath,
      ['--no-deprecation', ...nodeArgs, CHILD, mode, home, tokenFile, expectPath],
      { cwd: PACKAGE_ROOT, env, encoding: 'utf8', timeout: 60000 }
    )
    expect(result.error).to.equal(undefined)
    outputs.push(result.stdout, result.stderr)
    const line = result.stdout.trim()
    let json: Record<string, unknown> | undefined
    if (line.length > 0) {
      expect(line.split('\n').length).to.equal(1)
      json = JSON.parse(line) as Record<string, unknown>
    }
    return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json }
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'vt-13-restart-'))
    home = join(root, 'device')
    mkdirSync(join(root, 'tokens'), { mode: 0o700 })
    tokenPath = join(root, 'tokens', 'approval')
    otherTokenPath = join(root, 'tokens', 'other')
    writeApprovalTokenFile(tokenPath, token)
    writeApprovalTokenFile(otherTokenPath, otherToken)
    expectPath = join(root, 'expect.json')
    const expectation = {
      auth: auth.toString('hex'),
      atRest: atRest.toString('hex'),
      identity: JSON.stringify([{ userId: 'u13', key: identityRaw.toString('base64url') }]),
      probe: probeRaw.toString('base64url'),
      probeSecret: probeSecret.toString('hex')
    }
    writeFileSync(expectPath, JSON.stringify(expectation), { mode: 0o600 })
  })

  after(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('write exits 0 with {"wrote":true}', function () {
    this.timeout(90000)
    const r = run('write', tokenPath)
    expect(r.status).to.equal(0)
    expect(r.json).to.deep.equal({ wrote: true })
  })

  it('a separate read process gets all three back equal with prompts 1', function () {
    this.timeout(90000)
    const r = run('read', tokenPath)
    expect(r.status).to.equal(0)
    expect(r.json).to.deep.equal({ authEqual: true, atRestEqual: true, identityEqual: true, prompts: 1 })
  })

  it('a separate read-no-token process reads the at-rest secret and identity, and is denied the auth secret', function () {
    this.timeout(90000)
    const r = run('read-no-token', tokenPath)
    expect(r.status).to.equal(0)
    expect(r.json).to.deep.equal({ atRestEqual: true, identityEqual: true, authDenied: true })
  })

  it('a read process given a different valid token prints KeyVaultError:auth-denied and exits 1', function () {
    this.timeout(90000)
    const r = run('read', otherTokenPath)
    expect(r.status).to.equal(1)
    expect(r.json).to.deep.equal({ error: 'KeyVaultError:auth-denied' })
  })

  it('write-then-kill ends by SIGKILL; the next process reads both writes back and no .tmp- file remains', function () {
    this.timeout(90000)
    const killed = run('write-then-kill', tokenPath)
    expect(killed.signal).to.equal('SIGKILL')
    expect(killed.json).to.equal(undefined)
    const r = run('read-probe', tokenPath)
    expect(r.status).to.equal(0)
    expect(r.json).to.deep.equal({ probeEqual: true, probeSecretEqual: true })
    expect(findTmp(root)).to.deep.equal([])
  })

  it('no child stdout or stderr carries the token, a secret, the identity or the probe', () => {
    expect(outputs.length).to.be.at.least(12)
    const all = outputs.join('\n')
    assertNoLeak(all, sensitive)
    expect(all).to.not.include(root)
  })
})
