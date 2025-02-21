import type { AuthorityEngineStore } from "../index.js";
import type { Answer, VoteBlock, Template, Question, Receipt, TraceFunc, Vote, Voter } from "../src/network/index.js";
import { Asymmetric, AsymmetricVault, base64ToArray } from "chipcryptbase";
import type { TimestampService } from "./structs/timestamp-service.js";
import { createHash } from "crypto";
import type { VoterWithKey } from "./structs/voter.js";
import type { VoteWithNonce } from "../src/network/vote.js";

type ProcessResult = {
	receipt: Receipt;
	result?: { voters: Record<string, Voter>, votes: Record<string, Vote> }
}

export class BlockEngine {
	constructor(
		private readonly store: AuthorityEngineStore,
		private readonly vault: AsymmetricVault,
		private readonly asymmetric: Asymmetric,
		private readonly timestampService: TimestampService,
		private readonly trace?: TraceFunc
	) { }

	async submit(block: VoteBlock): Promise<Receipt> {
		this.trace?.("submit", `block: ${JSON.stringify(block)}`);

		const processedBlock = await this.store.loadBlock(block.cid);	// Not in try...catch because we shouldn't return a receipt if this stage doesn't work (so that the same CID always results in the same receipt)
		if (processedBlock) {
			return processedBlock.receipt;
		}

		const result = await this.process(block);	// Note: for concurrency the store should only be read, not written, in this function

		if (result.receipt.result === "accepted") {
			const { voters, votes } = result.result!;
			await this.store.saveVotesAndReceipt(block.cid, block.ballotCid, voters, votes, result.receipt);
		} else {
			await this.store.saveBlockReceipt(block.cid, block.ballotCid, result.receipt);
		}

		return result.receipt;
	}

	private async process(block: VoteBlock): Promise<ProcessResult> {
		try {
			// TODO: validate block cid (hashes votes & voters)

			// Decrypt voters
			const voterResults = await Promise.all(
				Object.entries(block.voters).map(async ([registrantKey, voter]) => {
					try {
						return { registrantKey, voter: JSON.parse(await this.vault.decrypt(voter)) as Voter };
					} catch (error) {
						return { registrantKey, error };
					}
				})
			);

			const erroringKeys = voterResults
				.filter(result => 'error' in result)
				.map(result => result.registrantKey);

			if (erroringKeys.length > 0) {
				return { receipt: await this.generateReceipt(block.cid, "invalid", "Error decrypting voters", { registrantKeys: erroringKeys }) };
			}

			const voters = voterResults.filter((r): r is VoterWithKey => 'voter' in r);

			// Load election
			const confirmed = await this.store.loadBallot(block.ballotCid);
			// TODO: stable stringify
			const confirmedDigest = this.asymmetric.generateDigest(JSON.stringify(confirmed));

			await this.validateVoters(voters, confirmedDigest, block);

			// Decrypt and deserialize votes in similar manner as voters
			const votesAndErrors = await Promise.all(
				Object.entries(block.votes).map(async ([nonce, encrypted]) => {
					try {
						const vote = JSON.parse(await this.vault.decrypt(encrypted)) as Vote;
						return { nonce, vote, isReal: isRealVote({ nonce, vote }) };
					} catch (error) {
						return { nonce, error };
					}
				})
			);

			const errorNonces = votesAndErrors.filter(result => 'error' in result).map(result => result.nonce);
			if (errorNonces.length > 0) {
				return { receipt: await this.generateReceipt(block.cid, "invalid", "Error decrypting votes", { errorNonces }) };
			}

			const votes = votesAndErrors.filter((v): v is { nonce: string; vote: Vote; isReal: boolean; } => 'vote' in v);

			const realVotes = votes.filter(v => v.isReal) as VoteWithNonce[];

			await this.validateVotes(realVotes, voters, votes, block, confirmed);

			// Success
			return { receipt: await this.generateReceipt(block.cid, "success"),
				result: {
					voters: Object.fromEntries(voters.map(v => [v.registrantKey, v.voter])),
					votes: Object.fromEntries(votes.map(v => [v.nonce, v.vote]))
				}
			};
		} catch (error) {
			return { receipt: (error as any)['receipt'] ?? await this.generateReceipt(block.cid, "error", error) };
		}
	}

	private async validateVotes(realVotes: VoteWithNonce[], voters: VoterWithKey[], votes: VoteWithNonce[], block: VoteBlock, ballot: Template) {
		// Validate that the number of real votes is equal to the number of voters
		if (realVotes.length !== voters.length) {
			const realVoteNonces = realVotes.map(v => v.nonce);
			throw { receipt: await this.generateReceipt(block.cid, "invalid", "Number of real votes does not match number of voters", { realVoteNonces }) };
		}

		// Validate that votes are valid (answers are valid and match questions)
		const slotCodes = new Map(ballot.questions.map(q => [q.code, q]));
		const invalidVotes = realVotes
			.map(vote => {
				try {
					return { nonce: vote.nonce, results: this.checkVote(vote, ballot, slotCodes) };
				} catch {
					return undefined;
				}
			})
			.filter(Boolean) as { nonce: string, results: string }[];

		if (invalidVotes.length) {
			throw {
				receipt: await this.generateReceipt(block.cid, "invalid",
					invalidVotes.map(v => `${v.nonce}: ${v.results}`).join('; '),
					{ voteNonces: invalidVotes.map(v => v.nonce) })
			};
		}

		// Validate that votes are unique (by nonce)
		const preexistingVotes = await this.store.loadVotesByNonce(block.ballotCid, realVotes.map(v => v.nonce));
		const dupVotes = Object.entries(preexistingVotes).map(([nonce, v]) => v ? nonce : undefined).filter(Boolean) as string[];
		if (dupVotes.length) {
			throw { receipt: await this.generateReceipt(block.cid, "invalid", "Duplicate nonces", { voteNonces: dupVotes }) };
		}
	}

