import { AuthorityEngineStore } from ".";
import { AuthorizedTimestamp, Block, Receipt, TraceFunc, Vote, Voter } from "../common";
import { Asymmetric, AsymmetricVault, base64ToArray } from "chipcryptbase";
import { TimestampService } from "../common/timestamp-service";
import { createHash } from "crypto";

interface ProcessResult {
	receipt: Receipt;
	result?: { voters: Voter[], votes: Vote[] }
}

export class BlockEngine {
	constructor(
		private readonly store: AuthorityEngineStore,
		private readonly vault: AsymmetricVault,
		private readonly asymmetric: Asymmetric,
		private readonly timestampService: TimestampService,
		private readonly trace?: TraceFunc
	) { }

	async submit(block: Block): Promise<Receipt> {
		this.trace?.("submit", `block: ${JSON.stringify(block)}`);

		const processedBlock = await this.store.loadBlock(block.cid);	// Not in try...catch because we shouldn't return a receipt if this stage doesn't work (so that the same CID always results in the same receipt)
		if (processedBlock) {
			return processedBlock.receipt;
		}

		const result = await this.process(block);

		if (result.receipt.result === "accepted") {
			const { voters, votes } = result.result!;
			await this.store.storeVotesAndReceipt(block.confirmedCid, block.confirmedCid, voters, votes, result.receipt);
		} else {
			await this.store.storeBlockReceipt(block.cid, block.confirmedCid, result.receipt);
		}

		return result.receipt;
	}

	private async process(block: Block): Promise<ProcessResult> {
		try {
			// TODO: validate block cid (hashes votes & voters)

			let voters: Voter[];
			// Decrypt voters
			try {
				voters = await Promise.all(
					block.voters.map(async voter => JSON.parse(await this.vault.decrypt(voter)) as Voter)
				);
			} catch (error) {
				return { receipt: await this.generateReceipt(block.cid, "invalid", error) };
			}

			// Load election
			const confirmed = await this.store.loadConfirmed(block.confirmedCid);
			const confirmedDigest = this.asymmetric.generateDigest(JSON.stringify(confirmed));

			// Validate that voters' signatures are valid for their respective keys
			const invalidVoters = (await Promise.all(
				voters.map(async voter => {
					const valid = await this.asymmetric.verifyDigest(
						base64ToArray(voter.registrantKey),
						confirmedDigest,
						base64ToArray(voter.signature.signature)
					);
					return valid ? null : voter.registrantKey;
				})
			)).filter(key => Boolean(key)) as string[];
			if (invalidVoters.length) {
				return { receipt: await this.generateReceipt(block.cid, "invalid", null, { resultCids: invalidVoters }) };
			}

			// Validate that none of the voters have voted before - TODO: how to handle concurrency
			const duplicates = await this.store.loadVotedByKey(block.confirmedCid, voters.map(voter => voter.registrantKey));
			if (duplicates.length) {
				return { receipt: await this.generateReceipt(block.cid, "duplicate", null, { resultCids: duplicates }) };
			}

			// Decrypt and deserialize votes in similar manner as voters
			let votes: { vote: Vote, isReal: boolean }[];
			try {
				votes = await Promise.all(
					block.votes.map(async encrypted => {
						const vote = JSON.parse(await this.vault.decrypt(encrypted)) as Vote;
						return ({ vote, isReal: isRealVote(vote) });
					}));
			} catch (error) {
				return { receipt: await this.generateReceipt(block.cid, "invalid", error) };
			}

			const realVotes = votes.filter(v => v.isReal).map(v => v.vote);

			// Validate that the number of real votes is equal to the number of voters
			if (realVotes.length !== voters.length) {
				const realVoteIndexes = votes.reduce((acc, v, i) => v.isReal ? [...acc, i] : acc, [] as number[]);
				return { receipt: await this.generateReceipt(block.cid, "invalid", "Number of real votes does not match number of voters", { realVoteIndexes }) };
			}

			// TODO: Validate that votes are valid (answers are valid and match questions)

			// TODO: Validate that votes are unique (by nonce) - TODO: how to handle concurrency

			// Success
			return { receipt: await this.generateReceipt(block.cid, "success"), result: { voters, votes: realVotes } };
		} catch (error) {
			return { receipt: await this.generateReceipt(block.cid, "error", error) };
		}
	}

	private async generateReceipt(blockCid: string, result: string, error?: any, details?: Record<string, any>): Promise<Receipt> {
		const receipt = { blockCid, result, ...details };
		// TODO: acquire timestamp from TSA
		const imprint = createHash('sha256').update(JSON.stringify(receipt)).digest('base64');
		const timestamps = await this.timestampService.fetchTimestamps(imprint);
		const signature = await this.vault.sign(JSON.stringify(receipt));
		return { ...receipt, timestamps, signature } as Receipt;
	}
}

/** A vote is only considered real if it has at least one answer and a nonce */
function isRealVote(vote: Vote): boolean {
	return Boolean(vote.answers) && vote.answers.length > 0 && Boolean(vote.nonce);
}
