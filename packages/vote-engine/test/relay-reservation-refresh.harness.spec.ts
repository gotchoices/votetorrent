/**
 * relay-reservation-refresh.harness.spec.ts — Phase 66.1 gap G-2.
 *
 * Opt-in (`RUN_P2P_HARNESS=1`), real libp2p nodes over loopback TCP. With the flag unset the suite
 * is `describe.skip` and never loads libp2p.
 *
 * THE BUG (66.1-UAT.md G-2 trace): the deployment relay dropped a phone node's circuit reservation
 * while the connection stayed open. The phone kept its reservation record and its `/p2p-circuit`
 * addr, cadre-core's reservation supervisor judges "held" from those local addrs only, so it never
 * re-reserved, and a browser (which reaches phones only through the relay) got NO_RESERVATION.
 *
 * THE FIX (`.yarn/patches/@serfab-cadre-core-npm-1.21.0-votetorrent.patch`, dist/relay-reservation.js):
 * the supervisor re-sends RESERVE to each relay every `refreshMs` (default 5 min, jittered) while
 * a reservation is held. A repeat RESERVE is a refresh at the relay, so it recreates a dropped one.
 *
 * Topology, the smallest that shows it:
 *   relay  : `circuitRelayServer`, no limits (as cadre's party relay).
 *   holder : bare `/p2p-circuit` search listener, relay discovery switched off exactly as cadre's
 *            `withoutRelayDiscovery` does, reservation driven by cadre-core's real
 *            `superviseRelayReservation`. `refreshMs` is the option the patch adds; the specs
 *            shorten it, production leaves the default.
 *   dialer : dials `<relay>/p2p-circuit/p2p/<holder>`, as the Dashboard's browser node does.
 * The drop is made at the relay: `reservationStore.removeReservation(holder)` while every
 * connection stays up.
 *
 * Red/green: RR-1 keeps the refresh out of its window (60 s) and pins the bug (NO_RESERVATION for
 * the whole window while the holder still believes it holds the reservation). RR-2 runs the refresh
 * at 2 s and must recover within one interval. On the unpatched cadre-core RR-2 fails (the option
 * does not exist and nothing re-reserves). RR-3: a refresh failure is logged and retried, never
 * thrown, there is at most one request in flight, and stop() ends the refreshing.
 */

import { expect } from 'chai'
import { describeP2PHarness } from './harness/two-node-strand.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHECK_MS = 200
const PROBE_TIMEOUT_MS = 4000

interface Rig {
  relay: any
  holder: any
  dialer: any
  relayAddr: string
  /** The holder's reservation store (libp2p internal, reached the way cadre-core reaches it). */
  holderStore: any
  /** The relay's server-side reservation store. */
  relayStore: any
}

async function startRig (): Promise<Rig> {
  const { createLibp2p } = await import('libp2p')
  const { tcp } = await import('@libp2p/tcp')
  const { noise } = await import('@chainsafe/libp2p-noise')
  const { yamux } = await import('@chainsafe/libp2p-yamux')
  const { identify } = await import('@libp2p/identify')
  const { circuitRelayServer, circuitRelayTransport } = await import('@libp2p/circuit-relay-v2')

  const base = () => ({
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()]
  })

  // Every node built so far, stopped if a later step throws: a node left running keeps mocha alive.
  const started: any[] = []
  try {
    const relay: any = await createLibp2p({
      ...base(),
      addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      services: {
        identify: identify(),
        relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } })
      }
    } as any)
    started.push(relay)

    // cadre-core's `withoutRelayDiscovery`, inline (it is not exported): the supervisor alone fills
    // the search slot, as on every cadre-built node. The field must exist, or this would be a no-op.
    const relayTransportWithoutDiscovery = (components: any) => {
      const transport = (circuitRelayTransport() as any)(components)
      expect(Object.prototype.hasOwnProperty.call(transport, 'discovery'), 'circuit-relay transport has a discovery field').to.equal(true)
      transport.discovery = undefined
      return transport
    }

    const holder: any = await createLibp2p({
      ...base(),
      transports: [tcp(), relayTransportWithoutDiscovery],
      addresses: { listen: ['/p2p-circuit'] }
    } as any)
    started.push(holder)

    // The dialer keeps libp2p's defaults (discovery on, so it needs identify), like a plain client.
    const dialer: any = await createLibp2p({
      ...base(),
      transports: [tcp(), circuitRelayTransport()],
      services: { identify: identify() }
    } as any)
    started.push(dialer)

    const relayAddr = relay.getMultiaddrs().map((ma: any) => ma.toString()).find((a: string) => a.includes('/tcp/'))
    expect(relayAddr, 'relay tcp addr').to.be.a('string')

    const holderStore = holder.components.transportManager.getTransports()
      .map((t: any) => t.reservationStore).find((s: any) => s != null)
    expect(holderStore, 'holder reservation store').to.not.equal(undefined)
    const relayStore = relay.services.relay.reservationStore
    expect(relayStore, 'relay reservation store').to.not.equal(undefined)

    return { relay, holder, dialer, relayAddr, holderStore, relayStore }
  } catch (err) {
    await Promise.allSettled(started.map(async (node) => node.stop()))
    throw err
  }
}

