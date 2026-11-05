/**
 * election-read.ts — the voter's election/ballot read surface over the REAL engine chain
 * (`getEngine('elections')` -> `getElections()` -> `openElection()` -> `getElectionDetails()` /
 * `getBallots()` / `getBallotDetails()`), replacing the in-memory `mockData.ts` fixture the
 * Home/Ballot screens used to read.
 *
 * Only what the engine can source is filled in: id, title, the lifecycle state derived from the
 * election's timeline at read time, the countdown to the event that ends that state, the keyholder
 * count, and (from the key-release states on) the number of keys released. "Keys released" is the
 * release engine's ACCEPTED count (`KeyReleaseEngine.getKeyReleaseStatus().releasedCount`,
 * signature- and commitment-checked, D-17), read through a vault-less `'keyRelease'` engine, and
 * left absent when no election key is published or the read fails. Voting progress, validation
 * checks/fingerprint and certification have NO engine source yet and are left absent — never
 * faked (the `__DEV__` override in `VoterAppProvider` is the only thing that ever fills them, from
 * `devLifecycleFixtures.ts`).
 */
import type {
	Ballot,
	ElectionDetails,
	ElectionSummary,
	IElectionEngine,
	IElectionsEngine,
	IKeyReleaseEngine,
	Question,
} from '@votetorrent/vote-core'
import { deriveTimeline } from '../timeline'
import type { TimelineStageId, TimelineViewModelConfident } from '../timeline'
import type { LifecycleContent, LifecycleState, Office, VoterBallot, VoterElection } from '../providers/types'

export interface ElectionReadDeps {
	getEngine: <T>(engineName: string, initParams?: unknown) => Promise<T>
	/** Election to fall back to when the network lists none (the `__DEV__` seeded election). */
	fallbackElectionId?: string
}

/** No election to read on the current network — callers render an unavailable state. */
export class NoElectionError extends Error {
	constructor () {
		super('No election is available on the current network')
		this.name = 'NoElectionError'
	}
}

/**
 * D-02's election-identity rule, a pure helper so it is testable without rendering. Shared by
 * Home, Ballot, Timeline and Keyholders so every surface reads the SAME election.
 * `ElectionsEngine.getElections()` filters `where E.Date >= :now` (elections-engine.ts:474), so
 * every summary this function ever receives is already in the FUTURE — picking the summary
 * nearest to now is therefore picking the soonest upcoming election, not "most recent" in the
 * sense of "just happened". Ties broken by ascending `id` for determinism. The single-summary
 * case (today's dev seed and every current deployment) is identical under either reading; the
 * multi-election surface (an election picker) is a deferred phase — see 59-CONTEXT.md Deferred
 * Ideas.
 *
 * `fallbackId` is passed as `__DEV__ ? seededElectionId : undefined` at the call site so the
 * `__DEV__` gate lives in one visible place: `seededElectionId` is `undefined` in every release
 * build (`providers/types.ts:203-209`), so relying on it alone would render an empty tab in
 * production.
 */
export function pickElectionId (summaries: ElectionSummary[], fallbackId: string | undefined): string | undefined {
	if (summaries.length === 0) {
		return fallbackId
	}
	if (summaries.length === 1) {
		return summaries[0].id
	}

	const nowMs = Date.now()
	let best: ElectionSummary | undefined
	let bestDiff = Number.POSITIVE_INFINITY
	for (const summary of summaries) {
		const diff = Math.abs(summary.date - nowMs)
		if (diff < bestDiff || (diff === bestDiff && best !== undefined && summary.id < best.id)) {
			best = summary
			bestDiff = diff
		}
	}
	return best?.id
}

/**
 * 64 D-28 (not phase 62's D-28): the election registration binds its requests to. It is the same
 * rule every other screen uses (`getEngine('elections')` -> `getElections()` -> `pickElectionId`),
 * so a phone on a joined network, which has no dev seed, registers with the election the network
 * lists. Only an EMPTY list falls back (`pickElectionId`'s own rule). A rejected read PROPAGATES:
 * the caller shows its transient copy, and the dev seed never stands in for a network that could
 * not be read. Callers pass `__DEV__ ? seededElectionId : undefined` as the fallback and memoise
 * the result per attempt, because the request inits embed it.
 */
