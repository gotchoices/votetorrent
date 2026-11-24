// Wire constants and reply types shared by the ctl server, the ctl client and the command table.
//
// A peer daemon serves one HTTP endpoint on 127.0.0.1: POST /ctl with the x-vt-token and x-vt-role
// headers and a JSON body { verb, args }. Every reply is JSON: { ok: true, result, ms } or
// { ok: false, error: { name, code?, message?, chain? }, ms? }. Verb names are [a-z0-9-]{1,64};
// the built-in `verbs` verb lists what a running daemon serves and can never be registered.

export const ROLES = ['officer', 'keyholder', 'voter'] as const
export type Role = (typeof ROLES)[number]

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x)
}

export const CTL_PORT_FILE = 'ctl.port'
export const CTL_TOKEN_FILE = 'ctl.token'
export const CTL_TOKEN_HEADER = 'x-vt-token'
export const CTL_ROLE_HEADER = 'x-vt-role'
export const CTL_PATH = '/ctl'

export const CTL_MAX_BODY_BYTES = 65536
export const VERB_NAME_RE = /^[a-z0-9-]{1,64}$/
export const BUILTIN_VERBS_VERB = 'verbs'

export interface CtlErrorView {
  name: string
  code?: string
  message?: string
  chain?: string[]
}

export interface CtlReplyBody {
  ok: boolean
  result?: Record<string, unknown>
  error?: CtlErrorView
  ms?: number
}

export type VerbHandler<C> = (
  ctx: C,
  args: Record<string, unknown>
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
