/**
 * @format
 *
 * receipt-privacy.ts (Phase 63 review CR-01): keeps the decrypted receipt out of OS snapshots.
 *
 * - `useSecureScreenWhileFocused`: Android FLAG_SECURE on while the screen is focused, off on blur
 *   and on unmount (useFocusEffect's cleanup runs for both). The Recents snapshot and screenshots
 *   are then blank. On iOS, under jest, or on a binary without the native method, the call is a
 *   no-op that resolves false; it never throws.
 * - `usePrivacyCover`: true while the app is not 'active'. iOS takes its app-switcher snapshot after
 *   'inactive', before JS sees 'background', so the screen renders an opaque cover and stops
 *   rendering the revealed record while this is true. The record itself is kept: 'inactive' also
 *   fires while iOS shows its own biometric sheet, so clearing it there would discard a reveal. The
 *   screen still clears the record on 'background'.
 *
 * Kept apart from the screen's own AppState handler and focus effect on purpose: those stay
 * responsible for clearing state, these only hide it.
 */
import {useCallback, useEffect, useState} from 'react';
import {AppState} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {setSecureScreen} from '@votetorrent/attestation-native';

export function useSecureScreenWhileFocused(): void {
	useFocusEffect(
		useCallback(() => {
			void setSecureScreen(true);
			return () => {
				void setSecureScreen(false);
			};
		}, []),
	);
}

export function usePrivacyCover(): boolean {
	const [covered, setCovered] = useState(false);
	useEffect(() => {
		const sub = AppState.addEventListener('change', state => {
			setCovered(state !== 'active');
		});
		return () => sub.remove();
	}, []);
	return covered;
}