	private async validateVoters(voters: VoterWithKey[], confirmedDigest: Uint8Array, block: VoteBlock) {
		// Validate that voters' signatures are valid for their respective keys
		const invalidVoters = (await Promise.all(
			voters.map(async ({ registrantKey, voter }) => {
				const valid = await this.asymmetric.verifyDigest(
					base64ToArray(registrantKey),
					confirmedDigest,
					base64ToArray(voter.signature.signature)
				);
				return valid ? null : registrantKey;
			})
		)).filter(key => Boolean(key)) as string[];
		if (invalidVoters.length) {
			throw { receipt: await this.generateReceipt(block.cid, "invalid", null, { registrantKeys: invalidVoters }) };
		}

		// Validate that none of the voters have voted before
		const votersByKey = await this.store.loadVotersByKey(block.ballotCid, voters.map(v => v.registrantKey));
		const dupVoters = Object.keys(votersByKey).filter(key => votersByKey[key]);
		if (dupVoters.length) {
			throw { receipt: await this.generateReceipt(block.cid, "duplicate", null, { registrantKeys: dupVoters }) };
		}
	}

	private checkVote({ vote, nonce }: VoteWithNonce, confirmed: Template, slotCodes: Map<string, Question>) {
		// Validate: no duplicate answers (for the same slot code)
		if (vote.answers.length !== new Set(vote.answers.map(a => a.slotCode)).size) {
			return 'Duplicate answers';
		}

		// Validate: all answers are valid
		const invalidAnswers = vote.answers.map(a => {
			const question = slotCodes.get(a.slotCode);
			if (!question) return `Invalid slot code: ${a.slotCode}`;
			const result = this.checkAnswer(a, question);
			if (result) return `${a.slotCode}: ${result}`;
		});
		if (invalidAnswers.length) {
			return invalidAnswers.join(', ');
		}

		// Validate: nonce
		if (typeof nonce !== 'string' || nonce.length < 16) {
			return 'Invalid nonce';
		}

		return '';
	}

	private checkAnswer(answer: Answer, question: Question): string {
		// Ensure that answer.values exists
		if (!answer.values) {
			return 'Missing answer values';
		}

		switch (question.type) {
			case 'select': {	// Example: "values": ["<option code>", "<option code>"]
				// Answer must be an array of option codes
				if (!Array.isArray(answer.values)) {
					return 'Invalid selection value';
				}
				// Proper range of options selected
				if (question.optionRange && !between(answer.values.length, question.optionRange.min, question.optionRange.max)) {
					return `Between ${question.optionRange.min} and ${question.optionRange.max} selections allowed`;
				}
				// All keys must be valid option codes and all values must be "true"
				const invalidValues = answer.values.filter(code => !question.options.some(o => o.code === code));
				if (invalidValues.length) {
					return `Invalid selection: ${invalidValues.join(', ')}`;
				}
			} break;
			case 'rank': {	// Example: "values": ["<option code>", "<option code>", ...]
				// Answer must be an array of option codes
				if (!Array.isArray(answer.values)) {
					return 'Invalid selection value';
				}
				// Proper range of options ranked
				if (question.optionRange && !between(answer.values.length, question.optionRange.min, question.optionRange.max)) {
					return `Between ${question.optionRange.min} and ${question.optionRange.max} ranked options allowed`;
				}
				// All keys must be valid option codes
				const uniqueValues = new Set(answer.values);
				if (uniqueValues.size !== answer.values.length) {
					return 'Duplicate ranked options';
				}
			} break;
			case 'score': {	// Example: "values": { "<option code>": 0.2, "<option code>": 0.75, ... }
				// All keys must be valid option codes, values must be numbers and be in range and step
				const invalidValues = Object.entries(answer.values).filter(([key, value]) => !question.options.some(o => o.code === key)
					|| typeof value !== 'number'
					|| (question.scoreRange && (value < question.scoreRange.min || value > question.scoreRange.max || (value - question.scoreRange.min) % question.scoreRange.step !== 0)));
				if (invalidValues.length) {
					return `Invalid score: ${invalidValues.map(([key]) => key).join(', ')}`;
				}
			} break;
			case 'text': {	// Example: "values": "<text>"
				// Answer must be a string
				if (typeof answer.values !== 'string') {
					return `Invalid text value: ${answer.values}`;
				}
			} break;
		}
		return '';
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
function isRealVote({ nonce, vote }: VoteWithNonce): boolean {
	return Boolean(vote.answers) && vote.answers.length > 0 && Boolean(nonce);
}

function between(value: number, min: number, max: number): boolean {
	return value >= min && value <= max;
}
