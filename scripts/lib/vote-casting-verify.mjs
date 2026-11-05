#!/usr/bin/env node
//
// scripts/lib/vote-casting-verify.mjs
//
// Purpose : the HOST half of the Phase 63 D-30 signature leg. It verifies the
//           hardware signature the device produced with THE SAME `verifySigP256`
//           the schema's `SignatureValidP256` calls, imported from the vote-engine
//           dist, so agreement is about shipped code, not a spike copy.
//
// Modes   : node scripts/lib/vote-casting-verify.mjs --signed <abs-file>
//               Verify the JSON object the probe logged after `[vcp] signed `,
//               with members exactly: v, digest, signature, deviceKey, rawKey, voter.
//           node scripts/lib/vote-casting-verify.mjs --selftest
//               The verifier's own positive AND negative controls. A verifier that
//               accepts everything cannot pass this.
//
// Exit    : 0 - every check passed
//           1 - a named check failed (the failing check is named in the output)
//
// Why each control exists:
//   - the SPKI control is spike 097 S2 and D-26: the raw Android key is an SPKI
//     DER and verifySigP256 must NOT accept it; only the normalized compressed
//     form verifies, so the entry has to carry the normalized form.
//   - the stub control is D-08 and spike 099 run 2: the dev stub producer's
//     placeholder signature must never verify.
//   - the altered-digest control flips a DECODED byte, because a last-character
//     edit of a 43-char base64url string can touch only the padding bits and
//     decode to the same 32 bytes (a vacuous control).
//   - the other-key control proves the positive check binds the key.
//
// Deps    : node:crypto, node:fs, node:os, node:path, node:url, node:child_process
//           and the vote-engine dist only. It never imports a third-party curve
//           library, so the selftest signer is independent of the code under test.
//           It never builds the dist.
//
// It never prints the signature, the digest or any voter field value: only check
// names and lengths.

import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const SELF = fileURLToPath(import.meta.url)
const DIST_ROOT = fileURLToPath(new URL('../../packages/vote-engine/dist/', import.meta.url))
const SRC_ROOT = fileURLToPath(new URL('../../packages/vote-engine/src/', import.meta.url))

// Assembled by concatenation so this file never contains the literal it forbids.
const STUB_SIGNATURE = 'STUB_DEVICE_KEY_' + 'SIGNATURE_PLACEHOLDER_NOT_REAL'
const STUB_PREFIX = 'STUB_'
const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n

const CHECK_NAMES = [
  'structure',
  'structure-device-key',
  'no-stub',
  'digest-binding',
  'normalization',
  'positive',
  'control-spki-rejected',
  'control-altered-digest-rejected',
  'control-stub-signature-rejected',
  'control-other-key-rejected'
]

function die (message) {
  console.error(`[vote-casting-verify] FAIL: ${message}`)
  process.exit(1)
}

function assertDistFresh () {
  const hint = 'vote-engine dist is stale or unbuilt; rebuild it in THIS tree with yarn workspace @votetorrent/vote-engine build'
  const entry = join(DIST_ROOT, 'rn-entry.js')
  if (!existsSync(entry)) die(hint + ' (dist/rn-entry.js missing)')
  const votingSrc = join(SRC_ROOT, 'voting')
  for (const f of readdirSync(votingSrc)) {
    if (!f.endsWith('.ts')) continue
    const base = f.slice(0, -3)
    const d = join(DIST_ROOT, 'voting', base + '.js')
    if (!existsSync(d)) die(hint + ` (dist/voting/${base}.js missing)`)
    if (statSync(join(votingSrc, f)).mtimeMs > statSync(d).mtimeMs) die(hint + ` (voting/${f} is newer than its dist)`)
  }
  const rnSrc = join(SRC_ROOT, 'rn-entry.ts')
  if (existsSync(rnSrc) && statSync(rnSrc).mtimeMs > statSync(entry).mtimeMs) die(hint + ' (rn-entry.ts is newer than dist)')
}

assertDistFresh()
const dist = await import(pathToFileURL(join(DIST_ROOT, 'rn-entry.js')).href)
for (const name of ['verifySigP256', 'voterEntryDigest', 'p256KeyToCompressedHex']) {
  if (typeof dist[name] !== 'function') die(`dist/rn-entry.js does not export ${name}`)
}

/** Strict unpadded base64url decode (a round trip rejects truncated or mangled input). */
function strictBase64url (value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  return bytes.toString('base64url') === value ? bytes : null
}

/**
 * Pure checker. Never throws on sample content: a throw inside a check is that
 * check's failure. Returns the names evaluated, in order, and the failures.
 */
