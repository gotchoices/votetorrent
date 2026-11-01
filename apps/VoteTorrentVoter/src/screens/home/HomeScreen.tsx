/**
 * HomeScreen — Vote tab root (D-07 per-domain screen file). Reads through `useVoterApp()`
 * (D-06 / SHELL-03 — no direct fixture-module import), fetches the election on every focus, when
 * a network is attached, and whenever the `__DEV__` lifecycle override changes, and composes the real `ElectionCard` (Phase
 * 40, HOME-01/02/03) once loaded — or an unavailable message when there is no election to read.
 * Also hosts the `__DEV__`-gated lifecycle cycler (D-03): it steps live -> each forced state ->
 * back to live. Dev-only affordance, compiled out of release builds.
 *
 * HomeScreen remains the only `useVoterApp()` caller on this surface (SHELL-03) — `ElectionCard`
 * is presentational (election prop + navigation callback props), never reading the provider or
 * `useNavigation()` itself (RESEARCH.md Anti-Patterns).
 *
 * The saved-vote state (D-12, D-19) is read from the stored marker through `readSavedVoteStatus` on
 * every focus. It is never cached, needs no fingerprint, and Home never holds the record. The card
 * shows the saved-vote line from `readSavedVoteStatus` with a link to the receipt, the stale line when the election
 * changed after the vote (D-21), or an unreadable state. Vote now is hidden while a current vote
 * is saved (a local convenience, D-20).
 */
import React, {useCallback, useRef, useState} from 'react';
import {AppState, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useNetworkName} from '../../hooks/useNetworkName';
import {LIFECYCLE_ORDER} from '../../providers/types';
import type {LifecycleState, VoterElection} from '../../providers/types';
import type {VoteStackParamList} from '../../navigation/types';
import {ElectionCard} from '../../components/ElectionCard';
import {NetworkHeader} from '../../components/NetworkHeader';
import {ConfigFaultNotice} from '../../components/ConfigFaultNotice';
import {InfoDialog} from '../../components/InfoDialog';
import {InfoDetails} from '../../components/InfoDetails';
import {readElectionInfo} from '../../engines/info-read';
import {readSavedVoteStatus, readSentSinceShown} from '../../engines/saved-vote-status';
import type {SavedVoteStatus} from '../../engines/saved-vote-status';
import {idPrefix, vtDebug} from '../../engines/vt-debug';
import {useInfoRead} from '../../hooks/useInfoRead';

type HomeNavigationProp = NativeStackNavigationProp<VoteStackParamList, 'Home'>;

/** How often a focused Home re-checks a network that lists no election yet (see the read effect). */
export const ELECTION_LIST_RECHECK_MS = 10_000;

/** Whether the current network lists an election. A failed read counts as no: keep waiting. */
async function networkListsAnElection(
	getEngine: <T>(engineName: string) => Promise<T>,
): Promise<boolean> {
	try {
		const elections = await getEngine<{getElections(): Promise<unknown[]>}>('elections');
		return (await elections.getElections()).length > 0;
	} catch {
		return false;
	}
}

