// One VoteTorrent device: what a phone running the Authority or Voter app holds, rebuilt for
// Node. The RN-only seams are replaced one for one:
//
//   AsyncStorage (LocalStorageReact)      -> FileLocalStorage (JSON file in the device home)
//   Keystore secp256k1 identity signer    -> software secp256k1 key in identity.json
//   Keystore/TEE P-256 voting key         -> software P-256 key in identity.json (voter)
//   native-wrapped IKeyVault              -> MemoryKeyVault (process memory)
//   rn-leveldb strand + control storage   -> @optimystic/db-p2p MemoryRawStorage
//   AsyncStorage DurableSlot              -> JSON file slot in the device home
//
// Everything above the seams — NetworksEngine, the strand DbFactory semantics, the engine set —
// is the shipped vote-engine and cadre-core code.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { VE, VC, VOTETORRENT_INNER_DDL, SAPP_ID, declareViewsInMain } from './engine.mjs'

const cadre = await import('@serfab/cadre-core')
const { CadreNode, PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } = cadre
const { MemoryRawStorage } = await import('@optimystic/db-p2p')
const { webSockets } = await import('@libp2p/websockets')
const { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } = await import('@libp2p/crypto/keys')

export const PARTY_ID = 'votetorrent'

// ---------------------------------------------------------------------------------------------
// Local storage and slots
// ---------------------------------------------------------------------------------------------

/** vote-core `LocalStorage` over one JSON file — the AsyncStorage stand-in. */
export class FileLocalStorage {
  constructor (file) {
    this.file = file
    this.map = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : [])
  }

  flush () { writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2)) }
  async getItem (key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined }
  async setItem (key, value) { this.map.set(key, structuredClone(value)); this.flush() }
  async removeItem (key) { this.map.delete(key); this.flush() }
  async clear () { this.map.clear(); this.flush() }
}

/** A cadre-core DurableSlot over a file — the AsyncStorage DurableSlot stand-in. */
function fileSlot (file) {
  return {
    async load () { return existsSync(file) ? readFileSync(file, 'utf8') : undefined },
    async save (text) { writeFileSync(file, text) }
  }
}

/** `IKeyVault` in process memory. The app's vault wraps every secret with a hardware key; this
 * one cannot, which is the one security property the CLI does not reproduce. */
export class MemoryKeyVault {
  constructor () { this.store = new Map() }
  async putSecret (alias, secret) {
    VE.assertKeyVaultAlias(alias)
    if (!(secret instanceof Uint8Array) || secret.length === 0) throw Object.assign(new Error('putSecret: empty secret'), { code: 'invalid-secret' })
    if (this.store.has(alias)) throw Object.assign(new Error(`putSecret: alias '${alias}' already holds a secret`), { name: 'KeyVaultError', code: 'alias-exists' })
    this.store.set(alias, Uint8Array.from(secret))
  }

