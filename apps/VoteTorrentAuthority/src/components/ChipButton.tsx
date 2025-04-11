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
			{icon && <FontAwesome6 name={icon} size={14} color={colors.text} style={styles.icon} />}
			<ThemedText>{label.toUpperCase()}</ThemedText>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingVertical: 2,
		paddingHorizontal: 12,
		borderRadius: 20,
		alignSelf: 'flex-start'
	},
	icon: {
		marginRight: 6
	}
});
