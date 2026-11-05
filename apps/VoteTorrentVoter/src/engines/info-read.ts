/**
 * info-read.ts — the read surface behind the "Learn about this election / office / candidate"
 * dialogs. `election-read.ts` maps the engine's records down to what the Home and Ballot cards
 * render and drops the authority-published detail (instructions, date, tags, a candidate's details
 * and info link); these reads return that detail for the ONE item the voter asked about.
 *
 * Same engine chain and the same election-identity rule as `election-read.ts`
 * (`getElections()` -> `pickElectionId` -> `openElection()`), so a dialog always describes the
 * election the cards show. Office and candidate ids are the composite ids `toVoterBallot` mints:
 * `${ballotId}:${questionCode}` and `${ballotId}:${questionCode}:${optionCode}`.
 */
import type { IElectionEngine, IElectionsEngine, Question } from '@votetorrent/vote-core'
import { NoElectionError, pickElectionId } from './election-read'
import type { ElectionReadDeps } from './election-read'

export interface ElectionInfo {
	title: string
	authorityName?: string
	/** Election day, epoch ms. */
	date: number
	/** Authority-published markdown; shown as plain text. */
	instructions: string
	tags: string[]
}

export interface OfficeInfo {
	title: string
	instructions: string
	voteFor: number
}

export interface CandidateInfo {
	name: string
	details?: string
	infoURL?: string
	imageUrl?: string
}

/** An office or candidate id does not resolve to a question/option on the current election. */
export class InfoNotFoundError extends Error {
	constructor (id: string) {
		super(`No ballot item found for id ${id}`)
		this.name = 'InfoNotFoundError'
	}
}

async function openCurrentElection (
	deps: ElectionReadDeps
): Promise<{ engine: IElectionEngine, authorityName?: string }> {
	const electionsEngine = await deps.getEngine<IElectionsEngine>('elections')
	const summaries = await electionsEngine.getElections()
	const electionId = pickElectionId(summaries, deps.fallbackElectionId)
	if (!electionId) {
		throw new NoElectionError()
	}
	const authorityName = summaries.find(summary => summary.id === electionId)?.authorityName
	return {
		engine: await electionsEngine.openElection(electionId),
		...(authorityName ? { authorityName } : {}),
	}
}

/**
 * Splits a composite ballot-item id into its ballot id and the trailing codes. The ballot id is
 * everything before the last `parts` separators, so a ballot id that itself contains `:` still
 * resolves.
 */
export function splitItemId (id: string, parts: 1 | 2): { ballotId: string, codes: string[] } | null {
	const segments = id.split(':')
	if (segments.length < parts + 1) return null
	const codes = segments.slice(segments.length - parts)
	const ballotId = segments.slice(0, segments.length - parts).join(':')
	if (!ballotId || codes.some(code => code === '')) return null
	return { ballotId, codes }
}

async function readQuestion (deps: ElectionReadDeps, ballotId: string, questionCode: string, id: string): Promise<Question> {
	const { engine } = await openCurrentElection(deps)
	const { ballot } = await engine.getBallotDetails(ballotId)
	const question = ballot.questions.find(q => q.code === questionCode)
	if (!question) throw new InfoNotFoundError(id)
	return question
}

export async function readElectionInfo (deps: ElectionReadDeps): Promise<ElectionInfo> {
	const { engine, authorityName } = await openCurrentElection(deps)
	const details = await engine.getElectionDetails()
	return {
		title: details.election.title,
		...(authorityName ? { authorityName } : {}),
		date: details.election.date,
		instructions: details.current.instructions ?? '',
		tags: details.current.tags ?? [],
	}
}

export interface RegistrationDeadlineInfo {
	electionId: string
	electionTitle: string
	/** The election timeline's `registrationEnds` instant, epoch ms — absent when the authority
	 *  published none (never defaulted). */
	registrationEnds?: number
}

export async function readRegistrationDeadline (deps: ElectionReadDeps): Promise<RegistrationDeadlineInfo> {
	const { engine } = await openCurrentElection(deps)
	const details = await engine.getElectionDetails()
	const registrationEnds = details.current.timeline?.registrationEnds
	return {
		electionId: details.election.id,
		electionTitle: details.election.title,
		...(typeof registrationEnds === 'number' && Number.isFinite(registrationEnds) ? { registrationEnds } : {}),
	}
}

export async function readOfficeInfo (deps: ElectionReadDeps, officeId: string): Promise<OfficeInfo> {
	const parsed = splitItemId(officeId, 1)
	if (!parsed) throw new InfoNotFoundError(officeId)
	const question = await readQuestion(deps, parsed.ballotId, parsed.codes[0], officeId)
	return {
		title: question.title,
		instructions: question.instructions ?? '',
		voteFor: Math.max(1, question.optionRange?.max ?? 1),
	}
}

export async function readCandidateInfo (deps: ElectionReadDeps, candidateId: string): Promise<CandidateInfo> {
	const parsed = splitItemId(candidateId, 2)
	if (!parsed) throw new InfoNotFoundError(candidateId)
	const [questionCode, optionCode] = parsed.codes
	const question = await readQuestion(deps, parsed.ballotId, questionCode, candidateId)
	const option = question.options.find(o => o.code === optionCode)
	if (!option) throw new InfoNotFoundError(candidateId)
	return {
		name: option.title,
		...(option.details ? { details: option.details } : {}),
		...(option.infoURL ? { infoURL: option.infoURL } : {}),
		...(option.image?.url ? { imageUrl: option.image.url } : {}),
	}
}
