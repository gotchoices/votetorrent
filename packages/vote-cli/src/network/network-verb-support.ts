// RED stub: replaced by the implementation commit.
const unimplemented = (): never => { throw new Error('unimplemented') }
export interface OfficerVerbContext { readonly partyId: string }
export class NetworkVerbError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code } }
export const checkArgs = unimplemented as (...a: unknown[]) => Record<string, string>
export const parseNetworkHash = unimplemented as (...a: unknown[]) => string
export const parseAuthorityId8 = unimplemented as (...a: unknown[]) => string
export const assertTestParty = unimplemented as (...a: unknown[]) => void
export const assertNetworkParty = unimplemented as (...a: unknown[]) => void
export const assertSecretTarget = unimplemented as (...a: unknown[]) => string
export const writeSecretFile = unimplemented as (...a: unknown[]) => string
export const readSecretSource = unimplemented as (...a: unknown[]) => string
export const openKnownNetwork = unimplemented as (...a: unknown[]) => Promise<unknown>
export const resolvePrimaryAuthority = unimplemented as (...a: unknown[]) => Promise<unknown>
export const resolveVerbApproval = unimplemented as (...a: unknown[]) => unknown
export const officerEngine = unimplemented as (...a: unknown[]) => unknown
export const officerNode = unimplemented as (...a: unknown[]) => unknown
