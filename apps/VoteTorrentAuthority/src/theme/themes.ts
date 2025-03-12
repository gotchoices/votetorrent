import { ExtendedTheme, Theme } from '@react-navigation/native';

const fonts = {
  regular: {
    fontFamily: 'System',
    fontWeight: '400' as const,
  },
  medium: {
    fontFamily: 'System',
    fontWeight: '500' as const,
  },
  bold: {
    fontFamily: 'System',
    fontWeight: '700' as const,
  },
  heavy: {
    fontFamily: 'System',
    fontWeight: '900' as const,
  },
};

declare module '@react-navigation/native' {
  export type ExtendedTheme = Theme & {
    colors: {
      primary: string;
      background: string;
      card: string;
      text: string;
      border: string;
      notification: string;
			secondary: string;
			accent: string;
			error: string;
			warning: string;
			contrast: string;
		};
		fonts: typeof fonts;
	};
}

export const lightTheme: ExtendedTheme = {
	dark: false,
	colors: {
		primary: "#007AFF",
		background: "#FFFFFF",
		card: "#FFFFFF",
		text: "#000000",
		border: "#E5E5EA",
		notification: "#FF3B30",
		secondary: "#000000",
		accent: "#d9d9d9",
		error: "#FF3B30",
		warning: "#ECE81A",
		contrast: "#262626",
	},
	fonts,
};

export const darkTheme: ExtendedTheme = {
	dark: true,
	colors: {
		primary: "#0A84FF",
		background: "#121212",
		card: "#1C1C1E",
		text: "#FFFFFF",
		border: "#1C1C1E",
		notification: "#FF453A",
		secondary: "#FFFFFF",
		accent: "#717171",
		error: "#FF453A",
		warning: "#b57d00",
		contrast: "#dadada",
	},
	fonts,
};