export async function resolveCurrentElectionId (deps: {
	getEngine: (name: 'elections') => Promise<{ getElections (): Promise<ElectionSummary[]> }>
	fallbackElectionId: string | undefined
}): Promise<string | undefined> {
	const electionsEngine = await deps.getEngine('elections')
	return pickElectionId(await electionsEngine.getElections(), deps.fallbackElectionId)
}

async function openCurrentElection (deps: ElectionReadDeps): Promise<{ electionId: string, engine: IElectionEngine }> {
	const electionsEngine = await deps.getEngine<IElectionsEngine>('elections')
	const electionId = pickElectionId(await electionsEngine.getElections(), deps.fallbackElectionId)
	if (!electionId) {
		throw new NoElectionError()
	}
	return { electionId, engine: await electionsEngine.openElection(electionId) }
}

/**
 * Timeline stage (the last event whose instant has passed) -> card state. Voting closes at
 * `accruingVotes` (doc/election.md), so the three stages from there up to `tallyingStarts` are the
 * locked, keys-releasing window; tallying through certification is validation.
 * `ReviewSelections` and `ValidationDetails` are never derived — they are not points on the
 * timeline, only `__DEV__` review states.
 */
const STAGE_LIFECYCLE: Record<TimelineStageId, LifecycleState> = {
	registrationEnds: 'Upcoming',
	ballotsFinal: 'Upcoming',
	votingStarts: 'Open',
	accruingVotes: 'ReleasingKeys',
	hashingVotes: 'ReleasingKeys',
	releasingKeys: 'ReleasingKeys',
	tallyingStarts: 'Validation',
	validation: 'Validation',
	certificationStarts: 'Validation',
	closed: 'Complete',
}

/** The event that ENDS each derived state — its instant is the card's countdown target. */
const STATE_ENDED_BY: Partial<Record<LifecycleState, TimelineStageId>> = {
	Upcoming: 'votingStarts',
	Open: 'accruingVotes',
	ReleasingKeys: 'tallyingStarts',
	Validation: 'closed',
}

/** Card state + countdown target for a confident timeline view at `nowMs`. */
export function lifecycleFromTimeline (
	view: TimelineViewModelConfident,
	nowMs: number
): { lifecycleState: LifecycleState } & Pick<LifecycleContent, 'countdownTarget'> {
	const lifecycleState = view.currentStageId === null ? 'Upcoming' : STAGE_LIFECYCLE[view.currentStageId]
	const endStage = STATE_ENDED_BY[lifecycleState]
	const endMs = endStage === undefined ? null : view.rows.find(row => row.stageId === endStage)?.instantMs ?? null
	return endMs !== null && endMs > nowMs
		? { lifecycleState, countdownTarget: new Date(endMs).toISOString() }
		: { lifecycleState }
}

/**
 * The ONE `deriveTimeline` argument list, shared by Home (`readVoterElection`) and the vote gate
 * (`readVoteContext`) so the two can never drift (D-01).
 */
function deriveDetailsTimeline (details: ElectionDetails, nowMs: number) {
	return deriveTimeline({
		timeline: details.current.timeline,
		now: nowMs,
		election: { ballotDeadline: details.election.ballotDeadline, date: details.election.date },
	})
}

/**
 * Reads the current election and derives its card state at `nowMs`. Rejects with
 * `NoElectionError` when there is nothing to read, and with a plain `Error` when the election's
 * timeline is indeterminate (the Timeline tab's own D-03 rule: never a guessed state).
 */
