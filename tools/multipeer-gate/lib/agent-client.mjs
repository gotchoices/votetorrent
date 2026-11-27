/**
 * agent-client.mjs — the gate's half of the peer-agent channel.
 *
 * Spawns a `peer-agent.mjs` and hands back a handle that looks exactly like the
 * in-process one in `lib/handles.mjs`. The legs are written against that shared shape and
 * genuinely cannot tell which they were given, which is the point: the SAME assertions
 * run over a shared heap and over a socket, and the difference between the two results is
 * the measurement.
 *
 * REMOTE SPAWN
 * ------------
 * The command is per-node and overridable, because "another process" and "another
 * machine" are the same code path once the channel is a byte pipe:
 *
 *   SPAWN_PEER_A='ssh bench-2 node /opt/multipeer-gate/peer-agent.mjs'
 *
 * Name `peer-A` reads env `SPAWN_PEER_A` (upper-cased, `-` to `_`). Unset falls back to
 * this host's `node peer-agent.mjs`. A remote agent needs the same package installed at
 * the far end and a route back for the libp2p sockets — the gate does not tunnel traffic,
 * it only tunnels control.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFrameReader, encodeFrame } from './wire.mjs';

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'peer-agent.mjs');

const envKeyFor = (name) => `SPAWN_${name.toUpperCase().replace(/-/g, '_')}`;

/** The argv for a node's agent: its own SPAWN_* override, else a local child. */
export function spawnSpecFor(name) {
  const override = process.env[envKeyFor(name)];
  if (override) {
    const argv = override.split(/\s+/).filter(Boolean);
    return { command: argv[0], args: argv.slice(1), remote: true, source: envKeyFor(name) };
  }
  return { command: process.execPath, args: [AGENT], remote: false, source: 'local' };
}

class AgentClient {
  constructor(name, { onLog, timeoutMs }) {
    this.name = name;
    this.onLog = onLog;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = Promise.withResolvers();
    this.exited = null;
  }

  async open() {
    const spec = spawnSpecFor(this.name);
    this.spec = spec;
    this.child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_NAME: this.name },
    });

    const feed = createFrameReader({
      onFrame: (frame) => {
        if (frame.event === 'ready') return this.ready.resolve(frame);
        const waiter = this.pending.get(frame.id);
        if (!waiter) return;
        this.pending.delete(frame.id);
        clearTimeout(waiter.timer);
        if (frame.error) waiter.reject(new Error(`${this.name}: ${frame.error}`));
        else waiter.resolve(frame.result);
      },
      onNoise: (line) => this.onLog?.(this.name, line),
    });
    this.child.stdout.on('data', feed);
    this.child.stderr.on('data', (c) => String(c).split('\n').forEach((l) => l && this.onLog?.(this.name, l)));

    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      // Anything still in flight can never be answered now. Rejecting beats hanging: the
      // leg that was waiting gets to report a dead agent instead of a timeout that says
      // nothing about why.
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${this.name}: agent exited (code=${code} signal=${signal}) with a request in flight`));
      }
      this.pending.clear();
      this.ready.reject(new Error(`${this.name}: agent exited before becoming ready (code=${code} signal=${signal})`));
    });

    await this.ready.promise;
    return this;
  }

  call(op, args, timeoutMs = this.timeoutMs) {
    if (this.exited) return Promise.reject(new Error(`${this.name}: agent is not running`));
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`${this.name}: '${op}' did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdin.write(encodeFrame({ id, op, args }));
    return promise;
  }

  /** Kill the OS process. Used by the durability leg: a stopped node must be really gone. */
  async kill() {
    if (this.exited) return;
    try { await this.call('exit', {}, 10_000); } catch { /* it may die before answering */ }
    if (!this.exited) this.child.kill('SIGKILL');
  }
}

export async function startAgent(name, opts) {
  return new AgentClient(name, opts).open();
}
