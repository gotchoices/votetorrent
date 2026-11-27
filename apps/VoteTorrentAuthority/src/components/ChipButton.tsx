import React from 'react';
import {StyleSheet, TouchableOpacity, View} from 'react-native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ThemedText} from './ThemedText';
import {ExtendedTheme, useTheme} from '@react-navigation/native';

interface ChipButtonProps {
	label: string;
	icon?: string;
	/** Stretch to fill the row as a full-width CTA (e.g. CREATE USER), centered. */
	fullWidth?: boolean;
	onPress?: () => void;
	/** Optional, backward-compatible: disables the chip (e.g. in-flight signing state). */
	disabled?: boolean;
}

export function ChipButton({label, icon, fullWidth, onPress, disabled}: ChipButtonProps) {
	const {colors} = useTheme() as ExtendedTheme;

	return (
		<TouchableOpacity
			// This is using onPressIn because of a bug with onPress in headers
			onPressIn={disabled ? undefined : onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{disabled: !!disabled}}
			// The 32pt chip height is a deliberate app-wide visual constant, so
			// raising `height` would reflow every header and card row. hitSlop
			// lifts the effective touch target to 44 with ZERO layout change.
			// Left/right stay 0 because chips sit adjacent in rows and
			// horizontal slop would create overlapping touch regions.
			hitSlop={{top: 6, bottom: 6, left: 0, right: 0}}
			style={[
				styles.button,
				{backgroundColor: colors.accent},
				fullWidth && styles.fullWidth,
				disabled && styles.disabled,
			]}>
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
		paddingHorizontal: 20,
		borderRadius: 16,
		alignSelf: 'flex-start',
		gap: 8,
	},
	fullWidth: {
		alignSelf: 'stretch',
		justifyContent: 'center',
		height: 48,
		paddingHorizontal: 28,
		borderRadius: 24,
		marginVertical: 8,
	},
	iconCircle: {
		width: 24,
		height: 24,
		borderRadius: 12,
		alignItems: 'center',
		justifyContent: 'center',
	},
	disabled: {
		opacity: 0.5,
	},
});
