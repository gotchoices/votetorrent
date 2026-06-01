import React from 'react';
import {StyleSheet, TouchableOpacity, View} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ThemedText} from './ThemedText';
import {ExtendedTheme, useTheme} from '@react-navigation/native';

interface ChipButtonProps {
	label: string;
	icon?: string;
	onPress?: () => void;
}

export function ChipButton({label, icon, onPress}: ChipButtonProps) {
	const {colors} = useTheme() as ExtendedTheme;

	return (
		<TouchableOpacity
			// This is using onPressIn because of a bug with onPress in headers
			onPressIn={onPress}
			style={[styles.button, {backgroundColor: colors.accent}]}>
			{icon && (
				<View style={[styles.iconCircle, {backgroundColor: colors.dark}]}>
					<FontAwesome6 name={icon} size={16} color={colors.light} />
				</View>
			)}
			<ThemedText numberOfLines={1}>{label.toUpperCase()}</ThemedText>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		height: 32,
		paddingHorizontal: 12,
		borderRadius: 16,
		alignSelf: 'flex-start',
		gap: 8,
	},
	iconCircle: {
		width: 24,
		height: 24,
		borderRadius: 12,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
