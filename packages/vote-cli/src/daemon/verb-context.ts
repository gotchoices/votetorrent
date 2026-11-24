export class VerbContextError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'VerbContextError'
    this.code = code
  }
}
export class VerbArgsError extends Error {
  readonly code = 'unexpected-arg' as const
  constructor() {
    super('unexpected-arg')
    this.name = 'VerbArgsError'
  }
}
export type VerbContext = Record<string, unknown>
export function createVerbContext(_parts: unknown): VerbContext {
  throw new Error('unimplemented')
}
export function assertNoArgs(_args: Record<string, unknown>): void {
  throw new Error('unimplemented')
}
