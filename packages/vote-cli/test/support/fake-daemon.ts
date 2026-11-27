// A daemon stand-in for the run-election spec: it speaks the real ctl protocol (startCtlServer, per-label
// dir, token and role, ctl.port written LAST) with canned verbs, and holds no CadreNode and dials no relay.
// Spawned as:
//   node --import <register-ts-node.mjs> --experimental-specifier-resolution=node <this file>
//        <role> start --state <peerDir> --relay <relay.env> --party <party> [--colocate a,b]
// With --colocate, the process serves the --state label at --state and every other label at
// <dirname(--state)>/<label>, each with its own ctl server, token and role.
// VT_FAKE_BOOT=exit makes it exit 3 before any port file exists.

import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { startCtlServer, type CtlServerHandle } from '../../src/ctl/ctl-server.js'
import { isRole, type Role, type VerbHandler } from '../../src/ctl/protocol.js'
import { defineVerbRegistry } from '../../src/ctl/verb-registry.js'

interface FakeCtx {
  label: string
  role: Role
}

function roleOf (label: string): Role {
  if (label === 'officer') return 'officer'
  if (label.startsWith('kh-')) return 'keyholder'
  return 'voter'
}

function flag (argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const handles: CtlServerHandle[] = []

/** Mimics the verbs' strict allow-lists: a body carrying `peer` is refused before any handler runs. */
const strict = (entries: Record<string, VerbHandler<FakeCtx>>): Record<string, VerbHandler<FakeCtx>> =>
  Object.fromEntries(Object.entries(entries).map(([name, handler]) => [name, (ctx: FakeCtx, args: Record<string, unknown>) => {
    if (Object.prototype.hasOwnProperty.call(args, 'peer')) {
      throw Object.assign(new Error('BadRequest'), { name: 'BadRequest', code: 'bad-request' })
    }
    return handler(ctx, args)
  }]))

const registry = defineVerbRegistry<FakeCtx>(strict({
  echo: (ctx, args) => ({ n: args.n ?? null, label: ctx.label, pid: process.pid }),
  fail: () => {
    throw Object.assign(new Error('the fake verb failed on purpose'), { name: 'FakeVerbError' })
  },
  'debug-lines': (_ctx, args) => {
    const count = typeof args.count === 'number' ? args.count : 1
    for (let i = 0; i < count; i++) {
      process.stderr.write(`${new Date().toISOString()} optimystic:db-p2p:protocol-client response peer=…abcd1234 protocol=/fake/1 ms=5\n`)
    }
    return { count }
  },
  print: (_ctx, args) => {
    process.stderr.write(String(args.text) + '\n')
    return {}
  },
  env: () => ({
    forceColor: process.env.FORCE_COLOR ?? null,
    debugColors: process.env.DEBUG_COLORS ?? null,
    debugHideDate: process.env.DEBUG_HIDE_DATE ?? null,
    nodeOptionsSet: 'NODE_OPTIONS' in process.env,
    debug: process.env.DEBUG ?? null,
    preload: (globalThis as { __vtPreload?: unknown }).__vtPreload === 1,
    cpuProf: process.execArgv.includes('--cpu-prof')
  }),
  'node-flags': () => ({ flags: [...process.execArgv] }),
  'instr-env': () => ({
    instrDir: process.env.VT_INSTR_DIR ?? null,
    instrRole: process.env.VT_INSTR_ROLE ?? null
  }),
  stop: () => {
    setTimeout(() => {
      void Promise.all(handles.map((h) => h.close())).finally(() => process.exit(0))
    }, 50)
    return { stopping: true }
  }
}))

async function main (): Promise<void> {
  const argv = process.argv.slice(2)
  const role = argv[0]
  const state = flag(argv, '--state')
  if (!isRole(role) || argv[1] !== 'start' || state === undefined) {
    process.stderr.write('fake-daemon: usage\n')
    process.exitCode = 2
    return
  }
  if (process.env.VT_FAKE_BOOT === 'exit') {
    process.stdout.write('VT-DAEMON-BOOT-FAILED token=fake-exit\n')
    process.exit(3)
  }
  const primary = basename(state)
  const colocate = flag(argv, '--colocate')
  const labels = colocate !== undefined ? colocate.split(',') : [primary]
  for (const label of labels) {
    const dir = label === primary ? state : join(dirname(state), label)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const labelRole = label === primary ? role : roleOf(label)
    const handle = await startCtlServer<FakeCtx>({
      dir,
      role: labelRole,
      registry,
      ctx: { label, role: labelRole },
      beforePortFile: () => {
        process.stdout.write(`VT-DAEMON-READY role=${labelRole} label=${label}\n`)
      }
    })
    handles.push(handle)
  }
  process.on('SIGTERM', () => {
    void Promise.all(handles.map((h) => h.close())).finally(() => process.exit(0))
  })
}

void main()
