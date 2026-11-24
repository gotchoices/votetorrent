import type { Role } from '../ctl/protocol.js'
import { StartArgsError, type StartPosture } from './posture.js'
export { StartArgsError }
export interface StartOptions {
  role: Role
  label: string
  partyId: string
  peerDir: string
  partyDir: string
  runRoot: string
  repoRoot: string
  relayEnvPath: string
  colocate: string[] | null
  labels: Array<{ label: string, role: Role }>
  acceptTokenAttestations: boolean
  posture: StartPosture
  instruments: boolean
  maxPeers: number
  relayReadyMs: number
  bootTimeoutMs: number
  maxRuntimeMs: number
}
export function parseStartArgs(_role: Role, _args: Record<string, unknown>, _env: { totalmem: () => number, repoRoot: string, defaultMaxPeers: (totalmem: number) => number }): StartOptions {
  throw new Error('unimplemented')
}
