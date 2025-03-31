import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Authority} from '../screens/authorities/AuthoritiesScreen';

export type RootStackParamList = {
  Tabs: undefined;
  AuthorityDetails: {
    authority: Authority;
  };
  Networks: undefined;
};

export type NavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'AuthorityDetails'
>;
