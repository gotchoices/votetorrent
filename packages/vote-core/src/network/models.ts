import type { AdminInit, AuthorityInit } from '../authority/models'
import type { ImageRef, Proposal } from '../common'
import type { ElectionType } from '../election/models'

export interface Network {
  /** The network ID */
  id: string

  /** The hash of the network ID */
  hash: string

  /** The optional image for the network */
  imageRef?: ImageRef

  /** The name for the network */
  name: string

  /** The policies for the network */
  policies: NetworkPolicies

  /** The primary authority ID */
  primaryAuthorityId: string

  /** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
  relays: string[]
}

export interface NetworkRevision {
  /** The optional image for the network */
  imageRef?: ImageRef

  /** The name for the network */
  name: string

  /** The policies for the network */
  policies: NetworkPolicies

  /** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
  relays: string[]
}

export interface NetworkDetails {
  /** The network information published by the primary authority */
  network: Network

  /** The proposed revision of the network */
  proposed?: Proposal<NetworkRevision>
}

export interface NetworkPolicies {
  /** The type of election allowed on the network */
  electionType: ElectionType

  /** The number of required timestamp authorities for the network */
  numberRequiredTSAs: number

  /** The timestamp authorities (TSAs) for the network */
  timestampAuthorities: TimestampAuthority[]
}

export interface NetworkReference {
  /** Hash of networkId - encoded into the network protocols */
  hash: string

  /** The optional image for the network (published by the primary authority) - this should be verified once connected to prevent spoofing
   * This is a url not an ImageRef because you can't reference a cid from outside the network
   */
  imageUrl?: string

  /** The name of the network */
  name: string

  /** The domain name of the primary authority */
  primaryAuthorityDomainName: string

  /** One or more multiaddresses to stable hosts, necessary to initially connect to the network */
  relays: string[]
}

export interface NetworkInit {
  /** The initial information for the administration */
  admin: AdminInit

  /** The image for the network
   * This is a url not an ImageRef because you can't reference a cid from outside the network
   */
  imageUrl?: string

  /** The name of the network */
  name: string

  /** The policies for the network */
  policies: NetworkPolicies

  /** The initial information for the primary authority */
  primaryAuthority: AuthorityInit

  /** The multiaddresses to stable hosts, necessary to initially connect to the network */
  /** Do these neet to be here? alreay in the revision init */
  relays: string[]
}

export interface NetworkSummary {
  /** The hash of the network ID */
  hash: string

  /** The optional image for the network
   * This is a url not an ImageRef because you can't reference a cid from outside the network
   */
  imageUrl?: string

  /** The name of the network */
  name: string

  /** The domain name of the primary authority */
  primaryAuthorityDomainName: string

  /** The network ID */
  id: string
}

export interface TimestampAuthority {
  /** The URL of the timestamp authority */
  url: string
}
