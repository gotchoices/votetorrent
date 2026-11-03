// hr5-open.ts - THE OPENER (plan 64-62 interfaces B; the hand-off of 64-63 interfaces A3).
// Every node and every network of part 1 is built here, so part 2 (64-63) opens the same stores with the same
// strand factory and the same sAppConfig (Optimystic#36). On import it registers hr5-hooks.mjs if that is not done yet,
// then loads the shipped Authority modules by absolute URL. Exports: buildRoleNode, roleNetworksEngine, openRoleNetwork.
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileKv } from './file-kv.mjs'
import { CADRE_STORE_SCOPE, JOINED_KEY, JOIN_BOOTSTRAP_KEY, type Role, safeScope, roleDir, asyncStorageFile, readParty, loadUser, roleLocalStorage, slot } from './hr5-lib.ts'

await import('./register-hr5-hooks.mjs')

const noop: any = () => {}
noop.skip = noop
for (const k of ['describe', 'it', 'before', 'after', 'beforeEach', 'afterEach']) (globalThis as any)[k] ??= noop

const REPO = new URL('../../../', import.meta.url)
const AUTH = (p: string): string => new URL('apps/VoteTorrentAuthority/src/' + p, REPO).href

const cadre: any = await import('@serfab/cadre-core')
const { FileRawStorage }: any = await import('@optimystic/db-p2p-storage-fs')
const { webSockets }: any = await import('@libp2p/websockets')
const { circuitRelayTransport }: any = await import('@libp2p/circuit-relay-v2')
const { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf }: any = await import('@libp2p/crypto/keys')
const { peerIdFromPrivateKey }: any = await import('@libp2p/peer-id')
const rnEntry: any = await import('@votetorrent/vote-engine/rn')
const founderIntent: any = await import(AUTH('engines/founder-intent.ts'))
const rnDbFactory: any = await import(AUTH('engines/rn-db-factory.ts'))
const identityOwner: any = await import(AUTH('engines/identity-owner-key.ts'))
const joinBootstrap: any = await import(AUTH('engines/join-bootstrap.ts'))

