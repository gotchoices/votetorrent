/**
 * FieldGroup (REG-03) — the grouped-field card pattern from the Figma register frames
 * (2868:1522 / 2891:1542): related fields sit inside ONE rounded, lightly-bordered card as rows
 * with the field name shown as an in-line placeholder label and a hairline divider between rows
 * (no per-field bordered box, no separate label above). Replaces the earlier LabeledTextInput
 * layout on the register steps.
 *
 * `FieldGroupCard` is the card shell (inserts dividers between its children); `FieldRow` is one
 * borderless input row. Both presentational-only. Masking (e.g. DOB → MM/DD/YYYY) is applied by
 * the caller via onChangeText, keeping FieldRow generic.
 */
import React from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import type {KeyboardTypeOptions} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';

export function FieldGroupCard({children}: {children: React.ReactNode}) {
	const {colors, radii} = useTheme() as ExtendedTheme;
	const items = React.Children.toArray(children).filter(Boolean);

	return (
		<View
			style={[
				styles.card,
				{backgroundColor: colors.card, borderColor: colors.border, borderRadius: radii.lg},
			]}>
			{items.map((child, i) => (
				<React.Fragment key={i}>
					{i > 0 ? (
						<View style={[styles.divider, {backgroundColor: colors.border}]} />
					) : null}
					{child}
				</React.Fragment>
			))}
		</View>
	);
}

export interface FieldRowProps {
	placeholder: string;
	value: string;
	onChangeText: (value: string) => void;
	testID?: string;
	keyboardType?: KeyboardTypeOptions;
	autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
	maxLength?: number;
	/** Resolved, localized error message — shown in error color below the input when set. */
	error?: string;
}

export function FieldRow({
	placeholder,
	value,
	onChangeText,
	testID,
	keyboardType,
	autoCapitalize,
	maxLength,
	error,
}: FieldRowProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;

	return (
		<View style={styles.row}>
			<TextInput
				testID={testID}
				value={value}
				onChangeText={onChangeText}
				placeholder={placeholder}
				placeholderTextColor={error ? colors.error : colors.textSecondary}
				keyboardType={keyboardType}
				autoCapitalize={autoCapitalize}
				maxLength={maxLength}
				style={{
					color: colors.text,
					fontFamily: fonts.regular.fontFamily,
					fontWeight: fonts.regular.fontWeight,
					fontSize: typeScale.body.fontSize,
					lineHeight: typeScale.body.lineHeight,
					padding: 0, // strip the platform default padding — the card row owns the spacing
				}}
			/>
			{error ? (
				<Text
					testID={testID ? `${testID}-error` : undefined}
					style={[
						styles.error,
						{
							color: colors.error,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.caption.fontSize,
							lineHeight: typeScale.caption.lineHeight,
						},
					]}>
					{error}
				</Text>
			) : null}
		</View>
	);
}

export default FieldGroupCard;

const styles = StyleSheet.create({
	card: {
		borderWidth: 1,
		paddingHorizontal: 16, // md — dividers span the padded content width
	},
	divider: {
		height: StyleSheet.hairlineWidth,
	},
	row: {
		paddingVertical: 16, // md — >=44px effective row height
	},
	error: {
		marginTop: 4, // xs
	},
});
