// RED stub (67-28 Task 1): final export names, every body unimplemented.
import type { ApprovalContext } from '../../approval/token.js'

export type KeyholderVerb = 'join' | 'accept' | 'dkg' | 'release'

export class KeyholderVerbError extends Error {
  readonly code: string
  readonly verb: KeyholderVerb
  unwraps?: number

  constructor(verb: KeyholderVerb, code: string) {
    super(`keyholder ${verb} refused (${code})`)
    this.name = 'KeyholderVerbError'
    this.verb = verb
    this.code = code
  }
}

export const MAX_SEAT_SHARE_BYTES = 4096

export function keyholderErrorCode(_err: unknown): string {
  throw new Error('unimplemented')
}

export function parseKeyholderArgs(_verb: KeyholderVerb, _args: Record<string, unknown>, _spec: Record<string, unknown>): Record<string, unknown> {
  throw new Error('unimplemented')
}

export function readSeatShareFile(_verb: KeyholderVerb, _absPath: string): string {
  throw new Error('unimplemented')
}

export function approvalFromArgs(_verb: KeyholderVerb, _tokenFile: unknown): { approval: ApprovalContext, source: 'none' | 'file' } {
  throw new Error('unimplemented')
}

export function withKeyholderApproval<T>(_verb: KeyholderVerb, _args: Record<string, unknown>, _fn: (approval: ApprovalContext) => Promise<T>): Promise<T> {
  throw new Error('unimplemented')
}
