// A device daemon: one long-lived process per app instance, holding the device's CadreNode and
// engines the way a running app does. `vt daemon start` spawns it; every other `vt` command is an
// RPC to it. State that the app keeps in AsyncStorage is mirrored to `<home>/local.json`; the
// strand and control databases are in memory and live as long as the daemon.

import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_FILE, serveRpc } from './rpc.mjs'
import { Device } from './device.mjs'
import { VE } from './engine.mjs'
import * as common from './workflows/common.mjs'
import * as authority from './workflows/authority.mjs'
import * as voter from './workflows/voter.mjs'

const opts = JSON.parse(process.argv[2])
const logFile = join(opts.home, 'daemon.log')
const log = (msg) => appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`)
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e?.stack ?? e}`))
process.on('uncaughtException', (e) => log(`uncaughtException: ${e?.stack ?? e}`))

const device = new Device({ ...opts, log })
await device.start()
log(`started ${opts.role} (${opts.profile}) peer ${device.node.peerId.toString()} on ${device.addresses().join(' ')}`)

if (opts.role === 'authority') {
  // pool-rendezvous-host.ts: every Authority node relays pool envelopes for its cadre's members.
  const rv = new VE.PoolRendezvous({
    isAllowed: async (peer) => peer === device.node.peerId.toString() || (await device.node.isAuthorizedMember(peer)) === true
  })
  await VE.attachPoolRendezvous(device.node.getControlNode(), rv)
  device.rendezvous = rv
}

let server
async function shutdown () {
  log('stopping')
  try { rmSync(join(opts.home, DAEMON_FILE), { force: true }) } catch { /* gone */ }
  await device.stop()
  server?.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const bind = (fn) => (params) => fn(device, params)
const shared = {
  'status': bind(common.statusWorkflow),
  'network.show': bind(common.networkShowWorkflow),
  'network.join': bind(common.joinNetworkWorkflow),
  'daemon.stop': async () => { setTimeout(shutdown, 50); return { stopping: true } }
}
const authorityHandlers = {
  'network.create': bind(authority.createNetwork),
  'network.revise': bind(authority.reviseNetwork),
  'network.join-code': bind(authority.mintJoinCode),
  'officer.invite': bind(authority.inviteOfficer),
  'invite.accept': bind(authority.respondToInvite),
  'admin.show': bind(authority.adminShow),
  'admin.set-scopes': bind(authority.adminSetScopes),
  'intake-key.register': bind(authority.registerIntakeKey),
  'election.create': bind(authority.createElection),
  'election.list': bind(authority.listElections),
  'election.show': bind(authority.showElection),
  'election.results': bind(authority.electionResults),
  'ballot.propose': bind(authority.proposeBallot),
  'ballot.submit': bind(authority.submitBallot),
  'ballot.confirm': bind(authority.confirmBallot),
  'tasks.list': bind(authority.listTasks),
  'tasks.sign': bind(authority.signTask),
  'registration.field-add': bind(authority.addRegistrationField),
  'registration.sync': bind(authority.syncRegistrations),
  'registration.list': bind(authority.listRegistrationRequests),
  'registration.approve': bind(authority.approveRegistration),
  'registration.reject': bind(authority.rejectRegistration),
  'registrants.list': bind(authority.listRegistrants),
  'keyholder.invite': bind(authority.inviteKeyholder),
  'keyholder.accept': bind(authority.acceptKeyholderInvite),
  'keyholder.status': bind(authority.dkgStatus),
  'keyholder.dkg': bind(authority.advanceDkg),
  'keys.release': bind(authority.releaseKey)
}
const voterHandlers = {
  'election.list': bind(authority.listElections),
  'election.show': bind(voter.voterElection),
  'ballot.show': bind(voter.voterBallot),
  'register': bind(voter.register),
  'registration.status': bind(voter.registrationStatus),
  'vote.cast': bind(voter.castVote),
  'vote.receipt': bind(voter.voteReceipt),
  'vote.send': bind(voter.sendVote)
}

/** Log every command with its outcome and duration. */
function logged (handlers) {
  return Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (params) => {
    const started = performance.now()
    try {
      const result = await fn(params)
      log(`${name} ok ${Math.round(performance.now() - started)}ms`)
      return result
    } catch (e) {
      log(`${name} FAILED ${Math.round(performance.now() - started)}ms ${e?.code ?? e?.name}: ${e?.message}\n${e?.stack ?? ''}`)
      throw e
    }
  }]))
}

server = serveRpc(logged({ ...shared, ...(opts.role === 'authority' ? authorityHandlers : voterHandlers) }), {
  onListening: (port) => {
    writeFileSync(join(opts.home, DAEMON_FILE), JSON.stringify({ pid: process.pid, port, role: opts.role, profile: opts.profile, peerId: device.node.peerId.toString(), addresses: device.addresses() }, null, 2))
    log(`rpc on 127.0.0.1:${port}`)
  }
})
