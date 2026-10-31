/**
 * SendVoteCard — "Send your vote" on the vote receipt (spike 102, applied).
 *
 * A saved vote is sent together with at least 2 other voters' votes (a vote pool) through the
 * authority's rendezvous. The card shows, per ballot, whether it is waiting for voters, waiting to
 * be confirmed, sent, or not sent — and what that means for the vote (it stays saved on this phone
 * until it is sent). All work runs through `engines/vote-send-flow.ts`; this component only keeps
 * the statuses and never holds the opened record. No raw error text is ever shown.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Platform, Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {runVoteSendFlow} from '../../engines/vote-send-flow';
import type {VoteSendFlowResult} from '../../engines/vote-send-flow';
import type {BallotSendStatus} from '../../engines/vote-sending';
import type {VoteRecordEnvelope} from '../../engines/vote-record-vault';
import {readVoteSent} from '../../engines/vote-sent-store';

type Outcome = Exclude<VoteSendFlowResult, {kind: 'done'}>['kind'];

const OUTCOME_KEY: Record<Outcome, string> = {
	'no-network': 'send.noNetwork',
	'no-rendezvous': 'send.noRendezvous',
	// no joined address answered: reuses existing copy (D-61, no new strings)
	'rendezvous-unreachable': 'send.failed',
	canceled: 'send.canceled',
	// resolved per platform at render (the biometric copy names the platform's own biometric)
	'biometric-unavailable': 'send.biometricUnavailable',
	unreadable: 'send.failed',
	failed: 'send.failed',
	'voting-closed': 'send.votingClosed',
	'election-key-missing': 'send.keyMissing',
	'window-unreadable': 'send.windowUnreadable',
};

export interface SendVoteCardProps {
	electionId: string
	electionRevision: number
	envelope: VoteRecordEnvelope
	/** the saved vote's ballots, in record order */
	ballotIds: readonly string[]
	/** told whenever "every ballot has been sent" changes, so the receipt stops saying "not sent" */
	onAllSentChange?: (allSent: boolean) => void
}

