export type NetworkOpenErrorCode = 'network-not-open' | 'user-missing'

export class NetworkOpenError extends Error {
  readonly code: NetworkOpenErrorCode

  constructor(code: NetworkOpenErrorCode) {
    super(code)
    this.name = 'NetworkOpenError'
    this.code = code
  }
}

export function createRoleNetworksEngine(_opts: unknown): never {
  throw new Error('unimplemented')
}

export async function openRoleNetwork(_opts: unknown): Promise<never> {
  throw new Error('unimplemented')
}
