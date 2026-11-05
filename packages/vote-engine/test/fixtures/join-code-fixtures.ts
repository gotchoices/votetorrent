/**
 * join-code-fixtures.ts — phase 64 plan 04: real-encoder inputs for join-code tests.
 *
 * Test-only. Every invitation here is minted by cadre-core's real `encodeCadreInvitation`
 * from random keys that admit nobody to any network. Every random field has a FIXED
 * length, so the code lengths are deterministic.
 */
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodeCadreInvitation, type CadreInvitation } from '@serfab/cadre-core'
import type { NetworkJoinAnchor } from '@votetorrent/vote-core'
import { bytesToBase64url } from '../../src/utils.js'
import { foundingBundleFingerprint } from '../../src/networks/founding-bundle.js'
import {
  CADRE_INVITATION_PREFIX_EXPECTED,
  encodeNetworkJoinCode,
  NETWORK_JOIN_CODE_PREFIX
} from '../../src/networks/join-code.js'
import type { JoinCodeFixture, JoinCodeFixtureName } from './join-code-fixtures.generated.js'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** A 52-char peer id, the length of a real Ed25519 libp2p peer id. */
export function randomPeerId (): string {
  const bytes = randomBytes(44)
  let s = '12D3KooW'
  for (let i = 0; i < 44; i++) s += BASE58[bytes[i]! % BASE58.length]
  return s
}

/** A real Ed25519 public key, 32 raw bytes as unpadded base64url (43 chars). */
export function randomEd25519KeyB64 (): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return bytesToBase64url(new Uint8Array(der.subarray(der.length - 32)))
}

export function relayCircuitAddr (i: number): string {
  return `/ip4/192.168.1.${20 + i}/tcp/4001/ws/p2p/${randomPeerId()}/p2p-circuit/p2p/${randomPeerId()}`
}

const b64 = (n: number): string => bytesToBase64url(new Uint8Array(randomBytes(n)))

/** A cadre invitation in cadre-core's own mint key order. */
export function randomCadreInvitation (opts: { members: number }): CadreInvitation {
  const issuerKey = randomEd25519KeyB64()
  const members: string[] = []
  for (let i = 0; i < opts.members; i++) members.push(relayCircuitAddr(i))
  return {
    v: 1,
    partyId: 'votetorrent',
    invitePrivateKey: b64(32),
    invite: {
      key: randomEd25519KeyB64(),
      peerId: null,
      expiresAt: '2099-12-31T23:59:59.000',
      totalUses: 1000,
      stampId: b64(32),
      issuerKey,
      issuerSig: b64(64)
    },
    ownerKeys: [issuerKey],
    members
  } as unknown as CadreInvitation
}

const hex = (n: number): string => randomBytes(n).toString('hex')

export function randomJoinAnchor (opts: { name?: string } = {}): NetworkJoinAnchor {
  return {
    networkHash: hex(16),
    name: opts.name ?? 'Utah County Elections',
    genesis: {
      userId: randomUUID(),
      signerKey: '02' + hex(32),
      authorityId: randomUUID(),
      adminEffectiveAt: '2026-10-12T10:00:00.000'
    },
    digest: b64(32)
  }
}

/** The real cadre-core mint of an invitation. */
export function mintInvitation (inv: CadreInvitation): string {
  return encodeCadreInvitation(inv)
}

// ---------------------------------------------------------------------------
// Builder and CLI
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const GENERATED_PATH = join(THIS_DIR, 'join-code-fixtures.generated.ts')
const NON_ASCII_NAME = 'Élections — Zürich 選挙 🗳'

