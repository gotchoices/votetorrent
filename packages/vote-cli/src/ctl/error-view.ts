// Redacted, truncated error view (red stub).

import { redact } from '../secrecy/redact.js'
import type { CtlErrorView } from './protocol.js'

export const MAX_ERROR_MESSAGE_CHARS = 200

export function ctlErrorView(
  _err: unknown,
  _redactor: (s: string) => string = (s) => redact(s)
): Required<Pick<CtlErrorView, 'name' | 'message' | 'chain'>> & { code?: string } {
  throw new Error('unimplemented')
}
