import React from 'react';
import {View} from 'react-native';
import {NoNetwork} from '../../components/NoNetwork';
import {useApp} from '../../providers/AppProvider';

export const ElectionsScreen = () => {
	const {currentNetwork} = useApp();

	if (!currentNetwork) {
		return <NoNetwork />;
	}

	return (
		<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}} />
	);
};

export default ElectionsScreen;
