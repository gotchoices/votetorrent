// The role daemon (the daemon half of the lean rig's peer driver, over the 67-12 ctl server): output
// redaction first, the relay env, one booted peer per colocated label (each with its own dir, lock,
// kv files, device vault, node and crash recorder), one ctl server per peer with its own token and
// `ctl.port` written LAST (primary last of all), SIGTERM/SIGINT and max-runtime shutdown. It touches
// only its own labels' peer dirs and the relay env file. Loaded by start-command.ts through ONE dynamic
// import, after the daemon env is applied, because this module (through the node builder) pulls in
// cadre-core, libp2p and the `debug` package.

import { join } from 'node:path'
import { EXIT, type ExitCode } from '../cli/exit-codes.js'
import { readCtlToken } from '../ctl/ctl-files.js'
import { startCtlServer, type CtlServerHandle } from '../ctl/ctl-server.js'
import type { Role } from '../ctl/protocol.js'
import { RelayEnvError, readRelayEnv } from '../relay/relay-env.js'
import { relayIsPrivate } from '../run/secret-scan.js'
import { SecretRegistry } from '../secrecy/redact.js'
import { writePrivateFileAtomic } from '../vault/private-file.js'
import { PEER_FILES } from '../node/peer-layout.js'
import { relayPeerIdOf } from '../node/relay-readiness.js'
import { bootPeer, type BootedPeer } from './boot-peer.js'
import type { DaemonEnvReport } from './daemon-env.js'
import { createErrorRecorder } from './error-recorder.js'
import { installOutputRedaction } from './output-redaction.js'
import { buildPeerRegistry } from './registries.js'
import { reopenJoinedNetworks } from './reopen-networks.js'
import type { StartOptions } from './start-args.js'

export interface RunDaemonOptions extends StartOptions {
  envReport: DaemonEnvReport
}

export interface RunDaemonDeps {
  /** Ends the process once the run has settled; the default leaves 50 ms for the streams to flush. */
  exit: (code: number) => void
}

const EXIT_DELAY_MS = 50

const defaultDeps = (): RunDaemonDeps => ({
  exit: (code) => {
    setTimeout(() => process.exit(code), EXIT_DELAY_MS).unref()
  }
})

interface Peer {
  label: string
  role: Role
  dir: string
  booted: BootedPeer
  server?: CtlServerHandle
}

