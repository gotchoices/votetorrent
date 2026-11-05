/**
 * InfoDetails — the authority-published detail shown inside an InfoDialog: labelled rows plus an
 * optional external link, or a loading / unavailable line while the read is pending or failed.
 * Presentational: the caller resolves every label (i18n) and value. Values are authority-published
 * text and are rendered as-is, never routed through `t()`. Empty rows are omitted, so a record
 * that publishes nothing for a field shows no blank heading.
 */
import React from 'react';
import {ActivityIndicator, Linking, Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';

export interface InfoDetailRow {
	label: string;
	value: string | undefined;
}

export interface InfoDetailsProps {
	loading: boolean;
	failed: boolean;
	unavailableLabel: string;
	rows: InfoDetailRow[];
	link?: {label: string; url: string};
	testID?: string;
}

/** Only http(s) links are opened — an authority-published string is not trusted as a scheme. */
export function isOpenableUrl(url: string): boolean {
	return /^https?:\/\/\S+$/i.test(url.trim());
}

export function InfoDetails({loading, failed, unavailableLabel, rows, link, testID = 'info-details'}: InfoDetailsProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;

	if (loading) {
		return (
			<View testID={`${testID}-loading`} style={styles.status}>
				<ActivityIndicator color={colors.primary} />
			</View>
		);
	}

	if (failed) {
		return (
			<Text
				testID={`${testID}-unavailable`}
				style={[styles.status, {color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight}]}>
				{unavailableLabel}
			</Text>
		);
	}

	const shown = rows.filter(row => row.value !== undefined && row.value.trim() !== '');
	const openable = link && isOpenableUrl(link.url) ? link : undefined;

	return (
		<View testID={testID} style={styles.container}>
			{shown.map(row => (
				<View key={row.label} style={styles.row}>
					<Text
						style={{
							color: colors.textSecondary,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.caption.fontSize,
							lineHeight: typeScale.caption.lineHeight,
						}}>
						{row.label}
					</Text>
					<Text
						style={{
							color: colors.text,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						}}>
						{row.value}
					</Text>
				</View>
			))}
			{openable ? (
				<Pressable
					testID={`${testID}-link`}
					accessibilityRole="link"
					onPress={() => {
						Linking.openURL(openable.url).catch(() => undefined);
					}}>
					<Text
						style={{
							color: colors.primary,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						}}>
						{openable.label}
					</Text>
				</Pressable>
			) : null}
		</View>
	);
}

export default InfoDetails;

const styles = StyleSheet.create({
	container: {
		alignSelf: 'stretch',
		gap: 16,
	},
	row: {
		gap: 4,
	},
	status: {
		paddingVertical: 16,
		textAlign: 'center',
	},
});
