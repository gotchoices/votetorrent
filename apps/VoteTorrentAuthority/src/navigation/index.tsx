import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {RootStackParamList} from './types';
import AuthorityDetailsScreen from '../screens/authorities/AuthorityDetailsScreen';
import AdministratorDetailsScreen from '../screens/administration/AdministratorDetailsScreen';
import ElectionsScreen from '../screens/elections/ElectionsScreen';
import TasksScreen from '../screens/tasks/TasksScreen';
import AuthoritiesScreen from '../screens/authorities/AuthoritiesScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import {ChipButton} from '../components/ChipButton';
import {Pressable, StyleSheet} from 'react-native';
import {ExtendedTheme, useNavigation} from '@react-navigation/native';
import {useTheme} from '@react-navigation/native';
import NetworksScreen from '../screens/networks/NetworksScreen';
import type {NavigationProp} from './types';
import AddNetworkScreen from '../screens/networks/AddNetworkScreen';
import HostingScreen from '../screens/networks/HostingScreen';
import ReplaceAdministrationScreen from '../screens/administration/ReplaceAdministrationScreen';
import {useApp} from '../providers/AppProvider';
import EditAdministratorScreen from '../screens/administration/EditAdministratorScreen';
import {ThemedText} from '../components/ThemedText';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function HeaderTitle() {
	const {currentNetwork} = useApp();
	const {t} = useTranslation();
	const navigation = useNavigation<NavigationProp>();

	return (
		<Pressable onPress={() => navigation.navigate('Networks')} style={[styles.networkTextContainer, styles.headerText]}>
			<ThemedText type="header">{currentNetwork ? currentNetwork.name : t('selectNetwork')}</ThemedText>
		</Pressable>
	);
}

function useTabHeaderOptions() {
	const {colors} = useTheme() as ExtendedTheme;
	const navigation = useNavigation<NavigationProp>();

	const handleNetworkPress = () => {
		navigation.navigate('Networks');
	};

	return {
		headerLeft: () => (
			<Pressable onPress={handleNetworkPress} style={styles.headerButton}>
				<FontAwesome6 name="circle-nodes" size={24} color={colors.text} />
			</Pressable>
		),
		headerRight: () => (
			<Pressable style={styles.headerButton}>
				<FontAwesome6 name="circle-user" size={24} color={colors.text} />
			</Pressable>
		),
		headerTitle: () => <HeaderTitle />,
		headerShadowVisible: false
	};
}

const TabNavigator = () => {
	const {colors} = useTheme() as ExtendedTheme;
	const tabHeaderOptions = useTabHeaderOptions();

	return (
		<Tab.Navigator
			screenOptions={({route}) => ({
				tabBarIcon: ({focused, color, size}) => {
					let iconName: string;

					switch (route.name) {
						case 'Elections':
							iconName = 'check-to-slot';
							break;
						case 'Tasks':
							iconName = 'list-check';
							break;
						case 'Authorities':
							iconName = 'shield';
							break;
						case 'Settings':
							iconName = 'gear';
							break;
						default:
							iconName = 'alert';
					}

					return <FontAwesome6 name={iconName} size={size} color={color} />;
				},
				tabBarActiveTintColor: colors.primary,
				tabBarInactiveTintColor: 'gray'
			})}>
			<Tab.Screen name="Elections" component={ElectionsScreen} options={{...tabHeaderOptions}} />
			<Tab.Screen name="Tasks" component={TasksScreen} options={{...tabHeaderOptions}} />
			<Tab.Screen name="Authorities" component={AuthoritiesScreen} options={tabHeaderOptions} />
			<Tab.Screen name="Settings" component={SettingsScreen} options={{...tabHeaderOptions}} />
		</Tab.Navigator>
	);
};

const styles = StyleSheet.create({
	splitHeaderContainer: {
		flex: 1,
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
		paddingHorizontal: 2,
		width: '100%'
	},
	networkTextContainer: {
		flex: 1,
		marginRight: 8
	},
	headerText: {
		justifyContent: 'center'
	},
	usernameText: {
		flex: 1,
		textAlign: 'right',
		opacity: 0.7
	},
	headerButton: {
		padding: 8,
		marginHorizontal: 4,
		marginVertical: -2
	}
});

export const RootNavigator = () => {
	const {t} = useTranslation();

	return (
		<Stack.Navigator>
			<Stack.Screen name="Home" component={TabNavigator} options={{headerShown: false}} />
			<Stack.Screen
				name="AuthorityDetails"
				component={AuthorityDetailsScreen}
				options={{
					title: t('authority'),
					headerRight: () => <ChipButton label={t('unpin')} icon={'thumbtack-slash'} />
				}}
			/>
			<Stack.Screen
				name="AdministratorDetails"
				component={AdministratorDetailsScreen}
				options={{
					title: t('administrator')
				}}
			/>
			<Stack.Screen
				name="Networks"
				component={NetworksScreen}
				options={{
					title: ''
				}}
			/>
			<Stack.Screen name="AddNetwork" component={AddNetworkScreen} options={{title: t('addNetwork')}} />
			<Stack.Screen name="Hosting" component={HostingScreen} options={{title: t('hosting')}} />
			<Stack.Screen
				name="ReplaceAdministration"
				component={ReplaceAdministrationScreen}
				options={{title: t('proposeReplacement')}}
			/>
			<Stack.Screen
				name="EditAdministrator"
				component={EditAdministratorScreen}
				options={{
					title: t('administrator')
				}}
			/>
		</Stack.Navigator>
	);
};
