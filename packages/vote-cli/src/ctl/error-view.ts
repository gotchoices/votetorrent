// The error view a ctl 500 reply carries: name, optional code, message and the cause chain. It merges
// the rig's rpc.mjs errorView (name, code, message; never the stack trace) with peer driver's 500 body
// (message cut to 200, chainNames to depth 6). The message is redacted FIRST and truncated second:
// truncating first could cut a registered secret into an unmatched prefix that then leaks.

import { redact } from '../secrecy/redact.js'
import type { CtlErrorView } from './protocol.js'

export const MAX_ERROR_MESSAGE_CHARS = 200
const MAX_CHAIN = 6
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

export type CtlErrorViewOut = Required<Pick<CtlErrorView, 'name' | 'message' | 'chain'>> & { code?: string }

function safeName(x: unknown): string {
  return typeof x === 'string' && NAME_RE.test(x) ? x : 'Error'
}

function propertyOf(err: unknown, key: string): unknown {
  if (err === null || err === undefined) return undefined
  try {
    return (err as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function messageOf(err: unknown): string {
  const m = propertyOf(err, 'message')
  if (typeof m === 'string') return m
  try {
    return String(err)
  } catch {
    return 'unprintable'
  }
}

function chainOf(err: unknown): string[] {
  const out: string[] = []
  for (let x: unknown = err, d = 0; x !== null && x !== undefined && d < MAX_CHAIN; x = propertyOf(x, 'cause'), d++) {
    const name = propertyOf(x, 'name')
    out.push(safeName(name ?? typeof x))
  }
  return out
}

export function ctlErrorView(err: unknown, redactor: (s: string) => string = (s) => redact(s)): CtlErrorViewOut {
  const name = safeName(propertyOf(err, 'name'))
  const rawCode = propertyOf(err, 'code')
  const code = typeof rawCode === 'string' && CODE_RE.test(rawCode) ? rawCode : undefined
  const cleaned = messageOf(err).replace(CONTROL_RE, ' ')
  const message = redactor(cleaned).slice(0, MAX_ERROR_MESSAGE_CHARS)
  const chain = chainOf(err)
  return code === undefined ? { name, message, chain } : { name, code, message, chain }
}
