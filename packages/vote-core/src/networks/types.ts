import type { AdornedNetworkReference, NetworkInit, NetworkReference } from "../network/models";
import type { INetworkEngine } from "../network/types";

export type INetworksEngine = {
  clearRecentNetworks(): Promise<void>;
  create(init: NetworkInit): Promise<INetworkEngine>;
  discover(latitude: number, longitude: number): Promise<AdornedNetworkReference[]>;
  getRecentNetworks(): Promise<AdornedNetworkReference[]>;
  open(ref: NetworkReference, storeAsRecent?: boolean): Promise<INetworkEngine>;
}