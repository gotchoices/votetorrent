/**
 * ScanScreen — the Scan tab's root: scan an election authority's join-code QR and join its network.
 *
 * It is the Join a network screen (`JoinNetworkScreen`, the one Settings and Registration open),
 * hosted on this tab with its scanner, so there is one scanner and one join flow in the app:
 *  - Each time the tab comes into view, the scanner opens, as long as the form is empty and the
 *    camera can be used. Camera permission, no camera, a refused or failed camera, "Paste
 *    instead" and a QR that is not a join code are all handled there, exactly as from Settings.
 *  - A scan only fills the code field. The voter sees the network name and fingerprint and joins
 *    with one tap on Join network; nothing joins on its own.
 *  - The scanned code stays in that screen's state: it never enters navigation params.
 *  - Leaving the tab closes the scanner (the camera never runs behind another tab). A code waiting
 *    in the field, or a join in progress, is still there on return; a finished join clears.
 *  - Done after a join opens the Vote tab, where the joined network's election shows.
 *
 * A phone that already joined a network gets the same screen the Settings entry shows: joining a
 * different authority's network is refused with the screen's own "already belongs to another
 * network" message.
 */
import React, {useCallback, useState} from 'react';
import {useFocusEffect, useIsFocused, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useVoterApp} from '../../providers/VoterAppProvider';
import type {ScanStackParamList} from '../../navigation/types';
import JoinNetworkScreen from '../settings/JoinNetworkScreen';

export default function ScanScreen() {
	// SHELL-03: every screen routes through useVoterApp(); the join itself reads it inside JoinNetworkScreen.
	useVoterApp();
	const navigation = useNavigation<NativeStackNavigationProp<ScanStackParamList, 'ScanHome'>>();
	const isFocused = useIsFocused();
	const [scanRequest, setScanRequest] = useState(0);

	useFocusEffect(
		useCallback(() => {
			setScanRequest(count => count + 1);
		}, []),
	);

	const onDone = useCallback(() => {
		navigation.getParent()?.navigate('Vote');
	}, [navigation]);

	return <JoinNetworkScreen scanRequest={scanRequest} active={isFocused} onDone={onDone} />;
}
