/**
 * PartyDropdown (REG-03) — the "Select Your Party" control as a DROPDOWN, matching the Figma
 * step-2 frame (2891:1542) where party is a single dropdown field with a chevron (not the earlier
 * row of chips). Tapping the field opens a modal option list; picking one selects it and closes.
 *
 * Value contract is unchanged from the previous chip selector: the selected value is the stable,
 * locale-independent party KEY (e.g. 'independent'), never the localized label — so switching
 * languages re-localizes the display without corrupting the stored draft. Presentational-only.
 */
import React, {useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';

export interface PartyOption {
	key: string;
	label: string;
}

export interface PartyDropdownProps {
	options: PartyOption[];
	/** The stable party KEY (e.g. 'independent'), or '' if unselected — never a localized label. */
	value: string;
	placeholder: string;
	/** Called with the selected option's stable KEY. */
	onChange: (key: string) => void;
	/** Resolved, localized error message — red outline + message when set. */
	error?: string;
	testID?: string;
}

export function PartyDropdown({options, value, placeholder, onChange, error, testID}: PartyDropdownProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const [open, setOpen] = useState(false);

	const selected = options.find(o => o.key === value);
	const bodyFont = {
		fontFamily: fonts.regular.fontFamily,
		fontWeight: fonts.regular.fontWeight,
		fontSize: typeScale.body.fontSize,
		lineHeight: typeScale.body.lineHeight,
	} as const;

	return (
		<View>
			<Pressable
				testID={testID}
				accessibilityRole="button"
				accessibilityState={{expanded: open}}
				onPress={() => setOpen(true)}
				style={[
					styles.field,
					{
						backgroundColor: colors.card,
						borderColor: error ? colors.error : colors.border,
						borderRadius: radii.lg,
					},
				]}>
				<Text
					numberOfLines={1}
					style={[
						styles.fieldText,
						bodyFont,
						{color: selected ? colors.text : error ? colors.error : colors.textSecondary},
					]}>
					{selected ? selected.label : placeholder}
				</Text>
				<FontAwesome6 name="chevron-down" size={16} color={colors.textSecondary} />
			</Pressable>

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

			<Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
				<Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
					{/* Absorb presses on the sheet so only the backdrop / an option closes it. */}
					<Pressable
						style={[styles.sheet, {backgroundColor: colors.card, borderRadius: radii.lg}]}
						onPress={() => {}}>
						{options.map((o, i) => {
							const isSel = o.key === value;
							return (
								<View key={o.key}>
									{i > 0 ? (
										<View style={[styles.optionDivider, {backgroundColor: colors.border}]} />
									) : null}
									<Pressable
										testID={`party-option-${o.key}`}
										accessibilityRole="menuitem"
										accessibilityState={{selected: isSel}}
										onPress={() => {
											onChange(o.key);
											setOpen(false);
										}}
										style={styles.option}>
										<Text style={[styles.optionText, bodyFont, {color: colors.text}]}>
											{o.label}
										</Text>
										{isSel ? (
											<FontAwesome6 name="check" size={16} color={colors.primary} />
										) : null}
									</Pressable>
								</View>
							);
						})}
					</Pressable>
				</Pressable>
			</Modal>
		</View>
	);
}

export default PartyDropdown;

const styles = StyleSheet.create({
	field: {
		flexDirection: 'row',
		alignItems: 'center',
		borderWidth: 1,
		minHeight: 52,
		paddingHorizontal: 16,
		paddingVertical: 14,
		gap: 12,
	},
	fieldText: {
		flex: 1,
	},
	error: {
		marginTop: 4,
	},
	backdrop: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.4)',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	sheet: {
		paddingHorizontal: 16,
	},
	option: {
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: 52,
		paddingVertical: 16,
		gap: 12,
	},
	optionText: {
		flex: 1,
	},
	optionDivider: {
		height: StyleSheet.hairlineWidth,
	},
});
