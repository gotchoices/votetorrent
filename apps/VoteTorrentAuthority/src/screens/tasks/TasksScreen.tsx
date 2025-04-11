import React from 'react';
import {View, Text} from 'react-native';
import {NoNetwork} from '../../components/NoNetwork';
import {useApp} from '../../providers/AppProvider';

export const TasksScreen = () => {
	const {currentNetwork} = useApp();

	if (!currentNetwork) {
		return <NoNetwork />;
	}

	return (
		<View style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
			<Text>Tasks</Text>
		</View>
	);
};

export default TasksScreen;
