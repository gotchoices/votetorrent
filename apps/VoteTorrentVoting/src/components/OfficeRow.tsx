/**
 * OfficeRow (VOTE-01, 42-RESEARCH Recommended Project Structure) — a presentational office card
 * on the Ballot Page: title, current-selection summary, "Learn about this office" link,
 * tap-to-open-question.
 *
 * Presentational-only — `title`/`selectionSummary`/`hasSelection`/`learnLabel`/`onOpen`/
 * `onLearnAboutOffice` props in, no internal state; the caller (BallotScreen, Plan 05) owns
 * `selectionMap` reads and resolves the joined selected-candidate names (or the localized
 * "Not yet answered" copy) and the "Learn about this office" link text before passing them down.
 * Does NOT call `useVotingApp()`/`useNavigation()` — mirrors PartyChipSelector/ElectionCard's
 * presentational discipline. No i18n inside this component.
 *
 * Deviation (Rule 2 — missing critical functionality): the plan's prop list didn't include a
 * label prop for the learn link's text, but "No i18n inside" requires the caller to supply every
 * displayed string (mirrors `title`/`selectionSummary`) — `learnLabel` was added so the link
 * renders real, screen-resolved i18n copy instead of a hard-coded English literal.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {globalStyles} from '../theme/styles';

export interface OfficeRowProps {
	title: string;
	/** Caller-resolved: joined selected candidate names, or the resolved "Not yet answered" copy. */
	selectionSummary: string;
	hasSelection: boolean;
	/** Caller-resolved (i18n) "Learn about this office" link text. */
	learnLabel: string;
	onOpen: () => void;
	onLearnAboutOffice: () => void;
}

export function OfficeRow({title, selectionSummary, hasSelection, learnLabel, onOpen, onLearnAboutOffice}: OfficeRowProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;

	return (
		<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
			<Pressable testID="office-row-open" onPress={onOpen} style={styles.openArea}>
				<Text
					style={{
						color: colors.text,
						fontFamily: fonts.medium.fontFamily,
						fontWeight: fonts.medium.fontWeight,
						fontSize: typeScale.h4.fontSize,
						lineHeight: typeScale.h4.lineHeight,
					}}>
					{title}
				</Text>
				<Text
					style={[
						styles.summary,
						{
							color: hasSelection ? colors.success : colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{selectionSummary}
				</Text>
			</Pressable>
			<Pressable testID="office-row-learn" onPress={onLearnAboutOffice} style={styles.learnLink}>
				<Text
					style={{
						color: colors.link,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.caption.fontSize,
						lineHeight: typeScale.caption.lineHeight,
						textDecorationLine: 'underline',
					}}>
					{learnLabel}
				</Text>
			</Pressable>
		</View>
	);
}

export default OfficeRow;

const styles = StyleSheet.create({
	openArea: {
		minHeight: 44, // >=44px touch target
	},
	summary: {
		marginTop: 4,
	},
	learnLink: {
		alignSelf: 'flex-start',
		marginTop: 12,
		minHeight: 44,
		justifyContent: 'center',
	},
});
