// Standalone child for the vault restart spec. argv: <mode> <home> <tokenFile> <expectFile>.
// Each mode opens the device home with openDeviceVault, prints exactly ONE JSON line of booleans and
// counts (never a secret, a token, a message or a path), then closes. `write-then-kill` SIGKILLs itself
// right after its writes, with no close and no output. A thrown error prints {"error":"<name>:<code>"}
// and exits 1.

import { readFileSync } from 'node:fs'
import { OFFICER_ENCRYPTION_KEY_POLICY } from '@votetorrent/vote-engine/rn'
import { NO_APPROVAL, createApprovalContext, type ApprovalContext } from '../../src/approval/token.js'
import { openDeviceVault } from '../../src/vault/device-vault.js'

const AUTH_ALIAS = 'vt.keyholder-signing.u13'
const AT_REST_ALIAS = 'vt.officer-enc.u13'
const PROBE_ALIAS = 'vt.officer-enc.u13.g1'
const IDENTITY_KEY = 'vt.keyholder-identities.v1'
const PROBE_KEY = 'vt.restart-probe'
const SIGNING_POLICY = { requireUserAuth: true }

interface Expect {
  auth: string
  atRest: string
  identity: string
  probe: string
  probeSecret: string
}

function hex(b: Uint8Array | null): string {
  return b === null ? '' : Buffer.from(b).toString('hex')
}

function out(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

async function main(): Promise<void> {
  const [mode, home, tokenFile, expectFile] = process.argv.slice(2)
  if (mode === undefined || home === undefined || tokenFile === undefined || expectFile === undefined) {
    throw Object.assign(new Error('usage'), { name: 'UsageError', code: 'argv' })
  }
  const expect = JSON.parse(readFileSync(expectFile, 'utf8')) as Expect
  const withToken: ApprovalContext = createApprovalContext({ file: tokenFile })
  const approval = mode === 'write' || mode === 'read' ? withToken : NO_APPROVAL
  const dv = openDeviceVault({ home, approval })
  try {
    switch (mode) {
      case 'write': {
        await dv.vault.putSecret(AUTH_ALIAS, Buffer.from(expect.auth, 'hex'), SIGNING_POLICY)
        await dv.vault.putSecret(AT_REST_ALIAS, Buffer.from(expect.atRest, 'hex'), OFFICER_ENCRYPTION_KEY_POLICY)
        await dv.storage.setItem(IDENTITY_KEY, expect.identity)
        out({ wrote: true })
        return
      }
      case 'read': {
        const auth = await dv.vault.getSecret(AUTH_ALIAS)
        const atRest = await dv.vault.getSecret(AT_REST_ALIAS)
        const identity = await dv.storage.getItem(IDENTITY_KEY)
        out({
          authEqual: hex(auth) === expect.auth,
          atRestEqual: hex(atRest) === expect.atRest,
          identityEqual: identity === expect.identity,
          prompts: dv.vault.authPromptCount
        })
        return
      }
      case 'read-no-token': {
        const atRest = await dv.vault.getSecret(AT_REST_ALIAS)
        const identity = await dv.storage.getItem(IDENTITY_KEY)
        let authDenied = false
        try {
          await dv.vault.getSecret(AUTH_ALIAS)
        } catch (e) {
          const err = e as { name?: unknown, code?: unknown }
          authDenied = err.name === 'KeyVaultError' && err.code === 'auth-denied'
        }
        out({ atRestEqual: hex(atRest) === expect.atRest, identityEqual: identity === expect.identity, authDenied })
        return
      }
      case 'write-then-kill': {
        await dv.storage.setItem(PROBE_KEY, expect.probe)
        await dv.vault.putSecret(PROBE_ALIAS, Buffer.from(expect.probeSecret, 'hex'), OFFICER_ENCRYPTION_KEY_POLICY)
        process.kill(process.pid, 'SIGKILL')
        return
      }
      case 'read-probe': {
        const probe = await dv.storage.getItem(PROBE_KEY)
        const probeSecret = await dv.vault.getSecret(PROBE_ALIAS)
        out({ probeEqual: probe === expect.probe, probeSecretEqual: hex(probeSecret) === expect.probeSecret })
        return
      }
      default:
        throw Object.assign(new Error('mode'), { name: 'UsageError', code: 'mode' })
    }
  } finally {
    dv.close()
  }
}

main().catch((e: unknown) => {
  const err = e as { name?: unknown, code?: unknown } | undefined
  out({ error: `${String(err?.name ?? 'Error')}:${String(err?.code ?? 'none')}` })
  process.exitCode = 1
})
