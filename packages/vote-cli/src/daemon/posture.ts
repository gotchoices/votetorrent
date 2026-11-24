import type { Role } from '../ctl/protocol.js'
export type StartPosture = 'production' | 'test'
export class StartArgsError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'StartArgsError'
    this.code = code
  }
}
export const TEST_POSTURE_FLAGS: ReadonlyArray<{ flag: string, key: string, roles: readonly Role[] }> = Object.freeze([])
export const RESERVED_PARTIES: readonly string[] = Object.freeze([])
export function isReservedParty(_partyId: string): boolean {
  throw new Error('unimplemented')
}
export function startPostureOf(_args: Record<string, unknown>): StartPosture {
  throw new Error('unimplemented')
}
export function assertStartPosture(_input: { role: Role, partyId: string, args: Record<string, unknown> }): void {
  throw new Error('unimplemented')
}
