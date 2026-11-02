/**
 * JoinNetworkScreen — a voter joins an election authority's network from a join code (spike 100;
 * Phase 64 adds the scan entry).
 *
 * The authority's "Invite voters" card produces the code (`vtjoin2.…`, and `vtjoin1.…` while it
 * still decodes): a cadre invitation plus the network's founding anchor. The voter pastes it here
 * or scans the authority's QR, sees the network's name and fingerprint — which they compare with
 * the fingerprint the authority published — and taps Join. The provider's `joinNetwork` redeems the
 * invitation, opens the network's strand, accepts it only if its founding rows match the code, and
 * makes it the current network.
 *
 * Scan (D-02, D-05): the Scan entry opens `JoinCodeScanner`, which owns the camera permission and
 * device. A scan only fills the field (`setText`), exactly as a paste would; it never joins — only
 * the Join tap does. The scanner reports camera states through `onCameraState`, and each one shows a
 * plain sentence that points to paste. The scanned note shows only when the scanned text decodes
 * ok (R3): the note says "check the network name and fingerprint below", which would be false next
 * to an older, newer or malformed code's field error.
 *
 * Registered on the Settings, Registration and Timeline stacks (route closure, D-14); it only ever
 * goes back, so it adds no onward routes. Every failure is shown as translated copy chosen by the
 * typed reason — never the engine's own text (it can carry cadre-core error messages). The code
 * holds the invitation's private key (a bearer credential for cadre membership), so nothing here
 * logs it.
 *
 * Edge-to-edge: the ScrollView's bottom padding is 16 + the safe-area bottom + the keyboard inset,
 * so the Join button clears the IME on Android 15+ (where `adjustResize` is a no-op).
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {decodeNetworkJoinCode} from '@votetorrent/vote-engine/rn';
import type {NetworkJoinCodeDecodeFailure, NetworkJoinFailureReason, NetworkJoinStep} from '@votetorrent/vote-engine/rn';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {globalStyles} from '../../theme/styles';
import {errorClassName} from '../../utils/errorClassName';
import {useKeyboardInset} from '../../hooks/useKeyboardInset';
import JoinCodeScanner from './JoinCodeScanner';
import type {JoinScanCameraState} from './JoinCodeScanner';

/** The translated copy for each way a join can fail (keys in the `join` namespace). */
export function joinFailureKey(reason: NetworkJoinFailureReason): string {
	switch (reason) {
		case 'invitation-malformed':
			return 'invalidCode';
		case 'invitation-expired':
			return 'error.invitationExpired';
		case 'invitation-older-version':
			return 'olderCode';
		case 'invitation-used-up':
			return 'error.invitationUsedUp';
		case 'not-admitted':
			return 'error.notAdmitted';
		case 'no-peers':
			return 'error.noPeers';
		case 'not-synced':
			return 'error.notSynced';
		case 'digest-mismatch':
			return 'error.digestMismatch';
		case 'open-failed':
			return 'error.openFailed';
		case 'other-cadre':
			return 'error.otherCadre';
		default:
			return 'error.generic';
	}
}

/** The translated copy for each reason a pasted or scanned code does not decode (keys in `join`; D-07). */
export function joinDecodeErrorKey(reason: NetworkJoinCodeDecodeFailure): string {
	switch (reason) {
		case 'not-join-code':
			return 'notJoinCode';
		case 'unsupported-version':
			return 'newerCode';
		case 'invitation-older-version':
			return 'olderCode';
		case 'malformed':
			return 'invalidCode';
		default:
			return 'invalidCode';
	}
}

type ScanNotice = 'scanned' | 'denied' | 'failed';
type ScanAvailability = 'ready' | 'blocked' | 'none';

type Phase = {kind: 'idle'} | {kind: 'joining'; step: NetworkJoinStep} | {kind: 'joined'; name: string} | {kind: 'failed'; key: string};

