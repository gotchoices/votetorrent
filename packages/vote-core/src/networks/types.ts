import type { AuthorityNetwork } from "../authority/struct";
import type { NetworkReference } from "../network/network-reference";

export type INetworksEngine = {
  getRecentNetworks(): Promise<AuthorityNetwork[]>;
  clearRecentNetworks(): Promise<void>;
  discoverNetworks(latitude: number, longitude: number): Promise<AuthorityNetwork[]>;
  connect(init: NetworkReference): Promise<void>;
}