export default function SendVoteCard({electionId, electionRevision, envelope, ballotIds, onAllSentChange}: SendVoteCardProps) {
	const {getEngine, nowMs, getNetworkNode} = useVoterApp();
	const node = getNetworkNode();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');
	// The biometric copy names the platform's own biometric (D-101); literal keys per branch so the
	// i18n parity scan resolves every key.
	const isIos = Platform.OS === 'ios';
	const [statuses, setStatuses] = useState<Record<string, BallotSendStatus>>({});
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [sending, setSending] = useState(false);
	const mounted = useRef(true);
	const abort = useRef<AbortController | null>(null);

	useEffect(() => {
		mounted.current = true;
		readVoteSent(electionId, electionRevision)
			.then(sent => {
				if (!mounted.current) return;
				const known: Record<string, BallotSendStatus> = {};
				for (const [ballotId, cid] of Object.entries(sent)) known[ballotId] = {phase: 'sent', cid};
				setStatuses(prev => ({...known, ...prev}));
			})
			.catch(() => undefined);
		return () => {
			mounted.current = false;
			abort.current?.abort();
		};
	}, [electionId, electionRevision]);

	const allSent = ballotIds.length > 0 && ballotIds.every(id => statuses[id]?.phase === 'sent');
	useEffect(() => { onAllSentChange?.(allSent); }, [allSent, onAllSentChange]);

	const onSend = useCallback(async () => {
		if (sending) return;
		setSending(true);
		setOutcome(null);
		const controller = new AbortController();
		abort.current = controller;
		const consentPrompt = {
			title: t('send.consentPrompt.title'),
			subtitle: t('send.consentPrompt.subtitle'),
			negativeButton: t('send.consentPrompt.negativeButton'),
		};
		const recordPrompt = {
			title: t('send.recordPrompt.title'),
			subtitle: isIos ? t('send.recordPrompt.subtitle') : t('send.recordPrompt.subtitle.android'),
			negativeButton: t('send.recordPrompt.negativeButton'),
		};
		const result = await runVoteSendFlow({
			electionId,
			envelope,
			getEngine,
			node,
			recordPrompt,
			consentPrompt,
			nowMs,
			signal: controller.signal,
			onStatus: (ballotId, status) => {
				if (mounted.current) setStatuses(prev => ({...prev, [ballotId]: status}));
			},
		}).catch((): VoteSendFlowResult => ({kind: 'failed'}));
		if (!mounted.current) return;
		setSending(false);
		if (result.kind === 'done') {
			setStatuses(prev => {
				const next = {...prev};
				for (const b of result.ballots) next[b.ballotId] = b.status;
				return next;
			});
		} else {
			setOutcome(result.kind);
		}
	}, [sending, t, isIos, electionId, envelope, getEngine, node, nowMs]);

	const bodyFont = {fontFamily: fonts.regular.fontFamily, fontWeight: fonts.regular.fontWeight, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	const captionFont = {fontFamily: fonts.regular.fontFamily, fontWeight: fonts.regular.fontWeight, fontSize: typeScale.caption.fontSize, lineHeight: typeScale.caption.lineHeight};
	const mediumFont = {fontFamily: fonts.medium.fontFamily, fontWeight: fonts.medium.fontWeight};

	const lineFor = (status: BallotSendStatus | undefined): {text: string, tone: 'ok' | 'muted' | 'warn'} | null => {
		if (status === undefined) return null;
		switch (status.phase) {
			case 'waiting': return {text: t('send.waiting', {size: status.size}), tone: 'muted'};
			case 'joined': return {text: t('send.joined'), tone: 'muted'};
			case 'confirming': return {text: isIos ? t('send.confirming') : t('send.confirming.android'), tone: 'muted'};
			case 'sent': return {text: t('send.sent'), tone: 'ok'};
			case 'not-sent': return {text: t(status.reason === 'voting-closed' ? 'send.notSentClosed' : 'send.notSent'), tone: 'warn'};
		}
	};
	const toneColor = {ok: colors.success, muted: colors.textSecondary, warn: colors.error};
	const anyNotSent = ballotIds.some(id => statuses[id]?.phase === 'not-sent');

	return (
		<View testID="send-vote-card" style={styles.block}>
			<Text style={[bodyFont, mediumFont, {color: colors.text}]}>{t('send.heading')}</Text>
			{allSent ? (
				<Text testID="send-all-sent" style={[styles.line, bodyFont, mediumFont, {color: colors.success}]}>
					{t('send.allSent')}
				</Text>
			) : (
				<Text style={[styles.line, captionFont, {color: colors.textSecondary}]}>{t('send.explain')}</Text>
			)}
			{ballotIds.length > 1 || Object.keys(statuses).length > 0
				? ballotIds.map((ballotId, i) => {
					const line = lineFor(statuses[ballotId]);
					return line === null ? null : (
						<Text key={ballotId} testID={`send-ballot-${i}`} style={[styles.line, bodyFont, {color: toneColor[line.tone]}]}>
							{ballotIds.length > 1 ? `${t('send.ballotLabel', {index: i + 1})}: ` : ''}{line.text}
						</Text>
					);
				})
				: null}
			{!allSent ? (
				<>
					<Pressable
						testID="send-vote"
						accessibilityRole="button"
						disabled={sending}
						onPress={() => { void onSend(); }}
						style={[styles.button, {backgroundColor: colors.primary, borderRadius: radii.pill, opacity: sending ? 0.5 : 1}]}>
						<Text style={[styles.buttonLabel, {color: colors.background}]}>
							{t(anyNotSent || outcome !== null ? 'send.retryCta' : 'send.cta')}
						</Text>
					</Pressable>
					<Text style={[styles.line, captionFont, {color: colors.textSecondary}]}>{isIos ? t('send.hint') : t('send.hint.android')}</Text>
				</>
			) : null}
			{outcome !== null ? (
				<Text testID="send-outcome" style={[styles.line, bodyFont, {color: colors.error}]}>{outcome === 'biometric-unavailable'
					? (isIos ? t('send.biometricUnavailable') : t('send.biometricUnavailable.android'))
					: t(OUTCOME_KEY[outcome])}</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	block: {marginTop: 16},
	line: {marginTop: 8},
	button: {minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 12, marginTop: 12},
	buttonLabel: {fontWeight: '600'},
});
