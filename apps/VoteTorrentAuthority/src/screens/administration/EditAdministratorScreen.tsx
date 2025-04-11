import {ExtendedTheme, useTheme} from '@react-navigation/native';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View, Switch, Image} from 'react-native';
import {ThemedText} from '../../components/ThemedText';
import {ChipButton} from '../../components/ChipButton';
import {FullButton} from '../../components/FullButton';
import type {Administrator, Authority, Scope} from '@votetorrent/vote-core';
import {scopeDescriptions} from '@votetorrent/vote-core';
import {useRoute, useNavigation} from '@react-navigation/native';
import {useApp} from '../../providers/AppProvider';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import type {RootStackParamList} from '../../navigation/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {CustomTextInput} from '../../components/CustomTextInput';
import {globalStyles} from '../../theme/styles';

export default function EditAdministratorScreen() {
	const {colors} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const {authority, administratorSid} = useRoute().params as {authority: Authority; administratorSid?: string};
	const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
	const {networkEngine} = useApp();
	const [name, setName] = useState('');
	const [title, setTitle] = useState('');
	const [scopes, setScopes] = useState<Scope[]>([]);
	const [administrator, setAdministrator] = useState<Administrator | null>(null);
	const [inviteId, setInviteId] = useState('ssFfe4G23kr89'); //TODO: create invite id

	useEffect(() => {
		async function loadAdministrator() {
			if (!networkEngine || !administratorSid) return;
			try {
				const administration = await networkEngine.getAdministration(authority.sid);
				const foundAdministrator = administration.administrators.find((a: Administrator) => a.sid === administratorSid);
				if (foundAdministrator) {
					setAdministrator(foundAdministrator);
					setName(foundAdministrator.name);
					setTitle(foundAdministrator.title);
					setScopes(foundAdministrator.scopes);
				}
			} catch (error) {
				console.error('Error loading administrator:', error);
			}
		}
		loadAdministrator();
	}, [networkEngine, authority.sid, administratorSid]);

	useEffect(() => {
		navigation.setOptions({
			headerRight: () => (
				<ChipButton
					label={t('remove')}
					icon="trash"
					onPress={() => {
						// If we're editing an existing administrator, pass back the remove flag
						if (administrator) {
							// Set the params on the previous screen and go back
							navigation.popTo('ReplaceAdministration', {authority, administrator, removeAdministrator: true});
						} else {
							// For new administrators, just go back without any changes
							navigation.goBack();
						}
					}}
				/>
			)
		});
	}, [navigation, t, administrator, authority]);

	const handleScopeToggle = (scope: Scope) => {
		setScopes(prev => {
			if (prev.includes(scope)) {
				return prev.filter(id => id !== scope);
			} else {
				return [...prev, scope];
			}
		});
	};

	const handleAddAdministrator = async () => {
		try {
			const newAdministrator: Administrator = {
				sid: administrator?.sid || `admin-${Date.now()}`,
				key: administrator?.key || '',
				name,
				title,
				scopes,
				signatures: administrator?.signatures || [],
				invitationCid: administrator?.invitationCid
			};

			// Pass the administrator back to ReplaceAdministrationScreen
			navigation.popTo('ReplaceAdministration', {authority, administrator: newAdministrator});
		} catch (error) {
			console.error('Error adding administrator:', error);
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('administrator')}
					</ThemedText>

					{administrator?.key && (
						<View style={styles.detail}>
							<ThemedText type="defaultSemiBold">
								{t('publicKey')}: {administrator.key}
							</ThemedText>
						</View>
					)}

					<CustomTextInput title={t('name')} value={name} onChangeText={setName} />
					<CustomTextInput title={t('title')} value={title} onChangeText={setTitle} />

					{!administrator?.key && (
						<View>
							<ThemedText type="defaultSemiBold">
								{t('inviteId')}: {inviteId}
							</ThemedText>
						</View>
					)}
				</View>

				<View style={styles.section}>
					<ThemedText type="title" style={styles.sectionTitle}>
						{t('permissions')}
					</ThemedText>
					{Object.entries(scopeDescriptions).map(([scope, description]) => (
						<View key={scope} style={styles.scopeRow}>
							<View style={styles.scopeDescriptionContainer}>
								<ThemedText>{description}</ThemedText>
								<FontAwesome6 name="circle-info" size={16} color={colors.text} style={styles.scopeInfoIcon} />
							</View>
							<Switch
								value={scopes.includes(scope as Scope)}
								onValueChange={() => handleScopeToggle(scope as Scope)}
								trackColor={{false: colors.accent, true: colors.primary}}
								thumbColor={colors.card}
							/>
						</View>
					))}
				</View>
			</ScrollView>

			<View style={[styles.footer, {backgroundColor: colors.card}]}>
				<FullButton
					title={t('save')}
					icon="save"
					disabled={!name || !title}
					backgroundColor={colors.success}
					forceDarkText={true}
					onPress={handleAddAdministrator}
				/>
			</View>
		</View>
	);
}

const localStyles = StyleSheet.create({
	detail: {
		marginBottom: 32
	},
	scopeRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'space-between',
		paddingVertical: 4
	},
	scopeDescriptionContainer: {
		flexDirection: 'row',
		alignItems: 'center',
		flex: 1
	},
	scopeInfoIcon: {
		marginLeft: 8
	}
});
const styles = {...globalStyles, ...localStyles};
