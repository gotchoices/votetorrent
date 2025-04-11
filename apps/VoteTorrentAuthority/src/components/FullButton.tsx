import {StyleSheet, TouchableOpacity} from 'react-native';
import {ThemedText} from './ThemedText';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {ExtendedTheme, useTheme} from '@react-navigation/native';

interface FullButtonProps {
	title: string;
	icon?: string;
	disabled?: boolean;
	backgroundColor?: string;
	forceDarkText?: boolean;
	size?: 'full' | 'thin';
	onPress: () => void;
}

export function FullButton({
	title,
	icon,
	disabled = false,
	backgroundColor,
	forceDarkText = false,
	size = 'full',
	onPress
}: FullButtonProps) {
	const {colors} = useTheme() as ExtendedTheme;
	const buttonColor = backgroundColor ?? colors.accent;

	return (
		<TouchableOpacity
			style={[
				styles.button,
				{backgroundColor: buttonColor},
				disabled && styles.disabled,
				size === 'thin' ? styles.thin : styles.full
			]}
			onPress={onPress}
			disabled={disabled}>
			{icon && <FontAwesome6 name={icon} size={20} color={forceDarkText ? colors.dark : colors.text} />}
			<ThemedText style={[styles.text, {color: forceDarkText ? colors.dark : colors.text}]}>
				{title.toUpperCase()}
			</ThemedText>
		</TouchableOpacity>
	);
}

const styles = StyleSheet.create({
	button: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		paddingHorizontal: 16,
		borderRadius: 32,
		marginTop: 8,
		marginBottom: 8
	},
	disabled: {
		opacity: 0.5
	},
	text: {
		fontSize: 16,
		fontWeight: '600'
	},
	full: {
		paddingVertical: 16
	},
	thin: {
		paddingVertical: 6
	}
});
