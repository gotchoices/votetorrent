import { useTheme } from '@react-navigation/native';
import { Theme } from '@react-navigation/native';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof Theme['colors']
) {
  const { dark, colors } = useTheme();
  const colorFromProps = props[dark ? 'dark' : 'light'];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return colors[colorName];
  }
}
