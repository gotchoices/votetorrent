// RED stub (67-28 Task 1): final export names, every body unimplemented.
import type { KeyholderVerb } from './keyholder-args.js'

export function withKeyholderVerbLock<T>(_ctx: object, _verb: KeyholderVerb, _fn: () => Promise<T>): Promise<T> {
  throw new Error('unimplemented')
}

export function measureUnwraps<T>(_baseVault: { readonly authPromptCount: number }, _fn: () => Promise<T>): Promise<{ value: T, unwraps: number }> {
  throw new Error('unimplemented')
}

export function resolveIdentityForElection(_storage: unknown, _invitations: unknown, _electionId: string): Promise<unknown> {
  throw new Error('unimplemented')
}

export function openKeyholderEngines(_ctx: unknown, _networkHash: string, _vaultView: unknown): Promise<unknown> {
  throw new Error('unimplemented')
}

export function jointKeyTag(_jointPublicKey: string): string {
  throw new Error('unimplemented')
}
