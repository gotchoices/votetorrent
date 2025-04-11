import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {InfoCard} from '../../components/InfoCard';
import {CollapsibleSection} from '../../components/CollapsibleSection';
import {ChipButton} from '../../components/ChipButton';
import {ThemedText} from '../../components/ThemedText';
import React, {useEffect, useState} from 'react';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NavigationProp} from '../../navigation/types';
import type {Authority} from '@votetorrent/vote-core';
import {NoNetwork} from '../../components/NoNetwork';
import {useApp} from '../../providers/AppProvider';
import {globalStyles} from '../../theme/styles';

export default function AuthoritiesScreen() {
	const [searchText, setSearchText] = useState('');
	const [unpinnedAuthorities, setUnpinnedAuthorities] = useState<Authority[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [pinnedAuthorities, setPinnedAuthorities] = useState<Authority[]>([]);
	const {t} = useTranslation();
	const navigation = useNavigation<NavigationProp>();
	const {currentNetwork, networkEngine} = useApp();

	if (!currentNetwork || !networkEngine) {
		return <NoNetwork />;
	}

	const loadAuthorities = async () => {
		if (!networkEngine) return;
		try {
			setIsLoading(true);
			const pinned = await networkEngine.getPinnedAuthorities();
			setPinnedAuthorities(pinned);

			const unpinnedCursor = await networkEngine.getAuthoritiesByName(searchText);
			setUnpinnedAuthorities(
				unpinnedCursor.buffer.filter((a: Authority) => !pinned.some((p: Authority) => p.sid === a.sid))
			);
		} catch (error) {
			console.error('Error loading authorities:', error);
		} finally {
			setIsLoading(false);
		}
	};

	useFocusEffect(
		React.useCallback(() => {
			loadAuthorities();
		}, [networkEngine])
	);

	useEffect(() => {
		async function searchAuthorities() {
			if (!networkEngine) return;
			try {
				const [unpinnedCursor, pinned] = await Promise.all([
					networkEngine.getAuthoritiesByName(searchText),
					networkEngine.getPinnedAuthorities()
				]);

				setPinnedAuthorities(pinned);
				setUnpinnedAuthorities(
					unpinnedCursor.buffer.filter((a: Authority) => !pinned.some((p: Authority) => p.sid === a.sid))
				);
			} catch (error) {
				console.error('Error searching authorities:', error);
			}
		}
		searchAuthorities();
	}, [searchText, networkEngine]);

	const handlePinToggle = async (authority: Authority) => {
		try {
			const isPinned = pinnedAuthorities.some(a => a.sid === authority.sid);

			if (isPinned) {
				//Currently no way in ui to unpin an authority on this screen
				await networkEngine.unpinAuthority(authority.sid);
			} else {
				await networkEngine.pinAuthority(authority);
			}

			const [unpinnedCursor, pinned] = await Promise.all([
				networkEngine.getAuthoritiesByName(searchText),
				networkEngine.getPinnedAuthorities()
			]);

			setPinnedAuthorities(pinned);
			setUnpinnedAuthorities(
				unpinnedCursor.buffer.filter((a: Authority) => !pinned.some((p: Authority) => p.sid === a.sid))
			);
		} catch (error) {
			console.error('Error toggling authority pin:', error);
		}
	};

	if (isLoading) {
		return (
			<View style={styles.centerContainer}>
				<ThemedText>{t('loading')}</ThemedText>
			</View>
		);
	}

	return (
		<ScrollView style={styles.container}>
			{pinnedAuthorities.length > 0 ? (
				pinnedAuthorities.map((authority: Authority) => (
					<InfoCard
						key={authority.sid}
						title={authority.name}
						image={{uri: authority.imageRef?.url || ''}}
						additionalInfo={[{label: 'Domain Name', value: authority.domainName}]}
						icon={'chevron-right'}
						onPress={() => {
							navigation.navigate('AuthorityDetails', {
								authority: authority
							});
						}}
					/>
				))
			) : (
				<ThemedText style={styles.emptyText}>{t('noPinnedAuthorities')}</ThemedText>
			)}

			<CollapsibleSection title={t('find')} searchPlaceholder={t('filterAuthorities')} onSearch={setSearchText}>
				{unpinnedAuthorities.length > 0 ? (
					unpinnedAuthorities.map(authority => (
						<InfoCard
							key={authority.sid}
							title={authority.name}
							image={{uri: authority.imageRef?.url || ''}}
							additionalInfo={[{label: 'Domain Name', value: authority.domainName}]}
							icon={'thumbtack'}
							onPress={() => handlePinToggle(authority)}
						/>
					))
				) : (
					<ThemedText style={styles.emptyText}>No authorities found</ThemedText>
				)}
			</CollapsibleSection>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	centerContainer: {
		flex: 1,
		justifyContent: 'center',
		alignItems: 'center'
	},
	emptyText: {
		textAlign: 'center',
		marginVertical: 16,
		opacity: 0.7
	}
});

const styles = {...globalStyles, ...localStyles};
