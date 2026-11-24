// One-call ctl client (red stub).

import type { ExitCode } from '../cli/exit-codes.js'
import type { CtlReplyBody, Role } from './protocol.js'

export const DEFAULT_CTL_TIMEOUT_MS = 1_000_000

export interface CtlReply {
  status: number
  body: CtlReplyBody
}

export interface CtlRequest {
  dir: string
  role: Role
  verb: string
  args?: Record<string, unknown>
  timeoutMs?: number
}

export function callCtl(_req: CtlRequest): Promise<CtlReply> {
  throw new Error('unimplemented')
}

export function exitCodeFor(_reply: CtlReply): ExitCode {
  throw new Error('unimplemented')
}
