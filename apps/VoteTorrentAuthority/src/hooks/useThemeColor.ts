import {useTheme} from '@react-navigation/native';
import {ExtendedTheme} from '@react-navigation/native';

export function useThemeColor(props: {light?: string; dark?: string}, colorName: keyof ExtendedTheme['colors']) {
	const {dark, colors} = useTheme() as ExtendedTheme;
	const colorFromProps = props[dark ? 'dark' : 'light'];

	if (colorFromProps) {
		return colorFromProps;
	} else {
		return colors[colorName];
	}
}
