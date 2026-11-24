/**
 * JoinCodeScanner - the camera scanner behind the Join screen's "Scan QR code" entry (Phase 64,
 * plan 64-18; D-02, D-05, D-06).
 *
 * What it is: a full-screen portrait Modal (never a route, so nothing the camera reads can reach
 * navigation params) that shows the back camera, reads QR codes, and hands the first VoteTorrent
 * join code to `onAccept` as text. That is all it does (D-02): the Join screen puts the text in
 * its field exactly as a paste would and the voter still has to tap Join. The scanner never reads
 * `joinNetwork`.
 *
 * Why Camera plus `useBarcodeScannerOutput` and not the library's `CodeScanner`: `CodeScanner`
 * throws when there is no device, and the jest mock enforces the same. Composing the two pieces
 * keeps every camera state (no permission, no device, a start failure) in this file's control.
 * The `Camera` sits inside a plain RN `View` that carries the testID, because a testID on the
 * Nitro `Camera` itself is dropped (Nitro #1656).
 *
 * D-05: every camera state is reported to the Join screen through `onCameraState`, which shows a
 * plain sentence that points to paste. The permission is requested only inside an open attempt
 * started by the Scan press, never on mount. R1: this component is the ONLY owner of
 * `useCameraPermission()` / `useCameraDevice()`, because two permission hooks do not share state
 * after a request; the screen learns availability and failures only through the callback.
 *
 * Choose image: inside the scanner, next to Paste instead, a "Choose image" button opens the
 * system photo picker so a photo or screenshot of the join-code QR can be read instead of the live
 * camera. The camera pauses while the picker is open and resumes when it closes without a code.
 * The picked image is read by `pickImageAndReadQrCodes` (engines/qr-image-decode, which deletes the
 * picker's copy), and its QR values go through `judgeScannedValues`, the same check a camera frame
 * goes through: a join code reaches `onAccept` exactly as a scan would, and anything else gets the
 * same "not a join code" banner. A cancelled pick, a picture with no QR and an unreadable picture
 * each get their own banner. A build without the image picker shows the button disabled with a
 * sentence that says so. The Join screen uses `useScanImage` for the same pick when the camera is off.
 *
 * D-06: the join code is a bearer credential. This file never logs, stores or forwards a barcode
 * object, `rawValue` (other than the one accepted value handed to `onAccept`), corner points, raw
 * bytes, or an error object or message. Every console call is `console.info` with one closed
 * literal token. The scan callback reads refs only (the hook memoises on formats and resolution,
 * so a captured closure would go stale).
 *
 * This is not a `*Screen.tsx`, so the scroll-container lint does not apply: the scanner has no
 * scrolling content, it is a fixed full-screen camera layout. The `useVoterApp()` call below only
 * satisfies the SHELL-03 guard (R9) and its value is never read.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions} from 'react-native';
import {useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {Camera, useCameraDevice, useCameraPermission} from 'react-native-vision-camera';
import type {CameraDevice} from 'react-native-vision-camera';
import {useBarcodeScannerOutput} from 'react-native-vision-camera-barcode-scanner';
import type {Barcode, BarcodeScannerOutputResolution, TargetBarcodeFormat} from 'react-native-vision-camera-barcode-scanner';
import {looksLikeJoinCode} from '@votetorrent/vote-engine/rn';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {isQrImageDecodeAvailable, pickImageAndReadQrCodes} from '../../engines/qr-image-decode';
import type {QrImageReadResult} from '../../engines/qr-image-decode';

export type JoinScanCameraState = 'ready' | 'blocked' | 'none' | 'denied' | 'failed';

export interface JoinCodeScannerProps {
	visible: boolean;
	onAccept(text: string): void;
	onClose(): void;
	onPasteInstead(): void;
	/** Additive (R1): availability and failure reports for the Join screen's notices. */
	onCameraState(state: JoinScanCameraState): void;
}

/** QR only. Module scope, so the array identity is stable and `useBarcodeScannerOutput` never re-creates its output for it. */
export const JOIN_SCAN_BARCODE_FORMATS: TargetBarcodeFormat[] = ['qr-code'];
/** From the camera's onStarted to the scanSlow line and the switch to full resolution. */
export const JOIN_SCAN_SLOW_MS = 8_000;
/** How long the "not a join code" banner stays. */
export const JOIN_SCAN_BANNER_MS = 4_000;
/** After a rejection, further non-join-code reads are ignored for this long. */
export const JOIN_SCAN_REJECT_IGNORE_MS = 1_500;