async function stopRig (rig: Rig | undefined): Promise<void> {
  if (rig === undefined) return
  await Promise.allSettled([rig.dialer.stop(), rig.holder.stop()])
  await rig.relay.stop()
}

/** One dial through the relay to the holder, then hang up so the next probe dials again. */
async function probe (rig: Rig): Promise<'ok' | 'NO_RESERVATION' | string> {
  const { multiaddr } = await import('@multiformats/multiaddr')
  const target = multiaddr(`${rig.relayAddr}/p2p-circuit/p2p/${rig.holder.peerId.toString()}`)
  try {
    await rig.dialer.dial(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await rig.dialer.hangUp(rig.holder.peerId)
    return 'ok'
  } catch (err: any) {
    const text = `${err?.name ?? ''} ${err?.message ?? String(err)}`
    return text.includes('NO_RESERVATION') ? 'NO_RESERVATION' : `error: ${text.slice(0, 200)}`
  }
}

function holderCircuitAddrs (rig: Rig): string[] {
  return rig.holder.getMultiaddrs().map((ma: any) => ma.toString()).filter((a: string) => a.includes('/p2p-circuit'))
}

const sleep = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** Count the holder's addRelay calls and the most that were ever in flight at once. */
function spyAddRelay (store: any, failFirst = 0): { calls: () => number, maxInFlight: () => number, injected: () => number, restore: () => void } {
  const original = store.addRelay.bind(store)
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  let toFail = failFirst
  let injected = 0
  store.addRelay = async (...args: any[]) => {
    calls++
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (toFail > 0) {
        toFail--
        injected++
        await sleep(50)
        throw new Error('injected refresh failure (G-2 spec)')
      }
      return await original(...args)
    } finally {
      inFlight--
    }
  }
  return { calls: () => calls, maxInFlight: () => maxInFlight, injected: () => injected, restore: () => { store.addRelay = original } }
}

/** Reserve through the supervisor and prove the holder is reachable before the drop. */
async function reserveAndProve (rig: Rig, refreshMs: number): Promise<any> {
  const { superviseRelayReservation } = await import('@serfab/cadre-core')
  const supervisor = superviseRelayReservation(rig.holder, [rig.relayAddr], {
    checkMs: CHECK_MS,
    minBackoffMs: CHECK_MS,
    maxBackoffMs: 1000,
    timeoutMs: 5000,
    refreshMs
  } as any)
  await supervisor.firstAttempt
  expect(supervisor.lastError, 'first reservation').to.equal(null)
  expect(holderCircuitAddrs(rig), 'holder circuit addr after reserving').to.have.length.greaterThan(0)
  expect(await probe(rig), 'probe before the drop').to.equal('ok')
  return supervisor
}

/** The relay forgets the holder's reservation; every connection stays open. */
function dropAtRelay (rig: Rig): void {
  rig.relayStore.removeReservation(rig.holder.peerId)
  expect(rig.relayStore.get(rig.holder.peerId), 'relay-side reservation after the drop').to.equal(undefined)
  expect(rig.holder.getConnections(rig.relay.peerId), 'holder-relay connection after the drop').to.have.length.greaterThan(0)
}

