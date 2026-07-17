/** ********* AuthorityPeer (P2P network membership, admin-signed under 'cap') ***********/
export interface AuthorityPeer {
  /** references Authority.id */
  authorityId: string

  /** P2P peer identifier */
  peerId: string
}

/** ********* PollingDevice (in-person device whitelist, admin-signed under 'vrg') ***********/
export interface PollingDevice {
  /** references Authority.id */
  authorityId: string

  /** sha256 hash of the device ID */
  deviceHash: string

  /** Human-readable label for the polling location/device */
  label?: string
}