/** 'denied' | 'restricted' -> 'blocked'; 'authorized' with no device -> 'none'; anything else -> 'ready' (R4). */
export function joinScanAvailability(status: string, hasDevice: boolean): 'ready' | 'blocked' | 'none' {
	if (status === 'denied' || status === 'restricted') return 'blocked';
	if (status === 'authorized' && !hasDevice) return 'none';
	return 'ready';
}

/** What a read holds: the camera's frames and a picked image are judged by this one rule. */
export type ScanReadVerdict = {type: 'accepted'; value: string} | {type: 'not-join-code'};

/** The first join code among the read values, or the refusal. */
export function judgeScannedValues(values: readonly unknown[]): ScanReadVerdict {
	for (const value of values) {
		if (typeof value === 'string' && looksLikeJoinCode(value)) return {type: 'accepted', value};
	}
	return {type: 'not-join-code'};
}

/** A picked image, judged: the join code to accept, or the sentence (a `join` i18n key) and its closed log token. */
export type ScanImageOutcome = {type: 'accepted'; value: string} | {type: 'message'; key: string; token: string};

/** Map a picker read to what the scanner and the Join screen do with it. */
export function scanImageOutcome(result: QrImageReadResult): ScanImageOutcome {
	switch (result.kind) {
		case 'decoded': {
			const verdict = judgeScannedValues(result.values);
			return verdict.type === 'accepted' ? verdict : {type: 'message', key: 'scanNotJoinCode', token: 'rejected-not-join-code'};
		}
		case 'no-code':
			return {type: 'message', key: 'scanImageNoCode', token: 'no-code'};
		case 'unreadable':
			return {type: 'message', key: 'scanImageUnreadable', token: 'unreadable'};
		case 'unavailable':
			return {type: 'message', key: 'scanImageUnavailable', token: 'unavailable'};
		case 'cancelled':
		default:
			return {type: 'message', key: 'scanImageCancelled', token: 'cancelled'};
	}
}

export interface ScanImagePicker {
	/** False on a build without the image picker: the button is shown disabled with a sentence. */
	available: boolean;
	/** True while the photo picker is open or its image is being read. */
	picking: boolean;
	/** Open the picker and judge the image. Resolves null when a pick is already open or the caller unmounted. Never rejects. */
	pick(): Promise<ScanImageOutcome | null>;
}

/** The Choose image pick, shared by the scanner and the Join screen's camera-off notice. */
export function useScanImage(): ScanImagePicker {
	const available = useMemo(() => isQrImageDecodeAvailable(), []);
	const [picking, setPicking] = useState(false);
	const pickingRef = useRef(false);
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const pick = useCallback(async (): Promise<ScanImageOutcome | null> => {
		if (pickingRef.current) return null;
		if (!available) {
			console.info('[join] image: unavailable');
			return scanImageOutcome({kind: 'unavailable'});
		}
		pickingRef.current = true;
		setPicking(true);
		try {
			let result: QrImageReadResult;
			try {
				result = await pickImageAndReadQrCodes({logTag: '[join]'});
			} catch {
				// pickImageAndReadQrCodes never rejects; a stand-in that does is an unreadable image.
				result = {kind: 'unreadable'};
			}
			if (!mountedRef.current) return null;
			const outcome = scanImageOutcome(result);
			console.info(`[join] image: ${outcome.type === 'accepted' ? 'accepted' : outcome.token}`);
			return outcome;
		} finally {
			pickingRef.current = false;
			if (mountedRef.current) setPicking(false);
		}
	}, [available]);
	return {available, picking, pick};
}

// Fixed colours: they sit on live camera video, so they are not theme tokens (UI-SPEC "Color").
const SCRIM = 'rgba(0,0,0,0.55)';
const BANNER_BG = 'rgba(0,0,0,0.75)';
const INK = '#FFFFFF';
const BACKDROP = '#000000';
const VIEWFINDER_INSET = 32;
const CORNER_LEN = 32;
const CORNER_THICK = 4;
const TEXT_MAX_WIDTH = 296;