export default function JoinNetworkScreen() {
	const {joinNetwork} = useVoterApp();
	const navigation = useNavigation();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('join');
	const [text, setText] = useState('');
	const [phase, setPhase] = useState<Phase>({kind: 'idle'});
	const [scannerOpen, setScannerOpen] = useState(false);
	const [availability, setAvailability] = useState<ScanAvailability>('ready');
	const [scanNotice, setScanNotice] = useState<ScanNotice | null>(null);
	const [scanCount, setScanCount] = useState(0);
	const scanButtonRef = useRef<React.ComponentRef<typeof Pressable>>(null);
	const wasScannerOpenRef = useRef(false);
	const announcedCountRef = useRef(0);
	const insets = useSafeAreaInsets();
	const keyboardInset = useKeyboardInset();

	const decoded = useMemo(() => (text.trim().length === 0 ? null : decodeNetworkJoinCode(text)), [text]);
	const busy = phase.kind === 'joining';

	// Focus returns to the Scan button when the scanner closes (R7).
	useEffect(() => {
		if (wasScannerOpenRef.current && !scannerOpen && scanButtonRef.current) {
			AccessibilityInfo.sendAccessibilityEvent(scanButtonRef.current, 'focus');
		}
		wasScannerOpenRef.current = scannerOpen;
	}, [scannerOpen]);

	// iOS has no live regions, so a scan that decodes ok is announced once (R8).
	const scannedOk = scanNotice === 'scanned' && decoded?.ok === true;
	useEffect(() => {
		if (scanCount > announcedCountRef.current && scannedOk && Platform.OS === 'ios') {
			announcedCountRef.current = scanCount;
			AccessibilityInfo.announceForAccessibility(t('scannedNotice'));
		}
	}, [scanCount, scannedOk, t]);

	async function onPaste() {
		const pasted = await Clipboard.getString().catch(() => '');
		if (pasted) {
			setText(pasted);
			setPhase({kind: 'idle'});
			setScanNotice(null);
		}
	}

	function onScanPress() {
		if (busy || availability !== 'ready') return;
		setScanNotice(null);
		setScannerOpen(true);
	}

	// D-02: a scan only fills the field, exactly as a paste would. Joining stays a separate tap.
	function onScanAccept(scanned: string) {
		setText(scanned);
		setPhase({kind: 'idle'});
		setScannerOpen(false);
		setScanNotice('scanned');
		setScanCount(count => count + 1);
	}

	function onScanClose() {
		setScannerOpen(false);
	}

	function onCameraState(state: JoinScanCameraState) {
		if (state === 'ready' || state === 'blocked' || state === 'none') setAvailability(state);
		if (state === 'denied' || state === 'failed') setScanNotice(state);
		if (state !== 'ready') setScannerOpen(false);
	}

	function onOpenSettings() {
		void (async () => {
			try {
				await Linking.openSettings();
			} catch {
				// The rejection (it can carry anything) is never read.
				console.info('[join] scan: open-settings-failed');
			}
		})();
	}

	async function onJoin() {
		if (!decoded?.ok || busy) return;
		setPhase({kind: 'joining', step: 'admitting'});
		try {
			const result = await joinNetwork(decoded.code, step => setPhase({kind: 'joining', step}));
			if (result.ok) {
				setPhase({kind: 'joined', name: result.networkRef.name});
			} else {
				// The reason token only; `detail` can carry cadre-core text and is never shown.
				console.warn('JoinNetworkScreen: join refused:', result.reason);
				setPhase({kind: 'failed', key: joinFailureKey(result.reason)});
			}
		} catch (error) {
			console.error('JoinNetworkScreen: join failed:', errorClassName(error));
			setPhase({kind: 'failed', key: 'error.generic'});
		}
	}

	const bodyStyle = {color: colors.text, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	const secondaryStyle = {color: colors.textSecondary, fontSize: typeScale.body.fontSize, lineHeight: typeScale.body.lineHeight};
	// Edge-to-edge: pad by the safe area AND the IME so the Join button can scroll clear of the keyboard.
	const containerStyle = [globalStyles.container, {paddingBottom: 16 + insets.bottom + keyboardInset}];
	const scanDisabled = busy || availability !== 'ready';
	let statusKind: 'none' | 'blocked' | 'scanned' | 'denied' | 'failed' | null = null;
	if (availability === 'none') statusKind = 'none';
	else if (availability === 'blocked') statusKind = 'blocked';
	else if (scannedOk) statusKind = 'scanned';
	else if (scanNotice === 'denied' || scanNotice === 'failed') statusKind = scanNotice;

	if (phase.kind === 'joined') {
		return (
			<ScrollView style={[styles.screen, {backgroundColor: colors.background}]} contentContainerStyle={containerStyle}>
				<Text testID="join-network-joined" style={[styles.heading, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
					{t('joinedTitle', {name: phase.name})}
				</Text>
				<Pressable
					testID="join-network-done"
					accessibilityRole="button"
					onPress={() => navigation.goBack()}
					style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
					<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
						{t('doneButton')}
					</Text>
				</Pressable>
			</ScrollView>
		);
	}

	return (
		<>
		<ScrollView
			style={[styles.screen, {backgroundColor: colors.background}]}
			contentContainerStyle={containerStyle}
			keyboardShouldPersistTaps="handled">
			<Text style={[styles.paragraph, secondaryStyle]}>{t('intro')}</Text>

			<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
				<Pressable
					ref={scanButtonRef}
					testID="join-network-scan"
					accessibilityRole="button"
					accessibilityState={{disabled: scanDisabled}}
					disabled={scanDisabled}
					onPress={onScanPress}
					style={[
						styles.scanButton,
						{
							backgroundColor: colors.secondaryButtonSurface,
							borderColor: scanDisabled ? colors.border : colors.primary,
							borderRadius: radii.md,
						},
					]}>
					<FontAwesome6 name="qrcode" size={16} color={scanDisabled ? colors.textSecondary : colors.primary} style={styles.scanIcon} />
					<Text
						style={[
							styles.scanLabel,
							{
								color: scanDisabled ? colors.textSecondary : colors.primary,
								fontFamily: fonts.bold.fontFamily,
								fontWeight: fonts.bold.fontWeight,
							},
						]}>
						{t('scanButton')}
					</Text>
				</Pressable>

				<View style={styles.labelRow}>
					<Text style={[styles.fieldLabel, secondaryStyle]}>{t('codeLabel')}</Text>
					<Pressable testID="join-network-paste" accessibilityRole="button" onPress={onPaste} disabled={busy} style={styles.pasteButton}>
						<Text style={{color: colors.link, fontSize: typeScale.body.fontSize}}>{t('pasteButton')}</Text>
					</Pressable>
				</View>
				<TextInput
					testID="join-network-code-input"
					value={text}
					editable={!busy}
					onChangeText={value => {
						setText(value);
						setScanNotice(null);
						if (phase.kind === 'failed') setPhase({kind: 'idle'});
					}}
					placeholder={t('codePlaceholder')}
					placeholderTextColor={colors.textSecondary}
					autoCapitalize="none"
					autoCorrect={false}
					multiline
					style={[
						styles.input,
						{
							color: colors.text,
							borderColor: decoded && !decoded.ok ? colors.error : colors.primary,
							fontFamily: fonts.regular.fontFamily,
							fontSize: typeScale.caption.fontSize,
						},
					]}
				/>
				{decoded && !decoded.ok ? (
					<Text testID="join-network-code-error" style={[styles.fieldError, {color: colors.error, fontSize: typeScale.caption.fontSize}]}>
						{t(joinDecodeErrorKey(decoded.reason))}
					</Text>
				) : null}

				{statusKind ? (
					<View testID="join-network-scan-status" style={styles.scanStatus}>
						{statusKind === 'scanned' ? (
							<View style={styles.noticeRow}>
								<FontAwesome6 name="circle-check" size={16} color={colors.text} style={styles.noticeIcon} />
								<Text accessibilityRole="text" accessibilityLiveRegion="polite" style={[styles.noticeText, bodyStyle, {fontFamily: fonts.regular.fontFamily}]}>
									{t('scannedNotice')}
								</Text>
							</View>
						) : (
							<View
								accessibilityRole="alert"
								style={[
									styles.noticeRow,
									styles.noticeShell,
									{backgroundColor: colors.card, borderColor: colors.warning, borderRadius: radii.sm},
								]}>
								<FontAwesome6 name="triangle-exclamation" size={16} color={colors.warning} style={styles.noticeIcon} />
								<Text style={[styles.noticeText, bodyStyle, {fontFamily: fonts.regular.fontFamily}]}>
									{statusKind === 'none'
										? t('cameraNone')
										: statusKind === 'blocked'
											? t('cameraBlocked')
											: statusKind === 'denied'
												? t('cameraDenied')
												: t('cameraFailed')}
								</Text>
							</View>
						)}
						{statusKind === 'blocked' ? (
							<Pressable testID="join-network-scan-open-settings" accessibilityRole="button" onPress={onOpenSettings} style={styles.openSettings}>
								<Text style={{color: colors.link, fontSize: typeScale.body.fontSize}}>{t('openSettings')}</Text>
							</Pressable>
						) : null}
					</View>
				) : null}

				{decoded?.ok ? (
					<View testID="join-network-preview" style={styles.preview}>
						<Text style={secondaryStyle}>{t('previewNetwork')}</Text>
						<Text testID="join-network-preview-name" style={[styles.previewValue, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
							{decoded.code.name}
						</Text>
						<Text style={secondaryStyle}>{t('previewFingerprint')}</Text>
						<Text
							testID="join-network-preview-fingerprint"
							selectable
							style={[styles.previewValue, bodyStyle, {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
							{decoded.fingerprint}
						</Text>
						<Text style={[styles.paragraph, secondaryStyle]}>{t('previewCheck')}</Text>
					</View>
				) : null}

				{phase.kind === 'failed' ? (
					<Text testID="join-network-error" style={[styles.fieldError, {color: colors.error, fontSize: typeScale.body.fontSize}]}>
						{t(phase.key)}
					</Text>
				) : null}

				{phase.kind === 'joining' ? (
					<View testID="join-network-progress" style={styles.progress}>
						<ActivityIndicator color={colors.primary} />
						<Text testID="join-network-step" style={[styles.progressLabel, secondaryStyle]}>
							{t(`step.${phase.step}`)}
						</Text>
					</View>
				) : (
					<Pressable
						testID="join-network-submit"
						accessibilityRole="button"
						accessibilityState={{disabled: !decoded?.ok}}
						disabled={!decoded?.ok}
						onPress={onJoin}
						style={[
							styles.cta,
							{backgroundColor: decoded?.ok ? colors.primary : colors.secondaryButtonSurface, borderRadius: radii.pill},
						]}>
						<Text
							style={[
								styles.ctaLabel,
								{
									color: decoded?.ok ? colors.light : colors.textSecondary,
									fontFamily: fonts.bold.fontFamily,
									fontWeight: fonts.bold.fontWeight,
								},
							]}>
							{t('joinButton')}
						</Text>
					</Pressable>
				)}
			</View>
		</ScrollView>
		<JoinCodeScanner
			visible={scannerOpen}
			onAccept={onScanAccept}
			onClose={onScanClose}
			onPasteInstead={onScanClose}
			onCameraState={onCameraState}
		/>
		</>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	paragraph: {
		marginBottom: 16, // md
	},
	heading: {
		marginBottom: 16,
	},
	labelRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'center',
	},
	fieldLabel: {
		marginBottom: 8, // sm
	},
	pasteButton: {
		minHeight: 44,
		minWidth: 44,
		justifyContent: 'center',
		alignItems: 'flex-end',
	},
	input: {
		borderWidth: 1,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 12,
		minHeight: 96,
		textAlignVertical: 'top',
	},
	fieldError: {
		marginTop: 8,
	},
	scanButton: {
		minHeight: 44,
		marginBottom: 16,
		borderWidth: 1,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 16,
	},
	scanIcon: {
		marginRight: 4,
	},
	scanLabel: {
		fontSize: 16,
		lineHeight: 22,
	},
	scanStatus: {
		marginTop: 8,
	},
	noticeRow: {
		flexDirection: 'row',
		alignItems: 'flex-start',
	},
	noticeShell: {
		borderWidth: 1,
		padding: 16,
	},
	noticeIcon: {
		marginRight: 8,
		marginTop: 3,
	},
	noticeText: {
		flexShrink: 1,
	},
	openSettings: {
		minHeight: 44,
		justifyContent: 'center',
	},
	preview: {
		marginTop: 16,
	},
	previewValue: {
		marginBottom: 12,
	},
	progress: {
		marginTop: 16,
		flexDirection: 'row',
		alignItems: 'center',
		minHeight: 44,
	},
	progressLabel: {
		marginLeft: 12,
		flexShrink: 1,
	},
	cta: {
		marginTop: 16,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	ctaLabel: {
		fontWeight: '600',
	},
});
