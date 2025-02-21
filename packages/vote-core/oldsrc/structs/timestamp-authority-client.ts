import { AuthorizedTimestamp } from "./authorized-timestamp.js";
import { WebClient } from "../../src/election/web-client.js";

export class TimestampAuthorityClient {
	constructor(
		private readonly webClient: WebClient,
	) { }

	// TODO: re-implement this using timestamping token (RFC 3161) npm package: https://www.npmjs.com/package/@xevolab/timestamping-token

	async fetchTimestamp(tsaUrl: string, imprint: string): Promise<AuthorizedTimestamp> {
		const response = await this.webClient.post(tsaUrl, { imprint });
		const data = await response.json();
		const nonce = 0 // TODO: generate random 64bit int

		const authorizedTimestamp: AuthorizedTimestamp = {
			timestamp: data.timestamp,
			signature: data.signature,
			tsaCertificate: data.tsaCertificate,
			algorithm: data.algorithm,
			policyId: data.policyId,
			serialNumber: data.serialNumber,
			nonce: data.nonce,
			hashedDigest: data.hashedDigest,
		};
		return authorizedTimestamp;
	}
}