describeP2PHarness('G-2: relay reservation refresh (cadre-core supervisor, real libp2p)', function () {
  this.timeout(60_000)

  let rig: Rig | undefined
  let supervisor: any

  afterEach(async () => {
    supervisor?.stop()
    supervisor = undefined
    await stopRig(rig)
    rig = undefined
  })

  it('RR-1 (bug): with no refresh in the window, a relay-side drop stays NO_RESERVATION while the holder still believes it holds the reservation', async () => {
    rig = await startRig()
    supervisor = await reserveAndProve(rig, 60_000)

    const t0 = Date.now()
    dropAtRelay(rig)
    const readings: string[] = []
    while (Date.now() - t0 < 6000) {
      readings.push(await probe(rig))
      await sleep(250)
    }
    const elapsed = Date.now() - t0
    console.log(`      [G-2 RR-1] ${readings.length} probes over ${elapsed} ms (${Math.round(elapsed / CHECK_MS)} liveness checks): ${[...new Set(readings)].join(',')}`)

    expect(readings.every((r) => r === 'NO_RESERVATION'), `every probe NO_RESERVATION: ${readings.join(',')}`).to.equal(true)
    // The stale belief the supervisor trusts: local record, circuit addr and a clean status.
    expect(rig.holderStore.hasReservation(rig.relay.peerId), 'holder still has a local reservation record').to.equal(true)
    expect(holderCircuitAddrs(rig), 'holder still advertises its circuit addr').to.have.length.greaterThan(0)
    expect(supervisor.lastError, 'supervisor reports no error').to.equal(null)
  })

  it('RR-2 (fix): a 2 s refresh re-sends RESERVE and the holder is reachable again within one interval', async () => {
    const refreshMs = 2000
    rig = await startRig()
    supervisor = await reserveAndProve(rig, refreshMs)
    const spy = spyAddRelay(rig.holderStore)
    const expireBefore: bigint = rig.holderStore.getReservation(rig.relay.peerId).expire

    const t0 = Date.now()
    dropAtRelay(rig)
    expect(await probe(rig), 'probe right after the drop').to.equal('NO_RESERVATION')

    // One jittered interval (+10%) plus the check cadence and a probe's round trip.
    const budgetMs = refreshMs * 1.1 + CHECK_MS + 1500
    let recoveredAt: number | null = null
    let reading = ''
    while (Date.now() - t0 < budgetMs + 3000) {
      reading = await probe(rig)
      if (reading === 'ok') { recoveredAt = Date.now() - t0; break }
      await sleep(100)
    }
    console.log(`      [G-2 RR-2] recovered after ${recoveredAt ?? 'never'} ms (budget ${budgetMs} ms, refreshMs ${refreshMs}); addRelay calls ${spy.calls()}, max in flight ${spy.maxInFlight()}`)

    expect(recoveredAt, `recovered (last reading: ${reading})`).to.not.equal(null)
    expect(recoveredAt as number, 'within one refresh interval').to.be.at.most(budgetMs)
    expect(rig.relayStore.get(rig.holder.peerId), 'relay holds the reservation again').to.not.equal(undefined)
    expect(spy.calls(), 'the refresh went through addRelay').to.be.at.least(1)
    expect(spy.maxInFlight(), 'one request in flight at most').to.equal(1)
    expect(rig.holderStore.getReservation(rig.relay.peerId).expire >= expireBefore, 'local record carries the relay\'s fresh expiry').to.equal(true)
    expect(holderCircuitAddrs(rig), 'circuit addr kept through the refresh').to.have.length.greaterThan(0)
    spy.restore()
  })

  it('RR-3: a failed refresh is retried on the next check, never thrown; stop() ends refreshing with no timer left behind', async () => {
    const refreshMs = 500
    rig = await startRig()
    supervisor = await reserveAndProve(rig, refreshMs)
    const spy = spyAddRelay(rig.holderStore, 2)

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const t0 = Date.now()
      dropAtRelay(rig)
      let recoveredAt: number | null = null
      while (Date.now() - t0 < 8000) {
        if (await probe(rig) === 'ok') { recoveredAt = Date.now() - t0; break }
        await sleep(100)
      }
      console.log(`      [G-2 RR-3] injected ${spy.injected()} refresh failures; recovered after ${recoveredAt ?? 'never'} ms; addRelay calls ${spy.calls()}, max in flight ${spy.maxInFlight()}`)
      expect(spy.injected(), 'both injected failures were hit').to.equal(2)
      expect(recoveredAt, 'recovered after the injected failures').to.not.equal(null)
      expect(spy.maxInFlight(), 'one request in flight at most').to.equal(1)

      // Several refresh intervals of steady state, then stop: no further request afterwards.
      await sleep(refreshMs * 3)
      expect(spy.calls(), 'refreshes keep coming while running').to.be.at.least(4)
      supervisor.stop()
      expect(supervisor.retryAtMs, 'no tick scheduled after stop').to.equal(null)
      const callsAtStop = spy.calls()
      await sleep(refreshMs * 4)
      expect(spy.calls(), 'no refresh after stop').to.equal(callsAtStop)
      expect(unhandled, 'no unhandled rejection').to.deep.equal([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      spy.restore()
    }
  })
})
