import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useTranslation} from 'react-i18next';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import type {RootStackParamList} from './types';
import AuthorityDetailsScreen from '../screens/authorities/AuthorityDetailsScreen';
import ElectionsScreen from '../screens/elections/ElectionsScreen';
import SignersScreen from '../screens/signers/SignersScreen';
import AuthoritiesScreen from '../screens/authorities/AuthoritiesScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import {ChipButton} from '../components/ChipButton';
import {Pressable, StyleSheet, View, Text} from 'react-native';
import {ExtendedTheme, useNavigation} from '@react-navigation/native';
import {useTheme} from '@react-navigation/native';
import NetworksScreen from '../screens/networks/NetworksScreen';
import type {NavigationProp} from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

function SplitHeaderTitle() {
  const {colors} = useTheme() as ExtendedTheme;
  return (
    <View style={styles.headerContainer}>
      <Text
        style={[styles.headerText, styles.networkText, {color: colors.text}]}
        numberOfLines={1}>
        Current Network
      </Text>
      <Text
        style={[styles.headerText, styles.usernameText, {color: colors.text}]}
        numberOfLines={1}>
        Username Username
      </Text>
    </View>
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
    headerTitle: () => <SplitHeaderTitle />,
    headerShadowVisible: false,
  };
}

const TabNavigator = () => {
  const {colors} = useTheme() as ExtendedTheme;
  const {t} = useTranslation();
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
            case 'Signers':
              iconName = 'person';
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
        tabBarInactiveTintColor: 'gray',
      })}>
      <Tab.Screen
        name="Elections"
        component={ElectionsScreen}
        options={{...tabHeaderOptions}}
      />
      <Tab.Screen
        name="Signers"
        component={SignersScreen}
        options={{...tabHeaderOptions}}
      />
      <Tab.Screen
        name="Authorities"
        component={AuthoritiesScreen}
        options={tabHeaderOptions}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{...tabHeaderOptions}}
      />
    </Tab.Navigator>
  );
};

const styles = StyleSheet.create({
  headerContainer: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    width: '100%',
  },
  headerText: {
    fontSize: 16,
    fontWeight: '500',
  },
  networkText: {
    flex: 1,
    textAlign: 'left',
    marginRight: 8,
  },
  usernameText: {
    flex: 1,
    textAlign: 'right',
    opacity: 0.7,
  },
  headerButton: {
    padding: 8,
    marginHorizontal: 4,
  },
});

export const RootNavigator = () => {
  const {t} = useTranslation();

  return (
    <Stack.Navigator>
      <Stack.Screen
        name="Tabs"
        component={TabNavigator}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="AuthorityDetails"
        component={AuthorityDetailsScreen}
        options={{
          title: t('authority'),
          headerRight: () => (
            <ChipButton label={t('unpin')} icon={'thumbtack-slash'} />
          ),
        }}
      />
      <Stack.Screen
        name="Networks"
        component={NetworksScreen}
        options={{
          title: t('recentNetworks'),
        }}
      />
    </Stack.Navigator>
  );
};
