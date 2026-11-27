/**
 * IdentityRecoveryView — shown when the voter identity record on this phone can no longer be
 * unwrapped (lost wrap key, tag mismatch, key mismatch). Explains the situation in plain words and
 * offers a DELIBERATE, confirmed way forward: create a new identity. Nothing is recovered; the new
 * identity is a new device as far as the protocol is concerned.
 *
 * Rendered by `VoterAppProvider` outside any navigation container, so it uses plain styles (no
 * theme hook). Copy lives in the 'common' namespace under `bootError.*`; no engine text is shown.
 */
import React, {useCallback, useState} from 'react';
import {ActivityIndicator, Text, TouchableOpacity, View} from 'react-native';
import {useTranslation} from 'react-i18next';

export interface IdentityRecoveryViewProps {
	onCreateNewIdentity: () => Promise<void>;
	onRetry: () => void;
}

const BUTTON_STYLE = {minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16} as const;

export function IdentityRecoveryView({onCreateNewIdentity, onRetry}: IdentityRecoveryViewProps) {
	const {t} = useTranslation('common');
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	const confirm = useCallback(async () => {
		setBusy(true);
		setFailed(false);
		try {
			await onCreateNewIdentity();
		} catch {
			// The error text is deliberately not shown (translated copy only).
			setFailed(true);
			setConfirming(false);
			setBusy(false);
		}
	}, [onCreateNewIdentity]);

	return (
		<View testID="identity-recovery-view" style={{flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24}}>
			<Text accessibilityRole="header" style={{fontSize: 18, fontWeight: '600', marginBottom: 12, textAlign: 'center'}}>
				{t('bootError.identityLost.title')}
			</Text>
			<Text style={{marginBottom: 16, textAlign: 'center'}}>{t('bootError.identityLost.body')}</Text>
			{failed && (
				<Text testID="identity-recovery-failed" style={{marginBottom: 16, textAlign: 'center'}}>
					{t('bootError.identityLost.replaceFailed')}
				</Text>
			)}
			{busy ? (
				<ActivityIndicator size="large" />
			) : confirming ? (
				<>
					<Text style={{marginBottom: 16, textAlign: 'center'}}>{t('bootError.identityLost.confirmBody')}</Text>
					<TouchableOpacity testID="identity-recovery-confirm" accessibilityRole="button" onPress={confirm} style={BUTTON_STYLE}>
						<Text>{t('bootError.identityLost.confirm')}</Text>
					</TouchableOpacity>
					<TouchableOpacity
						testID="identity-recovery-cancel"
						accessibilityRole="button"
						onPress={() => setConfirming(false)}
						style={BUTTON_STYLE}>
						<Text>{t('bootError.identityLost.cancel')}</Text>
					</TouchableOpacity>
				</>
			) : (
				<>
					<TouchableOpacity
						testID="identity-recovery-create"
						accessibilityRole="button"
						onPress={() => setConfirming(true)}
						style={BUTTON_STYLE}>
						<Text>{t('bootError.identityLost.create')}</Text>
					</TouchableOpacity>
					{failed && (
						<TouchableOpacity testID="identity-recovery-retry" accessibilityRole="button" onPress={onRetry} style={BUTTON_STYLE}>
							<Text>{t('bootError.tryAgain')}</Text>
						</TouchableOpacity>
					)}
				</>
			)}
		</View>
	);
}

export default IdentityRecoveryView;
