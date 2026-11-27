// voter-request-compose.spec.ts: plain-Node proof of the moved Voter request-transport source and the
// registration-status read (phase 67 plan 30). A scripted strand port stands in for the joined network's
// database, the REST factory is injected and recorded, and fake engines drive the four status outcomes
// and the two injected error-log calls.
import { expect } from 'chai'
import { P2pAssociationTransport, P2pRegistrationTransport } from '@votetorrent/vote-engine/rn'
import {
  createVoterRequestTransportSource,
  resolveRegistrationStatus,
  type RegistrationStatusDeps,
  type VoterRegistrationRequestTransport,
  type VoterRequestTransportLookup,
  type VoterStrandPort
} from '../../src/voter/reads.js'

const STRAND_ID = 'ab'.repeat(16)
const AUTHORITY_ID = 'auth-1'
const KEY = '02' + 'cd'.repeat(32)

interface ScriptedPort extends VoterStrandPort {
  readonly queries: Array<{ sql: string, params: Record<string, unknown> }>
  mutates: number
}

function scriptedPort (restBridgeUrl: string | null): ScriptedPort {
  const queries: Array<{ sql: string, params: Record<string, unknown> }> = []
  const port: ScriptedPort = {
    queries,
    mutates: 0,
    query: async <T>(sql: string, params: Record<string, unknown>): Promise<T[]> => {
      queries.push({ sql, params })
      if (sql.includes('from AuthorityIntakePolicy')) {
        return restBridgeUrl === null ? [] : [{ Revision: 1, RestBridgeUrl: restBridgeUrl, ReassociationMode: 'manual', SetAt: null } as T]
      }
      if (sql.includes('from AssociationRequestStaging')) return [{ RequestId: 'assoc-1' } as T]
      if (sql.includes('from RegistrationRequestStaging')) return [{ RequestId: 'reg-1' } as T]
      return []
    },
    mutate: async () => {
      port.mutates++
    },
    close: async () => undefined
  }
  return port
}

function restFactory (): { calls: Array<{ baseUrl: string }>, create: (o: { baseUrl: string }) => VoterRegistrationRequestTransport } {
  const calls: Array<{ baseUrl: string }> = []
  const transport: VoterRegistrationRequestTransport = {
    submitRequest: async () => 'rest-id',
    pollDecisions: async () => []
  }
  return { calls, create: (o) => { calls.push(o); return transport } }
}

