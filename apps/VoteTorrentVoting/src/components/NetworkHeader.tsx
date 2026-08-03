/**
 * NetworkHeader — the branded blue app header from the Figma Registration frames: a primary-color
 * banner (rounded bottom corners) with the network name ("Utah Network") + a chevron (network
 * switcher affordance) on the left and a bell (notifications) in a circle on the right. Replaces
 * the plain native "Registration" header on the Registration tab root (headerShown:false there).
 *
 * Uses the top safe-area inset so the banner sits clear of the status bar. Presentational — the
 * chevron/bell are mock affordances (no-op by default); no provider/navigation reads here.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';

export interface NetworkHeaderProps {
	onPressNetwork?: () => void;
	onPressBell?: () => void;
}

export function NetworkHeader({onPressNetwork, onPressBell}: NetworkHeaderProps) {
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('common');
	const insets = useSafeAreaInsets();

	return (
		<View
			style={[
				styles.header,
				{
					backgroundColor: colors.primary,
					paddingTop: insets.top + 16,
					borderBottomLeftRadius: radii.lg,
					borderBottomRightRadius: radii.lg,
				},
			]}>
			<Pressable
				testID="network-header-title"
				onPress={onPressNetwork}
				style={styles.titleRow}
				accessibilityRole="button">
				<Text
					style={[
						styles.title,
						{
							color: colors.light,
							fontFamily: fonts.bold.fontFamily,
							fontWeight: fonts.bold.fontWeight,
							fontSize: typeScale.h1.fontSize,
							lineHeight: typeScale.h1.lineHeight,
						},
					]}>
					{t('networkName')}
				</Text>
				<FontAwesome6 name="chevron-down" size={20} color={colors.light} />
			</Pressable>

			<Pressable
				testID="network-header-bell"
				onPress={onPressBell}
				hitSlop={8}
				style={[styles.bell, {borderColor: colors.light}]}
				accessibilityRole="button"
				accessibilityLabel={t('notifications')}>
				<FontAwesome6 name="bell" size={18} color={colors.light} />
			</Pressable>
		</View>
	);
}

export default NetworkHeader;

const styles = StyleSheet.create({
	header: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingHorizontal: 20,
		paddingBottom: 24,
	},
	titleRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	title: {},
	bell: {
		width: 40,
		height: 40,
		borderRadius: 20,
		borderWidth: 1.5,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
