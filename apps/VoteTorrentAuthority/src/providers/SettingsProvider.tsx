import React, { createContext, useContext, useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsContextType {
	showHelpIcons: boolean;
	setShowHelpIcons: (value: boolean) => void;
}

const SettingsContext = createContext<SettingsContextType>({
	showHelpIcons: false,
	setShowHelpIcons: () => {},
});

export function useSettings() {
	return useContext(SettingsContext);
}

export function SettingsProvider({ children }: PropsWithChildren) {
	const [showHelpIcons, setShowHelpIconsState] = useState(false);

	useEffect(() => {
		AsyncStorage.getItem('showHelpIcons').then(val => {
			if (val === 'true') setShowHelpIconsState(true);
		});
	}, []);

	const setShowHelpIcons = (value: boolean) => {
		setShowHelpIconsState(value);
		AsyncStorage.setItem('showHelpIcons', value ? 'true' : 'false');
	};

	return (
		<SettingsContext.Provider value={{ showHelpIcons, setShowHelpIcons }}>
			{children}
		</SettingsContext.Provider>
	);
}
