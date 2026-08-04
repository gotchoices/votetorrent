/**
 * InfoDialog — a centered modal-overlay dialog used by the "Learn about this …" affordances
 * (candidate / office / election), matching the Figma Candidate Info frame: a close X (top-right),
 * a bold title, a subtitle, and a quoted body line. Presentational — `visible`/`title`/`subtitle`/
 * `body`/`onClose` props in, no provider/navigation reads; the caller owns the open/closed state
 * and resolves all copy (i18n) before passing it down.
 */
import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';

export interface InfoDialogProps {
	visible: boolean;
	title: string;
	subtitle: string;
	body: string;
	/** Accessibility label for the close affordance (caller-resolved i18n). */
	closeLabel?: string;
	onClose: () => void;
}

export function InfoDialog({visible, title, subtitle, body, closeLabel, onClose}: InfoDialogProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;

	if (!visible) {
		return null;
	}

	return (
		<Modal visible transparent animationType="fade" onRequestClose={onClose}>
			<Pressable testID="info-dialog-backdrop" style={styles.backdrop} onPress={onClose}>
				{/* Inner Pressable swallows taps so pressing the card doesn't dismiss the dialog. */}
				<Pressable
					testID="info-dialog"
					style={[styles.card, {backgroundColor: colors.card, borderRadius: radii.lg}]}>
					<Pressable
						testID="info-dialog-close"
						onPress={onClose}
						hitSlop={8}
						style={styles.close}
						accessibilityRole="button"
						accessibilityLabel={closeLabel}>
						<FontAwesome6 name="xmark" size={22} color={colors.text} />
					</Pressable>

					<Text
						style={[
							styles.title,
							{
								color: colors.text,
								fontFamily: fonts.bold.fontFamily,
								fontWeight: fonts.bold.fontWeight,
								fontSize: typeScale.h4.fontSize,
								lineHeight: typeScale.h4.lineHeight,
							},
						]}>
						{title}
					</Text>
					<Text
						style={[
							styles.subtitle,
							{
								color: colors.text,
								fontFamily: fonts.medium.fontFamily,
								fontWeight: fonts.medium.fontWeight,
								fontSize: typeScale.body.fontSize,
								lineHeight: typeScale.body.lineHeight,
							},
						]}>
						{subtitle}
					</Text>
					<Text
						style={[
							styles.body,
							{
								color: colors.textSecondary,
								fontFamily: fonts.regular.fontFamily,
								fontWeight: fonts.regular.fontWeight,
								fontSize: typeScale.caption.fontSize,
								lineHeight: typeScale.caption.lineHeight,
							},
						]}>
						{body}
					</Text>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

export default InfoDialog;

const styles = StyleSheet.create({
	backdrop: {
		flex: 1,
		backgroundColor: 'rgba(0, 0, 0, 0.5)',
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	card: {
		width: '100%',
		maxWidth: 420,
		paddingHorizontal: 24,
		paddingTop: 48,
		paddingBottom: 40,
		alignItems: 'center',
	},
	close: {
		position: 'absolute',
		top: 16,
		right: 16,
	},
	title: {
		textAlign: 'center',
		marginBottom: 16,
	},
	subtitle: {
		textAlign: 'center',
		marginBottom: 32,
	},
	body: {
		textAlign: 'center',
	},
});
