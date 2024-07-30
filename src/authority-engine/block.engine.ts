import { AuthorityEngineStore } from ".";
import { Answer, AuthorizedTimestamp, Block, ConfirmedElection, Question, Receipt, TraceFunc, Vote, Voter } from "../common";
import { Asymmetric, AsymmetricVault, base64ToArray } from "chipcryptbase";
import { TimestampService } from "../common/timestamp-service";
import { createHash } from "crypto";
import { Rule, RuleResponse, RuleSet } from "../common/rule";

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

		const result = await this.process(block);	// Note: for concurrency the store should only be read, not written, in this function

		if (result.receipt.result === "accepted") {
			const { voters, votes } = result.result!;
			await this.store.saveVotesAndReceipt(block.cid, block.confirmedCid, voters, votes, result.receipt);
		} else {
			await this.store.saveBlockReceipt(block.cid, block.confirmedCid, result.receipt);
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

			await this.validateVoters(voters, confirmedDigest, block);

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

			await this.validateVotes(realVotes, voters, votes, block, confirmed);

			// Success
			return { receipt: await this.generateReceipt(block.cid, "success"), result: { voters, votes: realVotes } };
		} catch (error) {
			return { receipt: (error as any)['receipt'] ?? await this.generateReceipt(block.cid, "error", error) };
		}
	}

	private async validateVotes(realVotes: Vote[], voters: Voter[], votes: { vote: Vote; isReal: boolean; }[], block: Block, confirmed: ConfirmedElection) {
		// Validate that the number of real votes is equal to the number of voters
		if (realVotes.length !== voters.length) {
			const realVoteIndexes = votes.reduce((acc, v, i) => v.isReal ? [...acc, i] : acc, [] as number[]);
			throw { receipt: await this.generateReceipt(block.cid, "invalid", "Number of real votes does not match number of voters", { realVoteIndexes }) };
		}

		// Validate that votes are valid (answers are valid and match questions)
		const slotCodes = new Map(confirmed.questions.map(q => [q.slotCode, q]));
		const invalidVotes = votes
			.map((entry, index) => ({ index, entry }))
			.filter(v => v.entry.isReal)
			.map(v => {
				try {
					return { index: v.index, results: this.validateVote(v.entry.vote, confirmed, slotCodes) };
				} catch {
				}})
			.filter(Boolean) as { index: number, results: string }[];
		if (invalidVotes.length) {
			throw {
				receipt: await this.generateReceipt(block.cid, "invalid",
					invalidVotes.map(v => `${v.index}: ${v.results}`).join('; '),
					{ voteIndexes: invalidVotes.map(v => v.index) })
			};
		}

		// Check for duplicate votes within the block
		const orderedVotes = realVotes.map((v, i) => ({ index: i, vote: v }));
		const dupVotes = orderedVotes
			.filter(e => orderedVotes.some(v => v.index !== e.index && v.vote.nonce === e.vote.nonce))
			.map(e => e.index);
		if (dupVotes.length) {
			throw { receipt: await this.generateReceipt(block.cid, "invalid", "Duplicate nonces", { voteIndexes: dupVotes }) };
		}

		// Validate that votes are unique (by nonce)
		const redundantVotes = await this.store.loadVotesByNonce(block.confirmedCid, realVotes.map(v => v.nonce));
		const dupNonces = redundantVotes.map((v, i) => v ? i : undefined).filter(Boolean) as number[];
		if (dupNonces.length) {
			throw { receipt: await this.generateReceipt(block.cid, "invalid", "Duplicate nonces", { voteIndexes: dupNonces }) };
		}
	}

	private async validateVoters(voters: Voter[], confirmedDigest: Uint8Array, block: Block) {
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
			throw { receipt: await this.generateReceipt(block.cid, "invalid", null, { resultCids: invalidVoters }) };
		}

		// Validate that none of the voters have voted before
		const votersByKey = await this.store.loadVotersByKey(block.confirmedCid, voters.map(voter => voter.registrantKey));
		const dupVoters = votersByKey.filter(Boolean).map(v => v?.registrantKey);
		if (dupVoters.length) {
			// TODO: convert these registrant keys to CIDs
			throw { receipt: await this.generateReceipt(block.cid, "duplicate", null, { resultCids: dupVoters }) };
		}
	}

	private validateVote(vote: Vote, confirmed: ConfirmedElection, slotCodes: Map<string, Question>) {
		// Validate: no duplicate answers (for the same slot code)
		if (vote.answers.length !== new Set(vote.answers.map(a => a.slotCode)).size) {
			throw "Multiple answers";
		}

		// Validate: all answers are valid
		const invalidAnswers = vote.answers.map(a => {
			const question = slotCodes.get(a.slotCode);
			if (!question) return `${a.slotCode}: Invalid slot code`;
			const result = this.validateAnswer(a, question);
			if (result) return `${a.slotCode}: ${result}`;
		});
		if (invalidAnswers.length) {
			return invalidAnswers.join(', ');
		}

		// Validate: nonce
		if (typeof vote.nonce !== 'string' || vote.nonce.length < 16) {
			return 'Invalid nonce';
		}

		return '';
	}

	private validateAnswer(answer: Answer, question: Question): string {
		switch (question.type) {
			case 'select': {	// Example: "values": { "<option code>": true, "<option code>": true, ... }
				// Proper range of options selected
				if (question.optionRange && !between(Object.keys(answer.values).length, question.optionRange.min, question.optionRange.max)) {
					return `Between ${question.optionRange.min} and ${question.optionRange.max} selections allowed`;
				}
				// All keys must be valid option codes and all values must be "true"
				const invalidValues = Object.entries(answer.values).filter(([key]) => !question.options.some(o => o.code === key) || answer.values[key] !== true);
				if (invalidValues.length) {
					return `Invalid selection: ${invalidValues.map(([key]) => key).join(', ')}`;
				}
			} break;
			case 'rank': {	// Example: "values": { "<option code>": 0, "<option code>": 1, ... }
				// Proper range of options ranked
				if (question.optionRange && !between(Object.keys(answer.values).length, question.optionRange.min, question.optionRange.max)) {
					return `Between ${question.optionRange.min} and ${question.optionRange.max} ranked options allowed`;
				}
				// All keys must be valid option codes and values must be monotonically increasing sequence from 0 to n-1
				const uniqueValues = new Set(Object.values(answer.values));
				const answerCount = Object.keys(answer.values).length;
				for (let i = 0; i < answerCount; i++) {
					if (!uniqueValues.has(i)) {
						return `Missing rank sequence ${i}`;
					}
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
			case 'text': {	// Example: "values": { "<option code>": "<text>", ... }
				const invalidValues = Object.entries(answer.values).filter(([key, value]) => !question.options.some(o => o.code === key) || typeof value !== 'string');
				if (invalidValues.length) {
					return `Invalid text values: ${invalidValues.map(([key]) => key).join(', ')}`;
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
function isRealVote(vote: Vote): boolean {
	return Boolean(vote.answers) && vote.answers.length > 0 && Boolean(vote.nonce);
}

function between(value: number, min: number, max: number): boolean {
	return value >= min && value <= max;
}
