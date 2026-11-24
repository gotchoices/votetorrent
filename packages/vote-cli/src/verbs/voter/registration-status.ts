// TEMPORARY mirror: mirrors apps/VoteTorrentVoter/src/engines/registration-status.ts resolveRegistrationStatus.
// Pinned by test/voter-mirror-drift.spec.ts. Must be replaced by a shared extraction before 67-33.
//
// Why a mirror and not an import: the app module imports app-only modules (the attach-transport screen
// helper, attestation-failure) and logs with `console`, so it has no shared home yet. The body below keeps
// the app's statement order and branches (D-06 via D-23: derived fresh from the authority-signed
// Association/Registrant rows this device's own P-256 key can prove it owns, the narrow retirement check,
// the own election-narrowed requests, one corroborating transport leg, outer failure indeterminate).
// Two deviations, each marked below: (1) no `console` (a failure is swallowed, not logged); (2) no network
// name in the result (the CLI reply never needs it): the function returns only the status token.

import type { Association, IAssociationEngine, INetworkEngine, IRegistrationEngine } from '@votetorrent/vote-core'

export type VoterRegistrationStatus = 'registered' | 'pending' | 'notRegistered' | 'indeterminate'

/** The transports slice the corroborating leg reads (the CLI's `createCliVoterRequestTransports` result fits). */
export interface VoterRegistrationStatusTransports {
  ownAssociationRequestIds(requesterKey: string): Promise<string[]>
  associationTransport: {
    pollDecisions(sinceCursor?: string): Promise<Array<{ requestId: string, status: string }>>
  }
}

export interface VoterRegistrationStatusDeps {
  getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
  /** READ-ONLY current P-256 device-key lookup (the producer's `getCurrentDeviceKey`), never a provision. */
  getCurrentDeviceKey: () => Promise<{ publicKey: string }>
  /** The transports over the joined network, already built; undefined skips the corroborating leg. */
  transports: VoterRegistrationStatusTransports | undefined
  /** Narrows own association requests to this election; a request with no electionId is accepted regardless. */
  electionId?: string
}

/** The producer contract's "no usable key" reject code (the app reads it through `isDeviceKeyAbsent`). */
const DEVICE_KEY_ABSENT_CODE = 'DEVICE_KEY_ABSENT'

function isDeviceKeyAbsent(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === DEVICE_KEY_ABSENT_CODE
}

/** The four-outcome status for this device, as the Voter's Timeline panel derives it. */
export async function readVoterRegistrationStatus(deps: VoterRegistrationStatusDeps): Promise<VoterRegistrationStatus> {
  try {
    let p256DeviceKey: string | undefined
    try {
      p256DeviceKey = (await deps.getCurrentDeviceKey()).publicKey
    } catch (err) {
      if (!isDeviceKeyAbsent(err)) throw err
    }

    const network = await deps.getEngine<INetworkEngine>('network')
    const details = await network.getDetails()
    // Deviation (2): the app keeps `details.network.name` for display; the CLI result carries no name.
    const authorityId = details.network.primaryAuthorityId
    if (p256DeviceKey === undefined) {
      return 'notRegistered'
    }

    const association = await deps.getEngine<IAssociationEngine>('association')
    const rows: Association[] = await association.getAssociationsByDeviceKey(p256DeviceKey)

    if (rows.length > 0) {
      const registration = await deps.getEngine<IRegistrationEngine>('registration')
      let sawDanglingLinkage = false
      for (const row of rows) {
        const registrant = await registration.getRegistrant(row.registrantId)
        if (registrant === undefined) {
          sawDanglingLinkage = true
          continue
        }
        if (registrant.authorityId === authorityId && registrant.status === 'a') {
          return 'registered'
        }
      }
      if (sawDanglingLinkage) {
        return 'indeterminate'
      }
      return 'notRegistered'
    }

    try {
      const reassociationAssociation = association as unknown as {
        getDeviceRetirement?: (deviceKey: string) => Promise<unknown>
      }
      if (typeof reassociationAssociation.getDeviceRetirement === 'function') {
        const retirement = await reassociationAssociation.getDeviceRetirement(p256DeviceKey)
        if (retirement !== undefined) {
          return 'notRegistered'
        }
      }
    } catch {
      // corroborating-only: fall through to the request read below
    }

    const requests = await association.listAssociationRequestsByDeviceKey(p256DeviceKey)
    const mine = requests.filter(
      (r) =>
        r.authorityId === authorityId &&
        r.deviceKey === p256DeviceKey &&
        (r.electionId === undefined || deps.electionId === undefined || r.electionId === deps.electionId)
    )
    if (mine.some((r) => r.status === 'p' || r.status === 'c')) {
      return 'pending'
    }
    if (mine.some((r) => r.status === 'a')) {
      return 'indeterminate'
    }

    try {
      const transports = deps.transports
      if (transports) {
        const ownIds = new Set(await transports.ownAssociationRequestIds(p256DeviceKey))
        const notices = await transports.associationTransport.pollDecisions()
        const mine = notices.filter((n) => ownIds.has(n.requestId))
        if (mine.some((n) => n.status === 'p' || n.status === 'c')) {
          return 'pending'
        }
      }
    } catch {
      // Deviation (1): the app logs this corroborating failure with console.error; here it is swallowed.
    }

    return 'notRegistered'
  } catch {
    // Deviation (1): the app logs the read failure with console.error; here it is swallowed.
    return 'indeterminate'
  }
}
