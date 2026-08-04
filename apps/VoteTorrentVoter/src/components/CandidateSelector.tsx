/**
 * CandidateSelector (VOTE-01/02, 42-RESEARCH Pattern 6) — a presentational radio (voteFor=1) /
 * capped-checkbox (voteFor>1) candidate list for the Individual Question modal.
 *
 * Presentational-only — `candidates`/`selectedIds`/`voteFor`/`onToggle` props in, no internal
 * selection state; the caller (IndividualQuestionScreen, Plan 06) owns selection via
 * `BallotSelectionProvider` and resolves display strings (candidate name/party) before passing
 * them down. Does NOT call `useVoterApp()`/`useNavigation()` — mirrors PartyChipSelector's
 * presentational discipline.
 *
 * Selected-row color is `colors.success` (#4caf50, Figma "Voter's selection"), a DISTINCT token
 * from the primary brand color — reusing PartyChipSelector's selected-chip token here would be a
 * silent visual regression against the Phase-38-reconciled token table (RESEARCH Anti-Patterns).
 *
 * At-cap affordance (voteFor>1, selectedIds.length >= voteFor): unselected rows render a
 * disabled-look (reduced opacity + muted border) but stay tappable — D-03 forbids new validation
 * UI beyond the cap itself; a tap on an at-cap unselected row still calls onToggle and no-ops
 * harmlessly via the provider's cap logic (no hard `disabled` prop on Pressable).
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {globalStyles} from '../theme/styles';

export interface Candidate {
	id: string;
	name: string;
	party: string;
}

export interface CandidateSelectorProps {
	candidates: Candidate[];
	selectedIds: string[];
	voteFor: number;
	onToggle: (candidateId: string) => void;
	/** Caller-resolved (i18n) "Learn about this candidate" link text. Link renders only when set. */
	learnLabel?: string;
	/** Opens the candidate-info dialog for the tapped candidate (caller owns dialog state). */
	onLearnAboutCandidate?: (candidateId: string) => void;
}

export function CandidateSelector({candidates, selectedIds, voteFor, onToggle, learnLabel, onLearnAboutCandidate}: CandidateSelectorProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const atCap = voteFor > 1 && selectedIds.length >= voteFor;

	return (
		<View style={styles.list}>
			{candidates.map(candidate => {
				const selected = selectedIds.includes(candidate.id);
				const disabledLook = atCap && !selected;
				return (
					<Pressable
						key={candidate.id}
						testID={`candidate-row-${candidate.id}`}
						accessibilityRole={voteFor === 1 ? 'radio' : 'checkbox'}
						accessibilityState={{selected, disabled: disabledLook}}
						onPress={() => onToggle(candidate.id)}
						style={[
							globalStyles.cardSurface,
							styles.row,
							{
								backgroundColor: colors.card,
								opacity: disabledLook ? 0.5 : 1,
							},
						]}>
						<View style={styles.textCol}>
							<Text
								style={{
									color: colors.text,
									fontFamily: fonts.bold.fontFamily,
									fontWeight: fonts.bold.fontWeight,
									fontSize: typeScale.body.fontSize,
									lineHeight: typeScale.body.lineHeight,
								}}>
								{candidate.name}
							</Text>
							<Text
								style={{
									color: colors.textSecondary,
									fontFamily: fonts.regular.fontFamily,
									fontWeight: fonts.regular.fontWeight,
									fontSize: typeScale.caption.fontSize,
									lineHeight: typeScale.caption.lineHeight,
								}}>
								{candidate.party}
							</Text>
							{/* Figma: "Learn about this candidate" lives inside the candidate card. Nested
								Pressable so tapping it opens the info dialog without toggling selection. */}
							{learnLabel && onLearnAboutCandidate ? (
								<Pressable
									testID={`candidate-learn-${candidate.id}`}
									onPress={() => onLearnAboutCandidate(candidate.id)}
									hitSlop={6}
									style={styles.learnLink}>
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
							) : null}
						</View>

						{/* Radio / checkbox indicator on the RIGHT (Figma). */}
						<FontAwesome6
							name={
								voteFor === 1
									? selected
										? 'circle-check'
										: 'circle'
									: selected
										? 'square-check'
										: 'square'
							}
							size={22}
							color={selected ? colors.success : colors.muted}
						/>
					</Pressable>
				);
			})}
		</View>
	);
}

export default CandidateSelector;

const styles = StyleSheet.create({
	// Inter-card spacing comes from globalStyles.cardSurface's own margins (elevated shadow card).
	list: {},
	row: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 16,
		minHeight: 44, // >=44px touch target
	},
	textCol: {
		flex: 1,
	},
	learnLink: {
		alignSelf: 'flex-start',
		marginTop: 6,
	},
});