function checkSigned (sample, otherKeyHex) {
  const checks = []
  const failures = []
  const run = (name, fn) => {
    checks.push(name)
    try {
      const r = fn()
      if (r !== true) failures.push({ check: name, detail: typeof r === 'string' ? r : 'check returned false' })
    } catch (e) {
      failures.push({ check: name, detail: `threw ${e && e.name ? e.name : 'Error'}` })
    }
  }
  const s = sample ?? {}
  const voter = s.voter
  run('structure', () => {
    if (s === null || typeof s !== 'object') return 'sample is not an object'
    if (Object.keys(s).sort().join(',') !== 'deviceKey,digest,rawKey,signature,v,voter') return 'members are not exactly v,digest,signature,deviceKey,rawKey,voter'
    if (s.v !== 1) return 'v !== 1'
    const d = strictBase64url(s.digest)
    if (!d || s.digest.length !== 43 || d.length !== 32) return 'digest is not a 43-char base64url of 32 bytes'
    if (typeof s.signature !== 'string' || !/^[0-9a-f]{128}$/.test(s.signature)) return 'signature is not 128 lowercase hex'
    if (voter === null || typeof voter !== 'object' || Array.isArray(voter)) return 'voter is not a plain object'
    return true
  })
  run('structure-device-key', () => {
    if (typeof s.deviceKey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(s.deviceKey)) return `deviceKey is not normalized compressed hex (len ${String(s.deviceKey).length})`
    if (voter.deviceKey !== s.deviceKey) return 'voter.deviceKey differs from deviceKey'
    return true
  })
  run('no-stub', () => {
    for (const v of [s.signature, s.deviceKey, s.rawKey, voter && voter.deviceKey]) {
      if (typeof v === 'string' && v.includes(STUB_PREFIX)) return 'a stub token is present'
    }
    return true
  })
  run('digest-binding', () => dist.voterEntryDigest(voter) === s.digest || 'recomputed voterEntryDigest(voter) differs from the logged digest')
  run('normalization', () => dist.p256KeyToCompressedHex(s.rawKey) === s.deviceKey || 'p256KeyToCompressedHex(rawKey) differs from deviceKey')
  run('positive', () => dist.verifySigP256(s.digest, s.signature, s.deviceKey) === true || 'verifySigP256(digest, signature, deviceKey) is false')
  run('control-spki-rejected', () => {
    if (typeof s.rawKey !== 'string' || /^0[23][0-9a-f]{64}$/.test(s.rawKey)) return 'rawKey is already compressed hex: the control would be vacuous'
    return dist.verifySigP256(s.digest, s.signature, s.rawKey) === false || 'verifySigP256 ACCEPTED the raw SPKI form'
  })
  run('control-altered-digest-rejected', () => {
    const bytes = Buffer.from(strictBase64url(s.digest))
    bytes[0] ^= 0x01
    const altered = bytes.toString('base64url')
    if (altered === s.digest) return 'altered digest equals the original'
    return dist.verifySigP256(altered, s.signature, s.deviceKey) === false || 'verifySigP256 ACCEPTED an altered digest'
  })
  run('control-stub-signature-rejected', () => dist.verifySigP256(s.digest, STUB_SIGNATURE, s.deviceKey) === false || 'verifySigP256 ACCEPTED the stub signature placeholder')
  run('control-other-key-rejected', () => dist.verifySigP256(s.digest, s.signature, otherKeyHex) === false || 'verifySigP256 ACCEPTED another key')
  return { ok: failures.length === 0, checks, failures }
}

function freshKey () {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const jwk = publicKey.export({ format: 'jwk' })
  const x = Buffer.from(jwk.x, 'base64url')
  const xPadded = Buffer.concat([Buffer.alloc(32 - x.length), x])
  const y = Buffer.from(jwk.y, 'base64url')
  const compressedHex = ((y[y.length - 1] & 1) === 0 ? '02' : '03') + xPadded.toString('hex')
  return { privateKey, spkiB64, compressedHex }
}

function signLowS (privateKey, digestBytes) {
  const sig = sign('sha256', digestBytes, { key: privateKey, dsaEncoding: 'ieee-p1363' })
  const r = BigInt('0x' + sig.subarray(0, 32).toString('hex'))
  let s = BigInt('0x' + sig.subarray(32).toString('hex'))
  if (s > P256_N / 2n) s = P256_N - s
  return r.toString(16).padStart(64, '0') + s.toString(16).padStart(64, '0')
}