export async function readVoterElection (deps: ElectionReadDeps, nowMs: number): Promise<VoterElection> {
	const { electionId, engine } = await openCurrentElection(deps)
	const details = await engine.getElectionDetails()
	const view = deriveDetailsTimeline(details, nowMs)
	if (view.indeterminate) {
		throw new Error(`Election ${electionId} has an indeterminate timeline: ${view.reason}`)
	}
	const keyholders = details.current.keyholders ?? []
	const lifecycle = lifecycleFromTimeline(view, nowMs)
	const keysReleased = await readKeysReleased(deps, electionId, lifecycle.lifecycleState)
	return {
		id: electionId,
		title: details.election.title,
		...lifecycle,
		...(keyholders.length > 0 ? { keysTotal: keyholders.length } : {}),
		...(keysReleased !== undefined ? { keysReleased } : {}),
	}
}

/** States in which the card/keyholder list shows a released count. */
const RELEASE_COUNT_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(['ReleasingKeys', 'Validation', 'Complete'])

/**
 * The accepted release count (D-17), or `undefined` — never 0 — when it cannot be measured: the
 * state shows no count, no election key is published yet, or the read fails. A failed release read
 * must never cost the election card.
 */
async function readKeysReleased (deps: ElectionReadDeps, electionId: string, state: LifecycleState): Promise<number | undefined> {
	if (!RELEASE_COUNT_STATES.has(state)) return undefined
	try {
		const status = await (await deps.getEngine<IKeyReleaseEngine>('keyRelease')).getKeyReleaseStatus(electionId)
		const measurable =
			status.electionKey !== null &&
			(status.phase === 'before-release-window' || status.phase === 'releasing' || status.phase === 'reconstructable')
		return measurable ? status.releasedCount : undefined
	} catch {
		return undefined
	}
}

/**
 * Flattens the election's ballots into the voter's single office list: `select` questions only
 * (the rest are counted in `unsupportedQuestionCount`), ballots in id order, questions grouped by
 * `group` in first-appearance order and ordered by `sequence` within a group (declaration order
 * breaks ties and orders unsequenced questions). The structured fields carry the codes the vote
 * builders need. Office order follows group first appearance in ENGINE read order, which for a
 * confirmed ballot is Code order (63-04 finding), so consumers must key by `questionCode`, never
 * by position.
 */
