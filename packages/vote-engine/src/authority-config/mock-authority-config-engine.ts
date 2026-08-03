import type { AuthorityPeer, IAuthorityConfigEngine, PollingDevice, Signature } from '@votetorrent/vote-core'

type SignatureOrCallback = Signature | ((digest: Uint8Array) => Promise<Signature>)

/**
 * MockAuthorityConfigEngine — in-memory `IAuthorityConfigEngine` parity
 * implementation for UI-only development. No DB, no signing ceremony —
 * mirrors `MockElectionsEngine`'s `Map`-backed shape.
 */
export class MockAuthorityConfigEngine implements IAuthorityConfigEngine {
  private readonly peers = new Map<string, AuthorityPeer[]>()
  private readonly devices = new Map<string, PollingDevice[]>()

  async addAuthorityPeer (
    authorityId: string,
    peerId: string,
    _signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    const list = this.peers.get(authorityId) ?? []
    if (!list.some((p) => p.peerId === peerId)) {
      list.push({ authorityId, peerId })
      this.peers.set(authorityId, list)
    }
  }

  async removeAuthorityPeer (
    authorityId: string,
    peerId: string,
    _signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    const list = this.peers.get(authorityId) ?? []
    this.peers.set(authorityId, list.filter((p) => p.peerId !== peerId))
  }

  async getAuthorityPeers (authorityId: string): Promise<AuthorityPeer[]> {
    return [...(this.peers.get(authorityId) ?? [])]
  }

  async addPollingDevice (
    authorityId: string,
    deviceHash: string,
    label: string | undefined,
    _signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    const list = this.devices.get(authorityId) ?? []
    const existing = list.find((d) => d.deviceHash === deviceHash)
    if (existing) {
      existing.label = label
    } else {
      list.push({ authorityId, deviceHash, label })
      this.devices.set(authorityId, list)
    }
  }

  async removePollingDevice (
    authorityId: string,
    deviceHash: string,
    _signatureOrCallback: SignatureOrCallback
  ): Promise<void> {
    const list = this.devices.get(authorityId) ?? []
    this.devices.set(authorityId, list.filter((d) => d.deviceHash !== deviceHash))
  }

  async getPollingDevices (authorityId: string): Promise<PollingDevice[]> {
    return [...(this.devices.get(authorityId) ?? [])]
  }
}
