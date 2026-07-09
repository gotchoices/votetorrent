/**
 * LabeledTextInput (REG-03, D-02 mock-permissive) — label above a controlled `TextInput`,
 * used across all Registration form-step text fields (First/Last Name, DOB, Email, Phone,
 * Address lines). Write-through only: bound directly to the caller's `value`/`onChangeText`
 * with NO internal `useState` buffer, so the caller's draft (RegistrationDraftProvider, D-03)
 * is always the single source of truth. Presentational-only — does NOT call useVotingApp() or
 * useNavigation() (ElectionCard discipline); every prop is data-in/callback-out.
 *
 * D-02 (mock-permissive form): no error/required/red-outline styling and no inline validation
 * message — the border stays `colors.border` regardless of field content.
 */
import React from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';

export interface LabeledTextInputProps {
	label: string;
	value: string;
	onChangeText: (value: string) => void;
	placeholder?: string;
	testID?: string;
}

export function LabeledTextInput({label, value, onChangeText, placeholder, testID}: LabeledTextInputProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;

	return (
		<View style={styles.field}>
			<Text
				style={[
					styles.label,
					{
						color: colors.textSecondary, // type.caption/colors.textSecondary
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.caption.fontSize,
						lineHeight: typeScale.caption.lineHeight,
					},
				]}>
				{label}
			</Text>
			<TextInput
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={colors.textSecondary}
				testID={testID}
				style={[
					styles.input,
					{
						borderColor: colors.border, // colors.border 1px outline — no error state (D-02)
						borderRadius: radii.md, // radii.md corners
						backgroundColor: colors.card, // colors.card background
						color: colors.text, // colors.text entered-text
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
						lineHeight: typeScale.body.lineHeight,
					},
				]}
			/>
		</View>
	);
}

export default LabeledTextInput;

const styles = StyleSheet.create({
	field: {
		marginBottom: 16, // md spacing between stacked fields
	},
	label: {
		marginBottom: 4, // xs/4px gap above the input box
	},
	input: {
		borderWidth: 1,
		paddingHorizontal: 16, // md/16px horizontal padding
		paddingVertical: 16, // md/16px vertical padding (>=44px total height)
	},
});