export function toVoterBallot (electionId: string, ballots: Ballot[]): VoterBallot {
	const entries: Array<{ office: Office, question: Question, index: number }> = []
	let unsupportedQuestionCount = 0
	for (const ballot of [...ballots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		for (const question of ballot.questions) {
			if ((question.type ?? 'select') !== 'select') {
				unsupportedQuestionCount++
				continue
			}
			const group = question.group?.trim()
			entries.push({
				question,
				index: entries.length,
				office: {
					id: `${ballot.id}:${question.code}`,
					ballotId: ballot.id,
					questionCode: question.code,
					required: question.required !== false,
					hasDependsOn: question.dependsOn != null,
					title: question.title,
					...(group ? { group } : {}),
					voteFor: Math.max(1, question.optionRange?.max ?? 1),
					candidates: question.options.map(option => ({
						id: `${ballot.id}:${question.code}:${option.code}`,
						optionCode: option.code,
						name: option.title,
						...(option.details ? { party: option.details } : {}),
					})),
				},
			})
		}
	}

	const groupRank = new Map<string | undefined, number>()
	for (const { office } of entries) {
		if (!groupRank.has(office.group)) groupRank.set(office.group, groupRank.size)
	}
	entries.sort((a, b) =>
		groupRank.get(a.office.group)! - groupRank.get(b.office.group)! ||
		(a.question.sequence ?? Number.POSITIVE_INFINITY) - (b.question.sequence ?? Number.POSITIVE_INFINITY) ||
		a.index - b.index
	)

	return { electionId, offices: entries.map(entry => entry.office), unsupportedQuestionCount }
}

/**
 * Reads the current election's ballot. Only officer-CONFIRMED ballots are offered to a voter;
 * `includeProposed` (passed `__DEV__` by the provider) also admits proposed-but-unconfirmed ones,
 * which is all the dev seed can produce without running the officer confirmation ceremony.
 */
export async function readVoterBallot (deps: ElectionReadDeps, options: { includeProposed: boolean }): Promise<VoterBallot> {
	const { electionId, engine } = await openCurrentElection(deps)
	const summaries = await engine.getBallots()
	const offered = options.includeProposed
		? summaries
		: (
				await Promise.all(
					summaries.map(async summary => ((await engine.getBallotConfirmationState(summary.id)).confirmed ? summary : null))
				)
			).filter((summary): summary is (typeof summaries)[number] => summary !== null)
	const ballots = await Promise.all(offered.map(async summary => (await engine.getBallotDetails(summary.id)).ballot))
	return toVoterBallot(electionId, ballots)
}

/** Everything the vote gate, `castVote` and Review/Submit need from the engine, at one instant. */
export interface VoteContext {
	electionId: string
	/** `details.current.revision`; the D-21 stale comparison input. */
	revision: number
	/** `details.election.authorityId`. */
	authorityId: string
	/** The D-01 gate: false when the window is not Open, the timeline is indeterminate or `nowMs` is non-finite. */
	open: boolean
	/** The derived state at `nowMs`; null means indeterminate (for reason copy only). */
	lifecycleState: LifecycleState | null
	/** Confirmed ballots only, raw, sorted by `id` ascending, questions in engine order. */
	ballots: Ballot[]
	/** Ids of ballots that are not officer-confirmed, sorted. Their details are never read. */
	unconfirmedBallotIds: string[]
	/** Unsupported (non-`select`) questions over `ballots`. */
	unsupportedQuestionCount: number
}

/**
 * The vote-time read for the eligibility gate and `castVote`. It derives the window from the
 * election timeline at the caller's `nowMs` and deliberately takes NO lifecycle override, because
 * `getElection().lifecycleState` is forced by the `__DEV__` cycler and must never open or close
 * Submit (D-01). An indeterminate timeline or a non-finite clock means closed. Only confirmed
 * ballots are returned and there is no `includeProposed` path (D-03). Questions stay in engine
 * order (Code order for a confirmed ballot), so consumers key by `questionCode`, never by index.
 *
 * Call contract: pass `{getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}`
 * and `useVoterApp().nowMs()`, read fresh per evaluation and never cached (D-02). Rejects with
 * `NoElectionError` when there is no election, and with a plain `Error` on an unreadable revision
 * or authority id. It does not reject on an indeterminate timeline.
 */
export async function readVoteContext (deps: ElectionReadDeps, nowMs: number): Promise<VoteContext> {
	const { electionId, engine } = await openCurrentElection(deps)
	const details = await engine.getElectionDetails()

	// The engine casts the revision with an unchecked `as number`; D-21 compares it by `!==`.
	const raw: unknown = details.current.revision
	const revision = typeof raw === 'bigint' ? Number(raw) : raw
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
		throw new Error(`Election ${electionId} has an unreadable revision`)
	}
	const authorityId: unknown = details.election.authorityId
	if (typeof authorityId !== 'string' || authorityId === '') {
		throw new Error(`Election ${electionId} has an unreadable authority`)
	}

	let lifecycleState: LifecycleState | null = null
	if (Number.isFinite(nowMs)) {
		const view = deriveDetailsTimeline(details, nowMs)
		lifecycleState = view.indeterminate ? null : lifecycleFromTimeline(view, nowMs).lifecycleState
	}
	const open = lifecycleState === 'Open'

	const summaries = await engine.getBallots()
	const states = await Promise.all(summaries.map(summary => engine.getBallotConfirmationState(summary.id)))
	const confirmed: typeof summaries = []
	const unconfirmedBallotIds: string[] = []
	summaries.forEach((summary, i) => {
		if (states[i]?.confirmed === true) confirmed.push(summary)
		else unconfirmedBallotIds.push(summary.id)
	})
	unconfirmedBallotIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const ballots = (await Promise.all(confirmed.map(async summary => (await engine.getBallotDetails(summary.id)).ballot)))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

	return {
		electionId,
		revision,
		authorityId,
		open,
		lifecycleState,
		ballots,
		unconfirmedBallotIds,
		unsupportedQuestionCount: toVoterBallot(electionId, ballots).unsupportedQuestionCount,
	}
}