export default function HomeScreen() {
	// D-06/SHELL-03: every screen routes through useVoterApp() — no inline fixture-module import.
	const {isInitialized, lifecycleOverride, setLifecycleOverride, clockOffsetMs, nowMs, getElection, getEngine, seededElectionId, hasNetwork} = useVoterApp();
	const networkName = useNetworkName();
	const {colors, type: typeScale} = useTheme() as ExtendedTheme;
	const {t, i18n} = useTranslation('home');
	const {t: tCommon} = useTranslation('common');
	const navigation = useNavigation<HomeNavigationProp>();
	const [election, setElection] = useState<VoterElection | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const [electionInfoVisible, setElectionInfoVisible] = useState(false);
	const [savedVote, setSavedVote] = useState<{electionId: string; status: SavedVoteStatus} | null>(null);
	// The line on screen, for the focus read below (a ref, so the focus effect does not re-run on it).
	const shownSavedVote = useRef(savedVote);
	shownSavedVote.current = savedVote;
	// The election dialog's authority-published detail, read only while the dialog is open.
	const loadElectionInfo = useCallback(
		() => readElectionInfo({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}),
		[getEngine, seededElectionId],
	);
	const electionInfo = useInfoRead(electionInfoVisible ? loadElectionInfo : null);
	const info = electionInfo.data;

	// Fetch on every focus, and again whenever getElection's identity changes (it changes with
	// lifecycleOverride and the dev clock, VoterAppProvider's useCallback deps, so the cycler and a
	// shared dev-clock shift, D-02, re-fetch) or a network is attached (hasNetwork: a join selects
	// the joined network). A rejected read (no election on this network, or an indeterminate
	// timeline) renders the unavailable message, never a stale or guessed card.
	//
	// While the network lists NO election, the read falls back to the __DEV__ seed (pickElectionId)
	// or is unavailable, and nothing else tells Home when a joined network's election replicates
	// in. So, only in that state and only while focused, the list alone is re-checked every
	// ELECTION_LIST_RECHECK_MS, and the election is re-read once the list names one. Home mounted
	// before a join used to keep the dev-seed card for good (iPhone, 2026-10-29).
	//
	// A focused Home would otherwise keep a lifecycle snapshot past its boundary (UAT 65 gap 3, D-97),
	// so two more re-reads run: one timer armed at the read's countdownTarget (+1 s, clamped), which
	// re-arms from the next read, and one when the app returns to the foreground (JS timers pause in
	// the background). Both are cleared on blur and unmount.
	useFocusEffect(
		useCallback(() => {
			let live = true;
			let recheck: ReturnType<typeof setTimeout> | undefined;
			let boundary: ReturnType<typeof setTimeout> | undefined;
			const read = (): void => {
				getElection().then(
					result => {
						if (live) {
							setElection(result);
							setUnavailable(false);
							if (boundary !== undefined) {
								clearTimeout(boundary);
								boundary = undefined;
							}
							const target = result.countdownTarget === undefined ? NaN : Date.parse(result.countdownTarget);
							if (Number.isFinite(target)) {
								const delay = Math.min(2 ** 31 - 1, Math.max(0, target - nowMs() + 1000));
								boundary = setTimeout(read, delay);
							}
						}
					},
					() => {
						if (live) {
							setElection(null);
							setUnavailable(true);
						}
					},
				);
			};
			const awaitListedElection = () => {
				recheck = setTimeout(() => {
					networkListsAnElection(getEngine).then(listed => {
						if (!live) {
							return;
						}
						if (listed) {
							read();
						} else {
							awaitListedElection();
						}
					});
				}, ELECTION_LIST_RECHECK_MS);
			};
			read();
			if (hasNetwork) {
				networkListsAnElection(getEngine).then(listed => {
					if (live && !listed) {
						awaitListedElection();
					}
				});
			}
			const appState = AppState.addEventListener('change', state => {
				if (state === 'active') {
					read();
				}
			});
			return () => {
				live = false;
				appState.remove();
				if (recheck !== undefined) {
					clearTimeout(recheck);
				}
				if (boundary !== undefined) {
					clearTimeout(boundary);
				}
			};
		}, [getElection, getEngine, hasNetwork, nowMs]),
	);

	// Re-read the marker on every focus, so returning from the receipt or from Submit shows the
	// fresh state. The `nowMs` identity changes with the dev clock (D-02). Nothing is cached, and a
	// failed read fails closed to unreadable (the error is never read or logged).
	//
	// UAT 65 gap 2: the full read waits on the strand's election read before it looks at the sent
	// store, and the first return to Home right after a send kept "not sent" on screen for 9 s or
	// more. So a saved line, and a none line (WR-03: the usual path vote -> Submit -> Send -> Done ->
	// Home left Home's pre-vote line), are first checked against the marker and the sent store alone
	// (no engine read): either turns sent at once when every ballot is in the sent store, and nothing
	// else changes early. Nothing shown yet (a cold start) waits for the full read, which always lands
	// after the fast one and has the last word.
	const electionId = election?.id;
	useFocusEffect(
		useCallback(() => {
			let live = true;
			let fullLanded = false;
			if (electionId) {
				// debug only (silent unless the __DEV__ switch is on): states and timings, never the record
				const readAt = Date.now();
				const election = idPrefix(electionId);
				// Only this election's line counts as shown: a line read for another election is nothing shown.
				const shownForThis = shownSavedVote.current?.electionId === electionId ? shownSavedVote.current.status : undefined;
				vtDebug('home', 'saved-vote-read-start', {election, shown: shownForThis?.state ?? 'none'});
				readSentSinceShown(electionId, shownForThis).then(
					fast => {
						vtDebug('home', 'saved-vote-fast-read', {election, state: fast?.state ?? 'keep', applied: live && !fullLanded && fast !== null, dropped: !live, fullLanded, ms: Date.now() - readAt});
						if (live && !fullLanded && fast !== null) {
							setSavedVote({electionId, status: fast});
						}
					},
					() => undefined,
				);
				readSavedVoteStatus({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined}, nowMs(), electionId).then(
					status => {
						fullLanded = true;
						vtDebug('home', 'saved-vote-full-read', {election, state: status.state, ms: Date.now() - readAt, dropped: !live});
						if (live) {
							setSavedVote({electionId, status});
						}
					},
					() => {
						fullLanded = true;
						vtDebug('home', 'saved-vote-full-read', {election, state: 'unreadable', failed: true, ms: Date.now() - readAt, dropped: !live});
						if (live) {
							setSavedVote({electionId, status: {state: 'unreadable'}});
						}
					},
				);
			}
			return () => {
				live = false;
			};
		}, [electionId, getEngine, seededElectionId, nowMs]),
	);
	// Per-election binding: a status read for one election never decorates another.
	const cardSavedVote = savedVote && savedVote.electionId === electionId ? savedVote.status : undefined;

	// live -> LIFECYCLE_ORDER[0] -> ... -> LIFECYCLE_ORDER[last] -> live.
	const nextLifecycleOverride = () => {
		const currentIndex = lifecycleOverride === null ? -1 : LIFECYCLE_ORDER.indexOf(lifecycleOverride);
		const next: LifecycleState | null =
			currentIndex + 1 < LIFECYCLE_ORDER.length ? LIFECYCLE_ORDER[currentIndex + 1] : null;
		setLifecycleOverride(next);
	};

	return (
		<View style={[styles.screen, {backgroundColor: colors.background}]}>
			<NetworkHeader networkName={networkName} />
			<ConfigFaultNotice />

			<ScrollView contentContainerStyle={styles.content}>
				{isInitialized && election ? (
					<ElectionCard
						election={election}
						onVoteNow={() => navigation.navigate('Ballot')}
						onViewValidationDetails={() => navigation.navigate('ValidationDetails')}
						onLearnAboutElection={() => setElectionInfoVisible(true)}
						savedVote={cardSavedVote}
						// Params carry only electionId and no `revealOnOpen`, so a later visit asks for a fingerprint (D-13, R-4).
						onViewSavedVote={() => navigation.navigate('VoteReceipt', {electionId: election.id})}
						nowOffsetMs={clockOffsetMs}
					/>
				) : null}

				{isInitialized && unavailable ? (
					<Text
						testID="home-election-unavailable"
						style={{color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}}>
						{t('electionUnavailable')}
					</Text>
				) : null}

				{/* D-03: __DEV__-gated lifecycle cycler — never ships to release builds. Dev-only
				    text, deliberately not localized (it is not user-facing copy). */}
				{__DEV__ && isInitialized ? (
					<Pressable testID="home-dev-lifecycle-cycler" onPress={nextLifecycleOverride} style={styles.devCycler}>
						<Text style={{color: colors.muted, fontSize: typeScale.caption.fontSize}}>
							Dev state: {lifecycleOverride ?? 'live'} (tap to cycle)
						</Text>
					</Pressable>
				) : null}
			</ScrollView>

			<InfoDialog
				visible={electionInfoVisible}
				title={t('electionInfo.title')}
				subtitle={t('electionInfo.subtitle')}
				body={t('electionInfo.body')}
				closeLabel={tCommon('close')}
				onClose={() => setElectionInfoVisible(false)}>
				<InfoDetails
					testID="election-info-details"
					loading={electionInfo.loading}
					failed={electionInfo.failed}
					unavailableLabel={tCommon('info.unavailable')}
					rows={[
						{label: t('electionInfo.authority'), value: info?.authorityName},
						{label: t('electionInfo.date'), value: info ? formatElectionDay(info.date, i18n.language) : undefined},
						{label: t('electionInfo.instructions'), value: info?.instructions},
						{label: t('electionInfo.tags'), value: info?.tags.join(', ')},
					]}
				/>
			</InfoDialog>
		</View>
	);
}

/** `Election.Date` is a DAY stored as a datetime at UTC midnight — format it in UTC so a voter west
 *  of Greenwich doesn't see the day before. */
function formatElectionDay(ms: number, language: string): string {
	return new Intl.DateTimeFormat(language, {timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'}).format(new Date(ms));
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	content: {
		padding: 16,
	},
	devCycler: {
		alignSelf: 'center',
		paddingVertical: 8,
	},
});
