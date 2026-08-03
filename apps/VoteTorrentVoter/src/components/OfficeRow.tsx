/**
 * OfficeRow (VOTE-01, Figma Ballot frame 2764:1181) — a presentational office card on the Ballot
 * Page. Left column: office title + "Learn about this office" link, plus the green selection
 * summary when answered. Right side: a green check circle when answered, otherwise a chevron
 * (tap-to-open). No "Not yet answered" copy — an unanswered office simply shows the chevron.
 *
 * Presentational-only — `title`/`selectionSummary`/`hasSelection`/`learnLabel`/`onOpen`/
 * `onLearnAboutOffice` props in, no internal state; the caller (BallotScreen) owns `selectionMap`
 * reads and resolves the joined selected-candidate names + the "Learn about this office" link text
 * before passing them down. Does NOT call `useVoterApp()`/`useNavigation()`. No i18n inside.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';

export interface OfficeRowProps {
	title: string;
	/** Caller-resolved: joined selected candidate names. Only shown when `hasSelection` is true. */
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
		<View style={[globalStyles.cardSurface, styles.card, {backgroundColor: colors.card}]}>
			<View style={styles.main}>
				<Pressable testID="office-row-open" onPress={onOpen}>
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
				</Pressable>
				<Pressable testID="office-row-learn" onPress={onLearnAboutOffice} style={styles.learnLink} hitSlop={6}>
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
				{hasSelection ? (
					<Text
						testID="office-row-selection"
						style={[
							styles.summary,
							{
								color: colors.success,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{selectionSummary}
					</Text>
				) : null}
			</View>

			<Pressable
				testID="office-row-indicator"
				onPress={onOpen}
				hitSlop={8}
				style={styles.indicator}
				accessibilityRole="button">
				{hasSelection ? (
					<View testID="office-row-check" style={[styles.checkCircle, {backgroundColor: colors.success}]}>
						<FontAwesome6 name="check" size={14} color={colors.light} />
					</View>
				) : (
					<FontAwesome6 testID="office-row-chevron" name="chevron-right" size={18} color={colors.textSecondary} />
				)}
			</Pressable>
		</View>
	);
}

export default OfficeRow;

const styles = StyleSheet.create({
	card: {
		flexDirection: 'row',
		alignItems: 'center',
	},
	main: {
		flex: 1,
	},
	learnLink: {
		alignSelf: 'flex-start',
		marginTop: 4,
	},
	summary: {
		marginTop: 8,
	},
	indicator: {
		marginLeft: 16,
		alignItems: 'center',
		justifyContent: 'center',
	},
	checkCircle: {
		width: 28,
		height: 28,
		borderRadius: 14,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