export async function runDaemon(opts: RunDaemonOptions, deps: RunDaemonDeps = defaultDeps()): Promise<ExitCode> {
  // 1. redaction before anything else is printed
  const registry = new SecretRegistry()
  const redactor = registry.redactor({ paths: [[opts.runRoot, '<runs>'], [opts.repoRoot, '<repo>']] })
  const redaction = installOutputRedaction({ redactor })
  const out = (line: string): void => {
    process.stdout.write(line + '\n')
  }
  const warn = (...a: unknown[]): void => {
    process.stderr.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n')
  }
  const finish = (code: ExitCode): ExitCode => {
    redaction.flush()
    redaction.uninstall()
    deps.exit(code)
    return code
  }

  // 2. the relay
  let multiaddr: string
  try {
    multiaddr = readRelayEnv(opts.relayEnvPath).multiaddr
  } catch (e) {
    if (!(e instanceof RelayEnvError) && (e as { name?: unknown } | undefined)?.name !== 'RelayEnvError') throw e
    out(`VT-DAEMON-BOOT-FAILED role=${opts.role} peer=${opts.label} token=relay-env`)
    out(`VT-DAEMON-STOPPED role=${opts.role} peer=${opts.label} reason=boot-failed`)
    return finish(EXIT.USAGE)
  }
  const relayPeerId = relayPeerIdOf(multiaddr)
  const isPrivate = relayIsPrivate(multiaddr)
  if (isPrivate) {
    registry.add(multiaddr)
    registry.add(relayPeerId)
  }
  const relay = { multiaddr, peerId: relayPeerId, private: isPrivate }

  // 6. shutdown, wired before any peer boots so a verb or a signal can reach it
  const peers: Peer[] = []
  let settle: ((code: ExitCode) => void) | undefined
  const done = new Promise<ExitCode>((resolve) => {
    settle = resolve
  })
  let shuttingDown: Promise<void> | undefined
  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      for (const p of [...peers].reverse()) await p.server?.close().catch(() => undefined)
      await Promise.all(peers.map((p) => p.booted.close(reason)))
      for (const p of peers) out(`VT-DAEMON-STOPPED role=${p.role} peer=${p.label} reason=${reason}`)
      settle?.(finish(EXIT.PASS))
    })()
    return shuttingDown
  }

  // 3. one booted peer per label, the primary last
  const dirOf = (label: string): string => (label === opts.label ? opts.peerDir : join(opts.partyDir, label))
  for (const [i, { label, role }] of opts.labels.entries()) {
    const dir = dirOf(label)
    const recorder = createErrorRecorder({ file: join(dir, PEER_FILES.crash), redactor })
    if (i === 0) recorder.installProcessHandlers()
    try {
      const booted = await bootPeer({
        role,
        label,
        partyId: opts.partyId,
        peerDir: dir,
        relay,
        secrets: registry,
        redactor,
        acceptTokenAttestations: role === 'officer' ? opts.acceptTokenAttestations : false,
        instruments: opts.instruments,
        relayReadyMs: opts.relayReadyMs,
        bootTimeoutMs: opts.bootTimeoutMs,
        warn,
        envReport: opts.envReport,
        exit: (why) => shutdown(why),
        record: recorder.record
      })
      peers.push({ label, role, dir, booted })
    } catch (e) {
      const token = (e as { token?: unknown } | undefined)?.token
      const tokenText = typeof token === 'string' ? token : 'start-error'
      recorder.record('boot', e)
      await Promise.all(peers.map((p) => p.booted.close('boot-failed')))
      out(`VT-DAEMON-BOOT-FAILED role=${role} peer=${label} token=${tokenText}`)
      for (const p of peers) out(`VT-DAEMON-STOPPED role=${p.role} peer=${p.label} reason=boot-failed`)
      out(`VT-DAEMON-STOPPED role=${role} peer=${label} reason=boot-failed`)
      return finish(tokenText === 'peer-dir-busy' ? EXIT.USAGE : EXIT.FAIL)
    }
  }

  // 3b. every joined network is open (or its bound has passed) before any peer reports ready
  await Promise.all(peers.map(async (p) => {
    const r = await reopenJoinedNetworks(p.booted.ctx)
    if (r.known > 0) out(`VT-DAEMON-NETWORKS role=${p.role} peer=${p.label} known=${r.known} opened=${r.opened} failed=${r.failed} pending=${r.pending}`)
  }))

  // 4. one ctl server per peer, the primary last
  const startedAt = new Date().toISOString()
  for (const p of peers) {
    const { ctx } = p.booted
    const primary = p.label === opts.label
    p.server = await startCtlServer({
      dir: p.dir,
      role: p.role,
      registry: buildPeerRegistry(p.role, p.label),
      ctx,
      redactor,
      record: ctx.record,
      onCall: (e) => out(`VT-CALL peer=${p.label} verb=${e.verb} status=${e.status} ms=${e.ms}`),
      beforePortFile: () => {
        writePrivateFileAtomic(
          join(p.dir, PEER_FILES.daemon),
          JSON.stringify({ pid: process.pid, role: p.role, label: p.label, partyId: opts.partyId, bootN: ctx.bootN, peerId8: ctx.peerId8, startedAt, primary })
        )
        const r = p.booted.bootRecord
        out(`VT-DAEMON-READY role=${p.role} peer=${p.label} boot=${ctx.bootN} readyMs=${String(r.readyMs)} recreated=${String(r.recreated)} relayReadyMs=${String(r.relayReadyMs)}`)
      }
    })
    const token = readCtlToken(p.dir)
    if (token.ok) registry.add(token.token, { windows: true })
  }

  // 5. signals and the runtime bound
  let signalled = false
  const onSignal = (): void => {
    if (signalled) process.exit(EXIT.FAIL)
    signalled = true
    void shutdown('signal')
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  setTimeout(() => {
    void shutdown('max-runtime')
  }, opts.maxRuntimeMs).unref()

  return done
}
