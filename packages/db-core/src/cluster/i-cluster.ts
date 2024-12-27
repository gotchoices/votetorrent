import { ClusterRecord } from "./structs.js";

export type ICluster = {
	update(record: ClusterRecord): Promise<ClusterRecord>;
}
