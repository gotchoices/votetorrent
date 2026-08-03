/**
 * PlaceholderModal (D-05) — ONE shared component used as the `component` for all 6 modal routes
 * (Individual Question, Election/Office/Candidate info, Device Attestation, Confirmation).
 *
 * Renders only the generic placeholder body (`common.placeholderBody`) — the per-modal title and
 * the CloseButton header affordance are supplied by the owning stack's `Stack.Screen` options in
 * 39-07 (`headerTitle` + `headerLeft`), NOT by this component. Keeping the body generic and
 * reusable is the point of D-05's hybrid strategy: one component, six routes.
 */
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {globalStyles} from '../theme/styles';

export function PlaceholderModal() {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');

	return (
		<View style={[globalStyles.container, styles.screen, {backgroundColor: colors.background}]}>
			<View style={styles.centerColumn}>
				<Text
					style={[
						styles.placeholderBody,
						{
							color: colors.textSecondary,
							fontFamily: fonts.regular.fontFamily,
							fontWeight: fonts.regular.fontWeight,
							fontSize: typeScale.body.fontSize,
							lineHeight: typeScale.body.lineHeight,
						},
					]}>
					{t('placeholderBody')}
				</Text>
			</View>
		</View>
	);
}

export default PlaceholderModal;

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	centerColumn: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center',
	},
	placeholderBody: {
		textAlign: 'center',
	},
});