function asciiJson (value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

function entry (text: string, anchor: NetworkJoinAnchor, members: number): JoinCodeFixture {
  return {
    text,
    name: anchor.name,
    fingerprint: foundingBundleFingerprint(anchor.digest),
    networkHash: anchor.networkHash,
    members,
    chars: text.length
  }
}

function v2Entry (members: number, name?: string): JoinCodeFixture {
  const anchor = randomJoinAnchor(name === undefined ? {} : { name })
  const mint = mintInvitation(randomCadreInvitation({ members }))
  return entry(encodeNetworkJoinCode({ v: 2, invitation: mint, ...anchor }), anchor, members)
}

export function buildJoinCodeFixtures (): Record<JoinCodeFixtureName, JoinCodeFixture> {
  const legacyAnchor = randomJoinAnchor()
  const legacyMint = mintInvitation(randomCadreInvitation({ members: 1 }))

  // What a cadre-core 1.14 encoder minted: the invitation without its `sereus-invite:1.` prefix,
  // wrapped in the v1 wire form. The current v1 encoder refuses it, so the text is built by hand.
  const oldAnchor = randomJoinAnchor()
  const oldMint = mintInvitation(randomCadreInvitation({ members: 1 }))
  const noPrefix = oldMint.slice(CADRE_INVITATION_PREFIX_EXPECTED.length)
  const oldJson = asciiJson({
    v: 1,
    invitation: noPrefix,
    networkHash: oldAnchor.networkHash,
    name: oldAnchor.name,
    genesis: {
      userId: oldAnchor.genesis.userId,
      signerKey: oldAnchor.genesis.signerKey,
      authorityId: oldAnchor.genesis.authorityId,
      adminEffectiveAt: oldAnchor.genesis.adminEffectiveAt
    },
    digest: oldAnchor.digest
  })
  const oldBytes = new Uint8Array(oldJson.length)
  for (let i = 0; i < oldJson.length; i++) oldBytes[i] = oldJson.charCodeAt(i)

  return {
    'v2-1-member': v2Entry(1),
    'v2-2-members': v2Entry(2),
    'v2-6-members': v2Entry(6),
    'v2-non-ascii-name': v2Entry(1, NON_ASCII_NAME),
    'v1-legacy-1-member': entry(encodeNetworkJoinCode({ v: 1, invitation: legacyMint, ...legacyAnchor }), legacyAnchor, 1),
    'v1-114-no-prefix': entry(NETWORK_JOIN_CODE_PREFIX + bytesToBase64url(oldBytes), oldAnchor, 1)
  }
}

export function renderJoinCodeFixturesModule (fixtures: Record<JoinCodeFixtureName, JoinCodeFixture>): string {
  const cadreVersion = (JSON.parse(readFileSync(join(THIS_DIR, '..', '..', 'node_modules', '@serfab', 'cadre-core', 'package.json'), 'utf8')) as { version: string }).version
  const data = JSON.stringify(fixtures, null, 2).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  return `// GENERATED by test/fixtures/join-code-fixtures.ts --write. Do not edit.
//
// Real join codes: invitations minted by cadre-core ${cadreVersion} \`encodeCadreInvitation\` and wrapped by
// vote-engine's own encoder. Every key is random and admits nobody to any network, so committing the
// text is safe. Imported by app jest through the 64-01 moduleNameMapper
// (@votetorrent/vote-engine/test/fixtures/join-code-fixtures). Pure data, no imports.
//
// Regenerate whenever the wire form changes, from packages/vote-engine:
//   TS_NODE_PROJECT=./tsconfig.test.json node --import ./register-ts-node.mjs --experimental-specifier-resolution=node test/fixtures/join-code-fixtures.ts --write

export type JoinCodeFixtureName = 'v2-1-member' | 'v2-2-members' | 'v2-6-members' | 'v2-non-ascii-name' | 'v1-legacy-1-member' | 'v1-114-no-prefix'

export type JoinCodeFixture = { readonly text: string; readonly name: string; readonly fingerprint: string; readonly networkHash: string; readonly members: number; readonly chars: number }

export const JOIN_CODE_FIXTURES: Readonly<Record<JoinCodeFixtureName, JoinCodeFixture>> = ${data}
`
}

if (process.argv.includes('--write') && process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = buildJoinCodeFixtures()
  writeFileSync(GENERATED_PATH, renderJoinCodeFixturesModule(fixtures))
  for (const [name, f] of Object.entries(fixtures)) console.log(`${name} members=${f.members} chars=${f.chars}`)
}