type Phase = 'closed' | 'requesting' | 'refused' | 'starting' | 'scanning' | 'accepted';

interface ScannerCameraProps {
	device: CameraDevice;
	resolution: BarcodeScannerOutputResolution;
	isActive: boolean;
	onBarcodes(barcodes: Barcode[]): void;
	onStarted(): void;
	onCameraError(): void;
	onScannerError(): void;
}

/** A fresh Camera plus a fresh output per `resolution` (the parent keys it by resolution, R5). */
function ScannerCamera({device, resolution, isActive, onBarcodes, onStarted, onCameraError, onScannerError}: ScannerCameraProps) {
	const output = useBarcodeScannerOutput({
		barcodeFormats: JOIN_SCAN_BARCODE_FORMATS,
		outputResolution: resolution,
		onBarcodeScanned: onBarcodes,
		onError: onScannerError,
	});
	const outputs = useMemo(() => [output], [output]);
	return <Camera style={StyleSheet.absoluteFill} device={device} isActive={isActive} outputs={outputs} onStarted={onStarted} onError={onCameraError} />;
}

export default function JoinCodeScanner(props: JoinCodeScannerProps) {
	// SHELL-03 token call (R9): the scanner reads nothing from the app, and never `joinNetwork` (D-02).
	useVoterApp();
	const {fonts} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('join');
	const insets = useSafeAreaInsets();
	const {width, height} = useWindowDimensions();
	const {status, requestPermission} = useCameraPermission();
	const device = useCameraDevice('back');

	const [phase, setPhase] = useState<Phase>('closed');
	const [resolution, setResolution] = useState<BarcodeScannerOutputResolution>('preview');
	const [slow, setSlow] = useState(false);
	const [bannerKey, setBannerKey] = useState<string | null>(null);
	const [appActive, setAppActive] = useState(true);

	// Refs mirror the latest render, so the scan callback and the async open attempt never read stale values.
	const statusRef = useRef(status);
	const deviceRef = useRef(device);
	const requestPermissionRef = useRef(requestPermission);
	const visibleRef = useRef(props.visible);
	const onAcceptRef = useRef(props.onAccept);
	const onCameraStateRef = useRef(props.onCameraState);
	statusRef.current = status;
	deviceRef.current = device;
	requestPermissionRef.current = requestPermission;
	visibleRef.current = props.visible;
	onAcceptRef.current = props.onAccept;
	onCameraStateRef.current = props.onCameraState;

	const image = useScanImage();
	const imagePick = image.pick;
	const lockRef = useRef(false);
	// True while the photo picker is open: camera frames are ignored and the camera is paused.
	const pausedRef = useRef(false);
	const ignoreRejectRef = useRef(false);
	const attemptRef = useRef(0);
	const mountedRef = useRef(true);
	const slowStartedRef = useRef(false);
	const lastAvailabilityRef = useRef<string | undefined>(undefined);
	const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const ignoreTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const slowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const clearTimers = useCallback(() => {
		if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
		if (ignoreTimerRef.current !== undefined) clearTimeout(ignoreTimerRef.current);
		if (slowTimerRef.current !== undefined) clearTimeout(slowTimerRef.current);
		bannerTimerRef.current = undefined;
		ignoreTimerRef.current = undefined;
		slowTimerRef.current = undefined;
	}, []);

	const report = useCallback((state: JoinScanCameraState) => {
		if (state === 'ready' || state === 'blocked' || state === 'none') lastAvailabilityRef.current = state;
		onCameraStateRef.current(state);
	}, []);

	// Availability, reported while the scanner is hidden too: this component owns the camera hooks (R1).
	useEffect(() => {
		const value = joinScanAvailability(status, device !== undefined);
		if (lastAvailabilityRef.current !== value) report(value);
	}, [status, device, report]);

	// Foreground / background: the camera runs only while the app is active.
	useEffect(() => {
		mountedRef.current = true;
		const subscription = AppState.addEventListener('change', next => setAppActive(next === 'active'));
		return () => {
			mountedRef.current = false;
			subscription.remove();
			clearTimers();
		};
	}, [clearTimers]);

	// One open attempt per rising edge of `visible`.
	useEffect(() => {
		if (!props.visible) {
			clearTimers();
			setPhase('closed');
			setBannerKey(null);
			setSlow(false);
			setResolution('preview');
			return;
		}
		attemptRef.current += 1;
		const attempt = attemptRef.current;
		lockRef.current = false;
		ignoreRejectRef.current = false;
		slowStartedRef.current = false;
		clearTimers();
		setBannerKey(null);
		setSlow(false);
		setResolution('preview');

		const current = () => mountedRef.current && visibleRef.current && attemptRef.current === attempt;
		const deviceCheck = () => {
			if (deviceRef.current === undefined) {
				console.info('[join] scan: no-camera');
				report('none');
				setPhase('closed');
			} else {
				setPhase('starting');
			}
		};

		const known = statusRef.current;
		if (known === 'denied' || known === 'restricted') {
			console.info('[join] scan: permission-blocked');
			report('blocked');
			setPhase('closed');
			return;
		}
		if (known === 'not-determined') {
			setPhase('requesting');
			void (async () => {
				try {
					const granted = await requestPermissionRef.current();
					if (!current()) return;
					if (granted) deviceCheck();
					else setPhase('refused');
				} catch {
					// The rejection (it can carry anything) is never read.
					if (!current()) return;
					console.info('[join] scan: permission-request-failed');
					report('failed');
					setPhase('closed');
				}
			})();
			return;
		}
		deviceCheck();
	}, [props.visible, clearTimers, report]);

	// A refused request: blocked when the OS will not ask again, denied when it still will.
	useEffect(() => {
		if (phase !== 'refused') return;
		if (status === 'denied' || status === 'restricted') {
			console.info('[join] scan: permission-blocked');
			report('blocked');
		} else {
			console.info('[join] scan: permission-denied');
			report('denied');
		}
		setPhase('closed');
	}, [phase, status, report]);

	// Stable (empty deps), refs only: the library memoises the output on formats and resolution.
	const onBarcodes = useCallback((barcodes: Barcode[]) => {
		if (lockRef.current || pausedRef.current) return;
		const verdict = judgeScannedValues(barcodes.map(barcode => barcode.rawValue));
		const accepted = verdict.type === 'accepted' ? verdict.value : undefined;
		if (accepted !== undefined) {
			lockRef.current = true;
			if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
			setBannerKey(null);
			setPhase('accepted');
			console.info('[join] scan: accepted');
			onAcceptRef.current(accepted);
			return;
		}
		if (ignoreRejectRef.current) return;
		ignoreRejectRef.current = true;
		console.info('[join] scan: rejected-not-join-code');
		setBannerKey('scanNotJoinCode');
		if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
		bannerTimerRef.current = setTimeout(() => setBannerKey(null), JOIN_SCAN_BANNER_MS);
		if (ignoreTimerRef.current !== undefined) clearTimeout(ignoreTimerRef.current);
		ignoreTimerRef.current = setTimeout(() => {
			ignoreRejectRef.current = false;
		}, JOIN_SCAN_REJECT_IGNORE_MS);
	}, []);

	const showBanner = useCallback((key: string) => {
		setBannerKey(key);
		if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
		bannerTimerRef.current = setTimeout(() => setBannerKey(null), JOIN_SCAN_BANNER_MS);
	}, []);

	// Choose image: pause the camera, read the picked image, then accept it exactly as a scan or
	// show its banner and resume. A pick that returns after the scanner closed is dropped.
	const onChooseImage = useCallback(async () => {
		if (lockRef.current || pausedRef.current) return;
		const attempt = attemptRef.current;
		pausedRef.current = true;
		if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
		setBannerKey(null);
		let outcome: ScanImageOutcome | null;
		try {
			outcome = await imagePick();
		} finally {
			pausedRef.current = false;
		}
		if (outcome === null || !mountedRef.current || !visibleRef.current || attemptRef.current !== attempt || lockRef.current) return;
		if (outcome.type === 'accepted') {
			lockRef.current = true;
			setPhase('accepted');
			console.info('[join] scan: accepted');
			onAcceptRef.current(outcome.value);
			return;
		}
		showBanner(outcome.key);
	}, [imagePick, showBanner]);

	const onStarted = useCallback(() => {
		setPhase(p => (p === 'starting' ? 'scanning' : p));
		if (slowStartedRef.current) return;
		slowStartedRef.current = true;
		slowTimerRef.current = setTimeout(() => {
			setSlow(true);
			setResolution('full');
		}, JOIN_SCAN_SLOW_MS);
	}, []);

	const onCameraError = useCallback(() => {
		console.info('[join] scan: camera-failed');
		report('failed');
		setPhase('closed');
	}, [report]);

	const onScannerError = useCallback(() => {
		console.info('[join] scan: scanner-failed');
		report('failed');
		setPhase('closed');
	}, [report]);

	const side = Math.round(Math.min(width, height) - 2 * VIEWFINDER_INSET);
	const left = Math.round((width - side) / 2);
	const top = Math.round(insets.top + 0.45 * (height - insets.top - insets.bottom) - side / 2);
	const textWidth = Math.min(TEXT_MAX_WIDTH, width - 2 * 16);
	const textLeft = Math.round((width - textWidth) / 2);
	const pasteBottom = insets.bottom + 16;
	const showCamera = (phase === 'starting' || phase === 'scanning' || phase === 'accepted') && device !== undefined;
	const cameraActive = (phase === 'starting' || phase === 'scanning') && appActive && !image.picking;
	const imageDisabled = !image.available || image.picking || phase === 'accepted';
	const waiting = phase === 'requesting' || phase === 'starting';
	const boldText = {fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight};
	const regularText = {fontFamily: fonts.regular.fontFamily, fontWeight: fonts.regular.fontWeight};

	return (
		<Modal
			visible={props.visible}
			presentationStyle="fullScreen"
			statusBarTranslucent
			supportedOrientations={['portrait']}
			animationType="slide"
			onRequestClose={props.onClose}>
			<View testID="join-network-scanner" style={styles.root}>
				{showCamera && device !== undefined ? (
					<View testID="join-network-scan-preview" style={StyleSheet.absoluteFill}>
						<ScannerCamera
							key={resolution}
							device={device}
							resolution={resolution}
							isActive={cameraActive}
							onBarcodes={onBarcodes}
							onStarted={onStarted}
							onCameraError={onCameraError}
							onScannerError={onScannerError}
						/>
					</View>
				) : null}

				<View pointerEvents="none" style={[styles.scrim, {top: 0, left: 0, right: 0, height: top}]} />
				<View pointerEvents="none" style={[styles.scrim, {top: top + side, left: 0, right: 0, bottom: 0}]} />
				<View pointerEvents="none" style={[styles.scrim, {top, left: 0, width: left, height: side}]} />
				<View pointerEvents="none" style={[styles.scrim, {top, left: left + side, right: 0, height: side}]} />

				<View testID="join-network-scan-viewfinder" pointerEvents="none" style={{position: 'absolute', top, left, width: side, height: side}}>
					<View style={[styles.corner, styles.cornerTL]} />
					<View style={[styles.corner, styles.cornerTR]} />
					<View style={[styles.corner, styles.cornerBL]} />
					<View style={[styles.corner, styles.cornerBR]} />
				</View>

				<View style={[styles.titleRow, {top: insets.top + 8}]} pointerEvents="none">
					<Text testID="join-network-scan-title" style={[styles.title, boldText]}>
						{t('scanTitle')}
					</Text>
				</View>
				<Pressable
					testID="join-network-scan-close"
					accessibilityRole="button"
					accessibilityLabel={t('scanClose')}
					onPress={props.onClose}
					style={[styles.closeButton, {top: insets.top + 8}]}>
					<FontAwesome6 name="xmark" size={24} color={INK} />
				</Pressable>

				<View style={{position: 'absolute', top: top + side + 24, left: textLeft, width: textWidth, alignItems: 'center'}}>
					{waiting ? (
						<View testID="join-network-scan-starting" style={styles.startingRow}>
							<ActivityIndicator color={INK} />
							<Text style={[styles.body, regularText, styles.startingText]}>{t('scanStarting')}</Text>
						</View>
					) : (
						<Text testID="join-network-scan-instruction" style={[styles.body, regularText]}>
							{slow ? t('scanSlow') : t('scanInstruction')}
						</Text>
					)}
				</View>

				<View style={[styles.bottomBar, {bottom: pasteBottom}]} pointerEvents="box-none">
					{bannerKey !== null ? (
						<View testID="join-network-scan-banner" accessibilityRole="alert" style={styles.banner}>
							<FontAwesome6 name="circle-exclamation" size={16} color={INK} />
							<Text style={[styles.body, regularText, styles.bannerText]}>{t(bannerKey)}</Text>
						</View>
					) : null}

					{!image.available ? (
						<Text testID="join-network-scan-image-unavailable" style={[styles.caption, regularText]}>
							{t('scanImageUnavailable')}
						</Text>
					) : null}
					<Pressable
						testID="join-network-scan-image"
						accessibilityRole="button"
						accessibilityLabel={t('scanImageLabel')}
						accessibilityState={{disabled: imageDisabled, busy: image.picking}}
						disabled={imageDisabled}
						onPress={onChooseImage}
						style={[styles.imageButton, !image.available ? styles.imageButtonDisabled : null]}>
						{image.picking ? (
							<ActivityIndicator testID="join-network-scan-image-busy" color={INK} />
						) : (
							<FontAwesome6 name="image" size={18} color={INK} />
						)}
						<Text style={[styles.imageLabel, boldText]}>{t('scanImageButton')}</Text>
					</Pressable>

					<Pressable
						testID="join-network-scan-paste"
						accessibilityRole="button"
						onPress={props.onPasteInstead}
						style={styles.pasteButton}>
						<Text style={[styles.pasteLabel, boldText]}>{t('scanPasteInstead')}</Text>
					</Pressable>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: {
		flex: 1,
		backgroundColor: BACKDROP,
	},
	scrim: {
		position: 'absolute',
		backgroundColor: SCRIM,
	},
	corner: {
		position: 'absolute',
		width: CORNER_LEN,
		height: CORNER_LEN,
		borderColor: INK,
		borderRadius: 4,
	},
	cornerTL: {top: 0, left: 0, borderTopWidth: CORNER_THICK, borderLeftWidth: CORNER_THICK},
	cornerTR: {top: 0, right: 0, borderTopWidth: CORNER_THICK, borderRightWidth: CORNER_THICK},
	cornerBL: {bottom: 0, left: 0, borderBottomWidth: CORNER_THICK, borderLeftWidth: CORNER_THICK},
	cornerBR: {bottom: 0, right: 0, borderBottomWidth: CORNER_THICK, borderRightWidth: CORNER_THICK},
	titleRow: {
		position: 'absolute',
		left: 72,
		right: 72,
		height: 48,
		alignItems: 'center',
		justifyContent: 'center',
	},
	title: {
		color: INK,
		fontSize: 20,
		lineHeight: 26,
		textAlign: 'center',
	},
	closeButton: {
		position: 'absolute',
		left: 16,
		width: 48,
		height: 48,
		borderRadius: 24,
		backgroundColor: SCRIM,
		alignItems: 'center',
		justifyContent: 'center',
	},
	startingRow: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
	},
	startingText: {
		marginLeft: 12,
		flexShrink: 1,
	},
	body: {
		color: INK,
		fontSize: 16,
		lineHeight: 22,
		textAlign: 'center',
	},
	bottomBar: {
		position: 'absolute',
		left: 0,
		right: 0,
		alignItems: 'center',
		gap: 12,
	},
	banner: {
		alignSelf: 'stretch',
		marginHorizontal: 16,
		flexDirection: 'row',
		alignItems: 'center',
		backgroundColor: BANNER_BG,
		borderRadius: 8,
		padding: 16,
	},
	bannerText: {
		flex: 1,
		marginLeft: 12,
		textAlign: 'left',
	},
	caption: {
		color: INK,
		fontSize: 14,
		lineHeight: 20,
		textAlign: 'center',
		maxWidth: TEXT_MAX_WIDTH,
	},
	imageButton: {
		minHeight: 48,
		paddingHorizontal: 20,
		borderRadius: 24,
		borderWidth: 1,
		borderColor: INK,
		backgroundColor: SCRIM,
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		gap: 10,
	},
	imageButtonDisabled: {
		opacity: 0.5,
	},
	imageLabel: {
		color: INK,
		fontSize: 16,
		lineHeight: 22,
	},
	pasteButton: {
		alignSelf: 'stretch',
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
	pasteLabel: {
		color: INK,
		fontSize: 16,
		lineHeight: 22,
	},
});
