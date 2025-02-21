import { AuthorizedTimestamp } from "./authorized-timestamp.js";
import { TimestampAuthorityClient } from "./timestamp-authority-client.js";

interface TSAOptions {
	tsaUrls: string[]; // List of TSA URLs
	errorCallback?: (error: any) => void; // Optional callback for handling errors
	requiredCount: number; // Required number of TSAs to report
}

export class TimestampService {
	constructor(
		private readonly options: TSAOptions,
		private readonly client: TimestampAuthorityClient,
	) { }

	async fetchTimestamps(imprint: string): Promise<AuthorizedTimestamp[]> {
		const authorizedTimestamps: AuthorizedTimestamp[] = [];

		const requests = this.options.tsaUrls.map(async (tsaUrl) => {
			try {
				const authorizedTimestamp = await this.client.fetchTimestamp(tsaUrl, imprint);
				authorizedTimestamps.push(authorizedTimestamp);
			} catch (error) {
				if (this.options.errorCallback) {
					this.options.errorCallback(error);
				}
				// Do not rethrow the error here; let other TSAs report
			}
		});

		await Promise.all(requests);

		if (authorizedTimestamps.length < this.options.requiredCount) {
			throw new Error(`Failed to fetch the required number of timestamps: ${authorizedTimestamps.length}/${this.options.requiredCount}`);
		}

		return authorizedTimestamps;
	}
}
