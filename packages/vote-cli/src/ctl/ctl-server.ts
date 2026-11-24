// Per-peer HTTP control endpoint on 127.0.0.1 (red stub).

import type { Role } from './protocol.js'
import type { VerbRegistry } from './verb-registry.js'

export interface CtlCallEvent {
  verb: string
  status: number
  ms: number
  errorName?: string
}

export interface CtlServerOptions<C> {
  dir: string
  role: Role
  registry: VerbRegistry<C>
  ctx: C
  redactor?: (s: string) => string
  maxBodyBytes?: number
  record?: (where: string, err: unknown) => void
  onCall?: (e: CtlCallEvent) => void
  beforePortFile?: (info: { port: number }) => void | Promise<void>
}

export interface CtlServerHandle {
  port: number
  dir: string
  close(): Promise<void>
}

export async function startCtlServer<C>(_opts: CtlServerOptions<C>): Promise<CtlServerHandle> {
  throw new Error('unimplemented')
}