function buildSample (key) {
  const voter = {
    v: 1,
    electionId: 'selftest-election',
    electionRevision: 1,
    registrantId: 'selftest-registrant',
    privateCid: 'selftest-private',
    publicCid: null,
    deviceKey: key.compressedHex,
    attestationCid: null,
    ballots: [{ ballotId: 'b-1', templateDigest: randomBytes(32).toString('base64url') }]
  }
  const digest = dist.voterEntryDigest(voter)
  const signature = signLowS(key.privateKey, Buffer.from(digest, 'base64url'))
  return { v: 1, digest, signature, deviceKey: key.compressedHex, rawKey: key.spkiB64, voter }
}

function selftest () {
  const key = freshKey()
  const other = freshKey()
  const good = buildSample(key)
  const rawLen = Buffer.from(good.rawKey, 'base64').length
  if (rawLen !== 91) die(`selftest key is not the 91-byte SPKI form (got ${rawLen})`)

  const pos = checkSigned(good, other.compressedHex)
  if (!pos.ok) die(`selftest POSITIVE failed: ${JSON.stringify(pos.failures)}. Do not weaken a check; confirm the digest-byte contract (Android signs the 32 digest bytes with SHA256withECDSA == crypto.sign('sha256', digestBytes)).`)
  if (JSON.stringify(pos.checks) !== JSON.stringify(CHECK_NAMES)) die('selftest: check list incomplete: ' + JSON.stringify(pos.checks))
  console.log(`[vote-casting-verify] selftest POSITIVE: all ${pos.checks.length} named checks passed`)

  const n1 = { ...good, signature: signLowS(other.privateKey, Buffer.from(good.digest, 'base64url')) }
  const n2 = { ...good, deviceKey: key.spkiB64, voter: { ...good.voter, deviceKey: key.spkiB64 } }
  const n3 = { ...good, signature: STUB_SIGNATURE }
  const n4 = { ...good, digest: Buffer.from(good.digest, 'base64url').map((b, i) => (i === 31 ? b ^ 1 : b)).toString('base64url') }
  const n5 = { ...good, rawKey: other.spkiB64 }
  const negatives = [
    ['N1', n1, 'positive'],
    ['N2', n2, 'structure-device-key'],
    ['N3', n3, 'no-stub'],
    ['N4', n4, 'digest-binding'],
    ['N5', n5, 'normalization']
  ]
  for (const [id, sample, expected] of negatives) {
    const r = checkSigned(sample, other.compressedHex)
    if (r.ok) die(`selftest NEGATIVE ${id} was ACCEPTED`)
    if (!r.failures.some(f => f.check === expected)) die(`selftest NEGATIVE ${id} was not rejected by ${expected}: ${JSON.stringify(r.failures.map(f => f.check))}`)
    console.log(`[vote-casting-verify] selftest NEGATIVE ${id}: rejected by ${expected}`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'vcv-selftest-'))
  try {
    const goodPath = join(dir, 'good.json')
    const badPath = join(dir, 'bad.json')
    writeFileSync(goodPath, JSON.stringify(good))
    writeFileSync(badPath, JSON.stringify(n1))
    const env = { ...process.env, FORCE_COLOR: '0' }
    const g = spawnSync(process.execPath, [SELF, '--signed', goodPath], { env })
    if (g.status !== 0) die(`selftest CLI: good file exited ${g.status}`)
    const b = spawnSync(process.execPath, [SELF, '--signed', badPath], { env })
    if (b.status !== 1) die(`selftest CLI: bad file exited ${b.status}, expected 1`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('[vote-casting-verify] selftest OK (positive + 5 negatives + CLI exit codes)')
}

function main () {
  const args = process.argv.slice(2)
  if (args[0] === '--selftest' && args.length === 1) {
    selftest()
    return
  }
  if (args[0] === '--signed' && args.length === 2) {
    const file = args[1]
    if (!isAbsolute(file)) die('--signed requires an absolute path')
    let sample
    try {
      sample = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      die('signed.json is not parseable JSON: was the logcat line truncated?')
    }
    const other = freshKey()
    const r = checkSigned(sample, other.compressedHex)
    for (const name of r.checks) {
      const f = r.failures.find(x => x.check === name)
      console.log(`CHECK ${name}: ${f ? 'FAIL ' + f.detail : 'PASS'}`)
    }
    if (!r.ok) {
      console.error(`[vote-casting-verify] FAIL: ${r.failures.map(f => f.check).join(', ')}`)
      process.exit(1)
    }
    console.log('[vote-casting-verify] OK')
    return
  }
  console.error('usage: vote-casting-verify.mjs --signed <abs-file> | --selftest')
  process.exit(1)
}

main()
