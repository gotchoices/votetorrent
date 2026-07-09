/**
 * PartyChipSelector (REG-03) — hand-rolled 4-chip single-select row (Democratic Party /
 * Republican Party / Independent / Other), avoiding a new native `Picker` dependency (Registry
 * Safety: zero new packages). Adapted from `ElectionCard.tsx`'s Pressable action-button styling
 * (lines 196-220) into a wrapping row of pill chips.
 *
 * Presentational-only — options/value/onChange props in, no internal selection state; the
 * caller (RegistrationDraftProvider, D-03) owns the selected value. Does NOT call
 * useVotingApp()/useNavigation(). Single-select radio behavior: tapping a chip calls
 * onChange(option.label); the 4 option labels/i18n resolution are the caller's responsibility.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';

export interface PartyChipOption {
	key: string;
	label: string;
}

export interface PartyChipSelectorProps {
	options: PartyChipOption[];
	value: string;
	onChange: (label: string) => void;
}

export function PartyChipSelector({options, value, onChange}: PartyChipSelectorProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;

	return (
		<View style={styles.row}>
			{options.map(option => {
				const selected = value === option.label;
				return (
					<Pressable
						key={option.key}
						testID={`party-chip-${option.key}`}
						accessibilityRole="radio"
						accessibilityState={{selected}}
						onPress={() => onChange(option.label)}
						style={[
							styles.chip,
							{
								borderRadius: radii.pill,
								borderWidth: selected ? 2 : 1,
								// selected: colors.primary outline + colors.secondaryButtonSurface fill;
								// unselected: colors.border outline + colors.card fill (D-02/D-06 tokens)
								borderColor: selected ? colors.primary : colors.border,
								backgroundColor: selected ? colors.secondaryButtonSurface : colors.card,
							},
						]}>
						<Text
							style={{
								color: selected ? colors.primary : colors.text,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							}}>
							{option.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

export default PartyChipSelector;

const styles = StyleSheet.create({
	row: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8, // sm/8px gap between chips
	},
	chip: {
		minHeight: 44, // >=44px touch target
		paddingHorizontal: 16, // md/16px horizontal padding
		paddingVertical: 8, // sm/8px vertical padding
		alignItems: 'center',
		justifyContent: 'center',
	},
});
