/**
 * SavedVoteNotice - the saved-vote state line shared by the Home election card and the Timeline
 * Voting Period panel (Phase 63 plan 14; D-12, D-19, D-21).
 *
 * Presentational: props only, no `useVoterApp`, no `useNavigation`, no storage. The status comes
 * from `readSavedVoteStatus` in the screen. One component means one source for the wording. It
 * reuses the receipt's stale, unreadable and revision-unknown keys, so the D-21 line is the same
 * everywhere it appears. A fully sent vote shows the ballot screen's own sent sentence
 * (`send.allSent`) so the surfaces read the same. The wording is plain and never promises that the vote will be sent.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import type {SavedVoteStatus} from '../engines/saved-vote-status';

export function SavedVoteNotice({status, onView, testID}: {status: SavedVoteStatus; onView?: () => void; testID: string}) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('ballot');

	if (status.state === 'none') return null;

	return (
		<View testID={testID}>
			{status.state === 'saved' ? (
				<Text
					testID={`${testID}-status`}
					style={{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					}}>
					{t('savedVote.status')}
				</Text>
			) : null}
			{status.state === 'sent' ? (
				<Text
					testID={`${testID}-sent`}
					style={{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					}}>
					{t('send.allSent')}
				</Text>
			) : null}
			{status.state === 'saved' && !status.revisionKnown ? (
				<Text
					testID={`${testID}-revision-unknown`}
					style={{
						color: colors.textSecondary,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.caption.fontSize,
						lineHeight: typeScale.caption.lineHeight,
						marginTop: 4,
					}}>
					{t('receipt.revisionUnknown')}
				</Text>
			) : null}
			{status.state === 'stale' ? (
				<Text
					testID={`${testID}-stale`}
					style={{
						color: colors.error,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					}}>
					{t('receipt.stale')}
				</Text>
			) : null}
			{status.state === 'unreadable' ? (
				<Text
					testID={`${testID}-unreadable`}
					style={{
						color: colors.error,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					}}>
					{t('receipt.unreadable')}
				</Text>
			) : null}
			{onView ? (
				<Pressable testID={`${testID}-view`} accessibilityRole="button" onPress={onView} style={styles.viewLink}>
					<Text
						style={{
							color: colors.link,
							fontFamily: fonts.bold.fontFamily,
							fontWeight: fonts.bold.fontWeight,
							fontSize: typeScale.body.fontSize,
							textDecorationLine: 'underline',
						}}>
						{t('savedVote.viewCta')}
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	viewLink: {
		alignSelf: 'flex-start',
		justifyContent: 'center',
		minHeight: 44,
		minWidth: 44,
	},
});