async function rejection (p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

interface StatusRig {
  engineCalls: string[]
  logged: Array<{ where: string, err: unknown }>
  deps: RegistrationStatusDeps
}

function statusRig (over: {
  keyAbsent?: boolean
  detailsThrow?: unknown
  associations?: unknown[]
  requests?: unknown[]
  lookup?: VoterRequestTransportLookup
} = {}): StatusRig {
  const engineCalls: string[] = []
  const logged: Array<{ where: string, err: unknown }> = []
  const engines: Record<string, unknown> = {
    network: {
      getDetails: async () => {
        if (over.detailsThrow !== undefined) throw over.detailsThrow
        return { network: { name: 'Salt Lake County Unified School District Network', primaryAuthorityId: AUTHORITY_ID } }
      }
    },
    association: {
      getAssociationsByDeviceKey: async () => over.associations ?? [],
      listAssociationRequestsByDeviceKey: async () => over.requests ?? []
    },
    registration: { getRegistrant: async () => undefined }
  }
  const deps: RegistrationStatusDeps = {
    getEngine: async <T>(name: string): Promise<T> => {
      engineCalls.push(name)
      return engines[name] as T
    },
    getCurrentDeviceKey: async () => {
      if (over.keyAbsent === true) throw Object.assign(new Error('absent'), { code: 'DEVICE_KEY_ABSENT' })
      return { publicKey: KEY }
    },
    resolveTransports: over.lookup ?? (async () => undefined),
    logError: (where, err) => { logged.push({ where, err }) },
    electionId: 'election-1'
  }
  return { engineCalls, logged, deps }
}

describe('voter request compose', () => {
  it('X1 peerBacked false resolves undefined with zero port reads', async () => {
    const port = scriptedPort(null)
    const rest = restFactory()
    const source = createVoterRequestTransportSource({ strandId: STRAND_ID, port, peerBacked: false }, { createRestRegistrationTransport: rest.create })
    expect(await source.resolve(AUTHORITY_ID)).to.equal(undefined)
    expect(port.queries).to.deep.equal([])
    expect(rest.calls).to.deep.equal([])
  })

  it('X2 a peer policy gives route peer, P2P registration and association transports, and the own-id listers query the port', async () => {
    const port = scriptedPort(null)
    const rest = restFactory()
    const source = createVoterRequestTransportSource({ strandId: STRAND_ID, port, peerBacked: true }, { createRestRegistrationTransport: rest.create })
    const t = await source.resolve(AUTHORITY_ID)
    expect(t).to.not.equal(undefined)
    expect(t!.registrationRoute).to.equal('peer')
    expect(t!.registrationTransport).to.be.instanceOf(P2pRegistrationTransport)
    expect(t!.associationTransport).to.be.instanceOf(P2pAssociationTransport)
    expect(rest.calls).to.deep.equal([])
    expect(await t!.ownAssociationRequestIds(KEY)).to.deep.equal(['assoc-1'])
    expect(await t!.ownStagedRegistrationRequestIds(KEY)).to.deep.equal(['reg-1'])
    const own = port.queries.filter((q) => q.sql.includes('RequestStaging'))
    expect(own).to.have.length(2)
    for (const q of own) expect(q.params).to.deep.equal({ strandId: STRAND_ID, requesterKey: KEY })
    expect(port.queries.filter((q) => q.sql.includes('from AuthorityIntakePolicy'))).to.have.length(1)
    expect(port.mutates).to.equal(0)
  })

  it('X3 a valid REST URL calls the injected factory once with that baseUrl and gives route rest-bridge', async () => {
    const port = scriptedPort('https://bridge.example.org/intake')
    const rest = restFactory()
    const source = createVoterRequestTransportSource({ strandId: STRAND_ID, port, peerBacked: true }, { createRestRegistrationTransport: rest.create })
    const t = await source.resolve(AUTHORITY_ID)
    expect(t!.registrationRoute).to.equal('rest-bridge')
    expect(rest.calls).to.deep.equal([{ baseUrl: 'https://bridge.example.org/intake' }])
    expect(t!.associationTransport).to.be.instanceOf(P2pAssociationTransport)
    expect(t!.registrationTransport).to.not.be.instanceOf(P2pRegistrationTransport)
    // the own-id lister is wired on the REST route too (D-45)
    expect(await t!.ownStagedRegistrationRequestIds(KEY)).to.deep.equal(['reg-1'])
  })

  it('X4 missing options throw TypeError before anything is read', async () => {
    const port = scriptedPort(null)
    const strand = { strandId: STRAND_ID, port, peerBacked: true }
    expect(() => createVoterRequestTransportSource(strand, undefined as never)).to.throw(TypeError)
    expect(() => createVoterRequestTransportSource(strand, {} as never)).to.throw(TypeError)
    expect(port.queries).to.deep.equal([])
  })

  it('RS1 a DEVICE_KEY_ABSENT rejection gives notRegistered with no engine call after the network name', async () => {
    const r = statusRig({ keyAbsent: true })
    const result = await resolveRegistrationStatus(r.deps)
    expect(result).to.deep.equal({ kind: 'notRegistered', networkName: 'Salt Lake County Unified School District Network' })
    expect(r.engineCalls).to.deep.equal(['network'])
    expect(r.logged).to.deep.equal([])
    const err = await rejection(() => resolveRegistrationStatus({ getEngine: r.deps.getEngine } as never))
    expect(err).to.be.instanceOf(TypeError)
  })

  it('RS2 a failing corroboration leg logs the fixed where text and still gives notRegistered; an outer failure gives indeterminate with a second log, errors passed through by identity', async () => {
    const legError = new Error('SECRET-MARKER leg failure')
    const leg = statusRig({ lookup: async () => { throw legError } })
    const result = await resolveRegistrationStatus(leg.deps)
    expect(result.kind).to.equal('notRegistered')
    expect(leg.logged).to.have.length(1)
    expect(leg.logged[0]!.where).to.equal('resolveRegistrationStatus: transport corroboration leg failed:')
    expect(leg.logged[0]!.err).to.equal(legError)
    expect(JSON.stringify(result)).to.not.include('SECRET-MARKER')

    const outerError = new Error('SECRET-MARKER db gone')
    const outer = statusRig({ detailsThrow: outerError })
    const second = await resolveRegistrationStatus(outer.deps)
    expect(second.kind).to.equal('indeterminate')
    expect(second.networkName).to.equal(undefined)
    expect(outer.logged).to.have.length(1)
    expect(outer.logged[0]!.where).to.equal('resolveRegistrationStatus: read failed:')
    expect(outer.logged[0]!.err).to.equal(outerError)
    expect(JSON.stringify(second)).to.not.include('SECRET-MARKER')

    // a pending own notice through the injected lookup
    const pending = statusRig({ lookup: async () => ({ ownAssociationRequestIds: async () => ['x'], associationTransport: { pollDecisions: async () => [{ requestId: 'x', status: 'c', cursor: '1' }] } } as never) })
    expect((await resolveRegistrationStatus(pending.deps)).kind).to.equal('pending')
    expect(pending.logged).to.deep.equal([])
  })
})
