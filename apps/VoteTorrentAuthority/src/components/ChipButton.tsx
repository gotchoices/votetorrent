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
			<ThemedText>{label.toUpperCase()}</ThemedText>
			{icon && (
				<View style={[styles.iconCircle, {backgroundColor: colors.dark}]}>
					<FontAwesome6 name={icon} size={10} color={colors.light} />
				</View>
			)}
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
		width: 20,
		height: 20,
		borderRadius: 10,
		alignItems: 'center',
		justifyContent: 'center',
	},
});