async function peerKey (dir: string): Promise<any> {
  const f = join(dir, 'peer-key.json')
  if (existsSync(f)) return privateKeyFromProtobuf(Buffer.from(JSON.parse(readFileSync(f, 'utf8')).k, 'base64'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = await generateKeyPair('Ed25519')
  writeFileSync(f, JSON.stringify({ k: Buffer.from(privateKeyToProtobuf(key)).toString('base64') }), { mode: 0o600 })
  return key
}

export async function buildRoleNode (stateDir: string, role: Role, relayAddr: string): Promise<{
  node: any
  peerId: string
  isolated: Set<string>
  dialRefused: Set<string>
  destroyScope: (scopeId: string) => Promise<void>
  closeStores: () => Promise<void>
}> {
  const asyncFile = asyncStorageFile(stateDir, role)
  const envFile = process.env.HR5_ASYNC_STORAGE_FILE
  if (envFile && envFile !== asyncFile) throw new Error(`buildRoleNode: HR5_ASYNC_STORAGE_FILE names another role's file (role ${role})`)
  const dir = roleDir(stateDir, role)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const partyId: string = readParty(stateDir).partyId
  const privateKey = await peerKey(dir)
  const peerId: string = peerIdFromPrivateKey(privateKey).toString()
  writeFileSync(join(dir, 'peer-id.txt'), peerId + '\n', { mode: 0o600 })

  const asyncKv = fileKv(asyncFile)
  const trustedOwnerStore = await cadre.PersistentTrustedOwnerStore.open(slot(asyncKv, `@votetorrent/trustedOwners/${CADRE_STORE_SCOPE}/${partyId}`), partyId)
  const strandNetworkStateStore = await cadre.PersistentStrandNetworkStateStore.open(slot(asyncKv, `@votetorrent/strandNetworkState/${CADRE_STORE_SCOPE}/${partyId}`), partyId)

  // One FileRawStorage per scope (the scope dir is `store/scope-<id with non-alphanumerics replaced>`).
  const stores = new Map<string, any>()
  const scopeDir = (scope: string): string => join(dir, 'store', `scope-${safeScope(scope)}`)
  const provider = (scope: string): any => {
    let s = stores.get(scope)
    if (!s) {
      mkdirSync(scopeDir(scope), { recursive: true, mode: 0o700 })
      s = new FileRawStorage(scopeDir(scope))
      stores.set(scope, s)
    }
    return s
  }
  const destroyScope = async (scopeId: string): Promise<void> => {
    // close first: FileRawStorage shares its write log per directory, so a store removed from under a live instance poisons the next one
    try { await stores.get(scopeId)?.close?.() } catch { /* best effort */ }
    stores.delete(scopeId)
    rmSync(scopeDir(scopeId), { recursive: true, force: true })
  }

  // After node.stop(): flush and release every scope's store (removes its store.lock). The product never calls this; part 1 does so the
  // persisted state is CLOSED for 64-63.
  const closeStores = async (): Promise<void> => {
    for (const s of [...stores.values()]) { try { await s.close?.() } catch { /* best effort */ } }
    stores.clear()
  }

  const isolated = new Set<string>()
  const dialRefused = new Set<string>()
  const id = (p: any): string => String(p?.toString?.() ?? p)
  const joinAddrs: string[] = joinBootstrap.sanitizeJoinBootstrap(((): unknown => {
    try { const raw = asyncKv.get(JOIN_BOOTSTRAP_KEY); return typeof raw === 'string' ? JSON.parse(raw) : [] } catch { return [] }
  })())
  const bootstrapNodes = [...new Set([relayAddr, ...joinAddrs])]

  const node = identityOwner.withIdentityOwnerKey(new cadre.CadreNode({
    privateKey,
    controlNetwork: { partyId, bootstrapNodes },
    strandNetworkState: { store: strandNetworkStateStore },
    trustedOwners: { store: trustedOwnerStore },
    profile: 'transaction',
    requireSignedSchemas: false,
    strandFilter: { mode: 'all' },
    storage: { provider },
    network: {
      controlCohort: { strandAddrRefreshMs: 30_000 },
      transports: [webSockets(), circuitRelayTransport({ reservationConcurrency: 1 })],
      relayAddrs: [relayAddr],
      requireRelay: false,
      connectionGater: {
        denyDialMultiaddr: async () => false,
        denyDialPeer: async (p: any) => isolated.has(id(p)) || dialRefused.has(id(p)),
        denyInboundEncryptedConnection: async (p: any) => isolated.has(id(p)),
        denyOutboundEncryptedConnection: async (p: any) => isolated.has(id(p)) || dialRefused.has(id(p))
      }
    },
    hibernation: { enabled: false }
  } as any), privateKey)
  return { node, peerId, isolated, dialRefused, destroyScope, closeStores }
}

export function roleNetworksEngine (node: any, stateDir: string, role: Role, opts?: { wrapDbFactory?: (f: any) => any }): any {
  const asyncKv = fileKv(asyncStorageFile(stateDir, role))
  const isJoinedNetwork = async (hash: string): Promise<boolean> => {
    const raw = asyncKv.get(JOINED_KEY)
    if (raw === undefined || raw === null) return false
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new founderIntent.JoinedNetworksUnreadableError()
    return parsed.includes(hash)
  }
  let factory = rnDbFactory.createStrandDbFactory(node, { isJoinedNetwork })
  if (opts?.wrapDbFactory) factory = opts.wrapDbFactory(factory)
  const engine = new rnEntry.NetworksEngine(roleLocalStorage(stateDir, role), factory)
  return founderIntent.wrapCreateWithFounding(engine)
}

export async function openRoleNetwork (node: any, stateDir: string, role: Role, networkHash: string, opts?: { wrapDbFactory?: (f: any) => any }): Promise<{ networksEngine: any, ctx: any }> {
  const networksEngine = roleNetworksEngine(node, stateDir, role, opts)
  const recents: any[] = (await roleLocalStorage(stateDir, role).getItem('recentNetworks')) ?? []
  const ref = recents.find((r) => r.hash === networkHash)
  if (!ref) throw new Error('openRoleNetwork: the network is not in this role\'s recent networks')
  const user = loadUser(stateDir, role)
  await networksEngine.open(ref, user)
  return { networksEngine, ctx: networksEngine.getEstablishedContext(networkHash) }
}