  async getSecret (alias) { VE.assertKeyVaultAlias(alias); const v = this.store.get(alias); return v ? Uint8Array.from(v) : null }
  async hasSecret (alias) { VE.assertKeyVaultAlias(alias); return this.store.has(alias) }
  async deleteSecret (alias) { VE.assertKeyVaultAlias(alias); return this.store.delete(alias) }
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/** The device's keys, created once and kept in `<home>/identity.json` (mode 0600). */
export async function loadOrCreateIdentity (home, name) {
  const file = join(home, 'identity.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const idPriv = secp256k1.utils.randomSecretKey()
  const votePriv = p256.utils.randomSecretKey()
  const peerKey = await generateKeyPair('Ed25519')
  const identity = {
    v: 1,
    name,
    userId: randomUUID(),
    identityPrivateHex: bytesToHex(idPriv),
    identityPublicHex: bytesToHex(secp256k1.getPublicKey(idPriv, true)),
    votingPrivateHex: bytesToHex(votePriv),
    votingPublicHex: bytesToHex(p256.getPublicKey(votePriv, true)),
    peerKeyB64: Buffer.from(privateKeyToProtobuf(peerKey)).toString('base64'),
    recordWrapKeyHex: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    createdAt: new Date().toISOString()
  }
  writeFileSync(file, JSON.stringify(identity, null, 2))
  chmodSync(file, 0o600)
  return identity
}

/** The device user record `getOrCreateDeviceUser` builds: one mobile secp256k1 key. */
export function deviceUser (identity) {
  return {
    id: identity.userId,
    name: identity.name,
    imageRef: { url: '' },
    activeKeys: [{ key: identity.identityPublicHex, type: VC.UserKeyType.mobile, expiration: Date.now() + 365 * 86_400_000 }]
  }
}

/** `createDeviceSigner`: secp256k1 over the digest bytes, noble's default prehash. */
export function identitySigner (identity) {
  const priv = hexToBytes(identity.identityPrivateHex)
  return async (digest) => ({
    signerUserId: identity.userId,
    signerKey: identity.identityPublicHex,
    signature: bytesToHex(secp256k1.sign(digest, priv))
  })
}

/** The voter's attestation producer: a software P-256 voting key in place of the Keystore key.
 * `produce` returns the dev-build stub attestation (`StubAttestationProducer.produce`), the only
 * attestation an authority running `StubAttestationVerifier` accepts without hardware. */
export function softwareProducer (identity) {
  const priv = hexToBytes(identity.votingPrivateHex)
  const publicKey = identity.votingPublicHex
  return {
    async provisionDeviceKey () { return { publicKey } },
    async getCurrentDeviceKey () { return { publicKey } },
    async signDeviceKeyDigest (digest) {
      return { signature: bytesToHex(p256.sign(digest, priv)), signerKey: publicKey, signerUserId: '' }
    },
    async produce (challenge) {
      return {
        publicKey: challenge.deviceKey,
        deviceId: `CLI_SOFTWARE_DEVICE_${challenge.registrantId}`,
        attestationTime: Date.now(),
        certificateChain: ['CLI_SOFTWARE_KEY_NO_CERTIFICATE'],
        platformDetails: {
          type: 'Android',
          safetyNetAttestation: 'CLI_SOFTWARE_KEY_NO_PLAY_INTEGRITY',
          keystorePublicKey: challenge.deviceKey,
          nonce: challenge.nonce
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------------------------

const relayOnlyAddrs = (addrs) => addrs.filter((a) => a.includes('/p2p-circuit'))

export class Device {
  /**
   * @param {object} opts
   * @param {string} opts.home      device directory
   * @param {'authority'|'voter'} opts.role
   * @param {string} opts.name      display name of the device user
   * @param {'storage'|'transaction'} opts.profile  cadre profile ('storage' listens and serves)
   * @param {string[]} [opts.listen]
   * @param {string[]} [opts.bootstrap]
   */
  constructor (opts) {
    this.opts = opts
    this.home = opts.home
    this.role = opts.role
    this.vault = new MemoryKeyVault()
    this.currentHash = undefined
    this.log = opts.log ?? (() => {})
  }

  async start () {
    mkdirSync(this.home, { recursive: true })
    this.identity = await loadOrCreateIdentity(this.home, this.opts.name)
    this.user = deviceUser(this.identity)
    this.sign = identitySigner(this.identity)
    this.local = new FileLocalStorage(join(this.home, 'local.json'))
    if ((await this.local.getItem('recentNetworks')) === undefined) await this.local.setItem('recentNetworks', [])

    const remembered = (await this.local.getItem('joinBootstrap')) ?? []
    const bootstrapNodes = [...(this.opts.bootstrap ?? []), ...remembered]
    const storage = new MemoryRawStorage()
    const nodeRef = { current: null }
    const transaction = this.opts.profile === 'transaction'
    this.node = new CadreNode({
      privateKey: privateKeyFromProtobuf(Buffer.from(this.identity.peerKeyB64, 'base64')),
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes },
      requireSignedSchemas: false,
      strandFilter: { mode: 'all' },
      storage: { provider: () => storage },
      strandClusterSize: 2,
      hibernation: { enabled: false },
      profile: this.opts.profile,
      trustedOwners: { store: await PersistentTrustedOwnerStore.open(fileSlot(join(this.home, 'trusted-owners.json')), PARTY_ID) },
      bootstrapPeers: { store: await PersistentBootstrapPeerStore.open(fileSlot(join(this.home, 'bootstrap-peers.json')), PARTY_ID) },
      network: {
        transports: [webSockets()],
        listenAddrs: this.opts.listen ?? ['/ip4/127.0.0.1/tcp/0/ws'],
        // The Voter app publishes relay-circuit addresses only (user decision 2026-10-12).
        ...(transaction ? { inviteAddressResolver: async () => relayOnlyAddrs((nodeRef.current?.getMultiaddrs?.() ?? []).map(String)) } : {})
      }
    })
    nodeRef.current = this.node
    // identity-owner-key.ts withIdentityOwnerKey: the node's cadre owner key is derived from its
    // libp2p identity key, so the owner survives restarts with the peer id.
    const identityKey = privateKeyFromProtobuf(Buffer.from(this.identity.peerKeyB64, 'base64'))
    let owner = null
    this.node.getIdentityOwnerKey = () => {
      if (owner === null) {
        const pair = cadre.ed25519KeyPairFromLibp2p(identityKey)
        owner = { publicKeyB64: pair.publicKeyB64, privateKeyB64: pair.privateKeyB64 }
      }
      return owner
    }
    this.node.getIdentityOwnerSigner = () => cadre.softwareOwnerSigner(this.node.getIdentityOwnerKey().privateKeyB64)
    await this.node.start()

    this.networks = new VE.NetworksEngine(this.local, (hash) => this.openStrandDb(hash))
    this.strandDbs = new Map()
    this.foundingIntent = false
  }

  async stop () {
    try { await this.node?.stop() } catch { /* best effort */ }
  }

  addresses () {
    return (this.node.getMultiaddrs?.() ?? []).map(String)
  }

  peerCount () {
    return this.node.getControlNode()?.getConnections().length ?? 0
  }

  async joinedNetworks () {
    return (await this.local.getItem('joinedNetworks')) ?? []
  }

  /**
   * The strand DbFactory both apps install (rn-db-factory.ts createStrandDbFactory): open the
   * network's strand on this node, wait out a first sync, App/main schema path. A network this
   * device founds opens as founder; a joined network NEVER does (`founder: !joined && !hasPeers`).
   */
  openStrandDb (hash) {
    let p = this.strandDbs.get(hash)
    if (p) return p
    p = (async () => {
      const joined = (await this.joinedNetworks()).includes(hash)
      const founder = this.foundingIntent === true || (!joined && this.peerCount() === 0)
      await this.node.addStrand({
        strandRow: { Id: hash, MemberPrivateKey: null, Type: 'o', FounderOwnerKey: null, FounderPeerId: null },
        sAppConfig: { id: SAPP_ID, version: '1.0.0', schema: VOTETORRENT_INNER_DDL, latencyHint: 'interactive' },
        founder,
        ...(founder ? { awaitFirstSync: false } : {})
      }).catch(async (e) => {
        if (!/AwaitingFirstSync/i.test(e?.name ?? '') && !/first sync/i.test(e?.message ?? '')) throw e
      })
      await this.node.whenStrandWritable(hash, { timeoutMs: 120_000 })
      const db = this.node.getStrand(hash).database.getDatabase()
      db.setSchemaPath(['App', 'main'])
      this.log(`strand ${hash.slice(0, 12)}… open (founder=${founder})`)
      return db
    })()
    this.strandDbs.set(hash, p)
    p.catch(() => { if (this.strandDbs.get(hash) === p) this.strandDbs.delete(hash) })
    return p
  }

  /** The established network: what `selectNetwork` leaves the app on. */
  requireNetwork () {
    if (this.currentHash === undefined) throw Object.assign(new Error('no network: create or join one first'), { code: 'no-network' })
    const ctx = this.networks.getEstablishedContext(this.currentHash)
    if (!ctx) throw Object.assign(new Error('network not open in this daemon'), { code: 'no-network' })
    return ctx
  }

  /** `networksEngine.open(ref, user)` + `getEngine('network', ref)`, as `selectNetwork` does. */
  async selectNetwork (hash) {
    const ref = (await this.networks.getRecentNetworks()).find((r) => r.hash === hash)
    if (!ref) throw Object.assign(new Error(`network ${hash} is not a recent network`), { code: 'no-network' })
    this.networkEngine = await this.networks.open(ref, this.user, true, () => this.peerCount())
    this.currentHash = hash
    const ctx = this.networks.getEstablishedContext(hash)
    await declareViewsInMain(ctx.db)
    if (this.role === 'authority') {
      // engine-factory.ts requireEstablishedCtx: the officer's intake opener rides on the context.
      ctx.intakeOpener = new VE.IntakeEngine(ctx).createOpener(this.vault)
    }
    return this.networkEngine
  }

  async restoreNetwork () {
    const recent = await this.networks.getRecentNetworks()
    if (recent[0] && this.networks.getEstablishedContext(recent[0].hash)) await this.selectNetwork(recent[0].hash)
  }

  // ---- the engine set (engine-factory.ts buildEngine) ----

  ctx () { return this.requireNetwork() }
  elections () { return new VE.ElectionsEngine(this.ctx()) }
  async election (electionId) { return await this.elections().openElection(electionId) }
  signing () { return new VE.SigningEngine(this.ctx()) }
  registration () { return new VE.RegistrationEngine(this.ctx()) }
  association () { return new VE.AssociationEngine(this.ctx(), new VE.StubAttestationVerifier()) }
  intake () { return new VE.IntakeEngine(this.ctx()) }
  invitations () { return new VE.InvitationEngine(this.ctx()) }
  signatureTasks () { return new VE.SignatureTasksEngine({ hash: this.currentHash }, this.ctx()) }
  keysTasks () { return new VE.KeysTasksEngine({ hash: this.currentHash }, this.ctx(), { vault: this.vault }) }
  keyholderDkg () { return new VE.KeyholderDkgEngine(this.ctx(), { vault: this.vault }) }
  keyRelease () { return new VE.KeyReleaseEngine(this.ctx()) }
  async authority () {
    const details = await this.networkEngine.getDetails()
    return await this.networkEngine.openAuthority(details.network.primaryAuthorityId)
  }

  /** The `{query, mutate, close}` strand port both apps' strand-port-adapter.ts build. */
  strandPort () {
    const db = this.ctx().db
    return {
      async query (sql, params) {
        const rows = []
        for await (const row of db.eval(sql, params)) rows.push(row)
        return rows
      },
      async mutate (sql, params) { await db.exec(sql, params) },
      async close () {}
    }
  }
}

export async function one (db, sql, params = {}) {
  for await (const row of db.eval(sql, params)) return row
  return undefined
}

export async function all (db, sql, params = {}) {
  const rows = []
  for await (const row of db.eval(sql, params)) rows.push(row)
  return rows
}
