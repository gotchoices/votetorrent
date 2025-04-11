import {ExtendedTheme, Theme} from '@react-navigation/native';

const fonts = {
	regular: {
		fontFamily: 'System',
		fontWeight: '400' as const
	},
	medium: {
		fontFamily: 'System',
		fontWeight: '500' as const
	},
	bold: {
		fontFamily: 'System',
		fontWeight: '700' as const
	},
	heavy: {
		fontFamily: 'System',
		fontWeight: '900' as const
	}
};

declare module '@react-navigation/native' {
	export type ExtendedTheme = Theme & {
		colors: {
			primary: string;
			background: string;
			surface: string;
			card: string;
			text: string;
			textSecondary: string;
			border: string;
			notification: string;
			secondary: string;
			accent: string;
			error: string;
			warning: string;
			contrast: string;
			success: string;
			dark: string;
			important: string;
		};
		fonts: typeof fonts;
	};
}

export const lightTheme: ExtendedTheme = {
	dark: false,
	colors: {
		primary: '#007AFF',
		background: '#FFFFFF',
		surface: '#FFFFFF',
		card: '#FFFFFF',
		text: '#000000',
		textSecondary: '#3F3F3F',
		border: '#3F3F3F',
		notification: '#FF3B30',
		secondary: '#000000',
		accent: '#d9d9d9',
		error: '#FF3B30',
		warning: '#ECE81A',
		contrast: '#262626',
		success: '#cfefcd',
		important: '#e8e3ad',
		dark: '#000000'
	},
	fonts
};

export const darkTheme: ExtendedTheme = {
	dark: true,
	colors: {
		primary: '#0A84FF',
		background: '#121212',
		surface: '#171717',
		card: '#1C1C1E',
		text: '#ebebeb',
		textSecondary: '#5b5b5b',
		border: '#121212',
		notification: '#FF453A',
		secondary: '#FFFFFF',
		accent: '#606060',
		error: '#FF453A',
		warning: '#b57d00',
		contrast: '#dadada',
		success: '#89a690',
		dark: '#000000',
		important: '#e8e3adc8'
	},
	fonts
};
