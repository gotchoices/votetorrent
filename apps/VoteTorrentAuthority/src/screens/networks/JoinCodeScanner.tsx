/**
 * JoinCodeScanner - the camera scanner behind the Authority's "Scan QR code" entries: the Scan
 * button on the Join a network screen, and the Scan button on the Networks screen, which opens the
 * Join a network screen with this scanner already open.
 *
 * A port of the Voter's scanner (apps/VoteTorrentVoter/src/screens/settings/JoinCodeScanner.tsx)
 * with the same rules. The user ruled on 2026-11-23 to give the Authority a camera so an officer or
 * keyholder can join by scanning the election office's join-code QR.
 *
 * What it is: a full-screen portrait Modal (never a route, so nothing the camera reads can reach
 * navigation params) that shows the back camera, reads QR codes, and hands the first VoteTorrent
 * join code to `onAccept` as text. That is all it does: the Join screen puts the text in its field
 * exactly as a paste would, shows the network name and fingerprint, and the officer still has to tap
 * Join. The scanner never starts a join.
 *
 * Why Camera plus `useBarcodeScannerOutput` and not the library's `CodeScanner`: `CodeScanner`
 * throws when there is no device, and the jest mock enforces the same. Composing the two pieces
 * keeps every camera state (no permission, no device, a start failure) in this file's control.
 * The `Camera` sits inside a plain RN `View` that carries the testID, because a testID on the
 * Nitro `Camera` itself is dropped (Nitro #1656).
 *
 * Every camera state is reported to the Join screen through `onCameraState`, which shows a plain
 * sentence that points to paste. The permission is requested only inside an open attempt started
 * by a Scan press, never on mount of a closed scanner. This component is the ONLY owner of
 * `useCameraPermission()` / `useCameraDevice()`, because two permission hooks do not share state
 * after a request; the screen learns availability and failures only through the callback.
 *
 * Two kinds: `kind="join-code"` (the default; the Join a network screen) accepts only a join code,
 * and `kind="invitation"` (Settings, Accept an Invitation) accepts only an invitation share. Each
 * refuses the other with a banner that says which kind it saw and where it belongs, and refuses any
 * other QR with the plain "not a ..." banner. The kind picks the copy, the testID prefix
 * (`join-network-*` or `accept-invitation-*`) and the log tag (`[join]` or `[invite]`).
 *
 * Choose image: inside the scanner, next to Paste instead, a "Choose image" button opens the
 * system photo picker so a photo or screenshot of the QR can be read instead of the live camera.
 * The camera pauses while the picker is open and resumes when it closes without a code. The
 * picked image is read by `pickImageAndReadQrCodes` (engines/qr-image-decode, which deletes the
 * picker's copy), and its QR values go through `judgeScannedValues`, the same check a camera frame
 * goes through: the accepted value reaches `onAccept` exactly as a scan would, and a wrong kind
 * gets the same banner. A cancelled pick, a picture with no QR and an unreadable picture each get
 * their own banner. A build without the image picker shows the button disabled with a sentence
 * that says so. The screens use `useScanImage` for the same pick when the camera is off.
 *
 * The join code is a bearer credential, and an invitation holds its private key. This file never logs, stores or forwards a barcode object,
 * `rawValue` (other than the one accepted value handed to `onAccept`), corner points, raw bytes, or
 * an error object or message. Every console call is `console.info` with one closed literal token.
 * The scan callback reads refs only (the hook memoises on formats and resolution, so a captured
 * closure would go stale).
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
import {isInvitationQrText} from '../invitations/invite-share';
import {isQrImageDecodeAvailable, pickImageAndReadQrCodes} from '../../engines/qr-image-decode';
import type {QrImageReadResult} from '../../engines/qr-image-decode';

export type JoinScanCameraState = 'ready' | 'blocked' | 'none' | 'denied' | 'failed';

/** What the scanner is looking for. */
export type ScanKind = 'join-code' | 'invitation';

interface ScanKindConfig {
	testIDPrefix: string;
	logTag: string;
	titleKey: string;
	instructionKey: string;
	slowKey: string;
	pasteKey: string;
	accepts(value: string): boolean;
	/** The other VoteTorrent kind: refused with its own banner, which says where it belongs. */
	isOtherKind(value: string): boolean;
	otherKindKey: string;
	otherKindToken: string;
	notKindKey: string;
	notKindToken: string;
	/** Choose image: the picker closed with no picture. */
	imageCancelledKey: string;
	/** Choose image: the picture holds no QR code. */
	imageNoCodeKey: string;
	/** Choose image: the picture could not be read. */
	imageUnreadableKey: string;
	/** Choose image: this build has no image picker. */
	imageUnavailableKey: string;
}

export const SCAN_KINDS: Readonly<Record<ScanKind, ScanKindConfig>> = {
	'join-code': {
		testIDPrefix: 'join-network',
		logTag: '[join]',
		titleKey: 'joinScanTitle',
		instructionKey: 'joinScanInstruction',
		slowKey: 'joinScanSlow',
		pasteKey: 'joinScanPasteInstead',
		accepts: looksLikeJoinCode,
		isOtherKind: isInvitationQrText,
		otherKindKey: 'joinScanIsInvitation',
		otherKindToken: 'rejected-invitation',
		notKindKey: 'joinScanNotJoinCode',
		notKindToken: 'rejected-not-join-code',
		imageCancelledKey: 'scanImageCancelled',
		imageNoCodeKey: 'joinScanImageNoCode',
		imageUnreadableKey: 'joinScanImageUnreadable',
		imageUnavailableKey: 'joinScanImageUnavailable',
	},
	invitation: {
		testIDPrefix: 'accept-invitation',
		logTag: '[invite]',
		titleKey: 'inviteScanTitle',
		instructionKey: 'inviteScanInstruction',
		slowKey: 'inviteScanSlow',
		pasteKey: 'inviteScanPasteInstead',
		accepts: isInvitationQrText,
		isOtherKind: looksLikeJoinCode,
		otherKindKey: 'inviteScanIsJoinCode',
		otherKindToken: 'rejected-join-code',
		notKindKey: 'inviteScanNotInvitation',
		notKindToken: 'rejected-not-invitation',
		imageCancelledKey: 'scanImageCancelled',
		imageNoCodeKey: 'inviteImageNoCode',
		imageUnreadableKey: 'inviteImageUnreadable',
		imageUnavailableKey: 'inviteImageUnavailable',
	},
};

export interface JoinCodeScannerProps {
	visible: boolean;
	/** What to accept; defaults to a join code. */
	kind?: ScanKind;
	onAccept(text: string): void;
	onClose(): void;
	onPasteInstead(): void;
	/** Availability and failure reports for the Join screen's notices. */
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

/** 'denied' | 'restricted' -> 'blocked'; 'authorized' with no device -> 'none'; anything else -> 'ready'. */
export function joinScanAvailability(status: string, hasDevice: boolean): 'ready' | 'blocked' | 'none' {
	if (status === 'denied' || status === 'restricted') return 'blocked';
	if (status === 'authorized' && !hasDevice) return 'none';
	return 'ready';
}

/** What a read holds for one kind: the camera's frames and a picked image are judged by this one rule. */
export type ScanReadVerdict = {type: 'accepted'; value: string} | {type: 'other-kind'} | {type: 'not-kind'};

function judgeWith(config: ScanKindConfig, values: readonly unknown[]): ScanReadVerdict {
	let otherKind = false;
	for (const value of values) {
		if (typeof value !== 'string') continue;
		if (config.accepts(value)) return {type: 'accepted', value};
		if (config.isOtherKind(value)) otherKind = true;
	}
	return otherKind ? {type: 'other-kind'} : {type: 'not-kind'};
}

/** The first value of `kind` among the read values, or which refusal they get. */
export function judgeScannedValues(values: readonly unknown[], kind: ScanKind = 'join-code'): ScanReadVerdict {
	return judgeWith(SCAN_KINDS[kind], values);
}

/** A picked image, judged: the value to accept, or the sentence (an i18n key) and its closed log token. */
export type ScanImageOutcome = {type: 'accepted'; value: string} | {type: 'message'; key: string; token: string};

/** Map a picker read to what the scanner and the screens do with it. */
export function scanImageOutcome(result: QrImageReadResult, kind: ScanKind = 'join-code'): ScanImageOutcome {
	const config = SCAN_KINDS[kind];
	switch (result.kind) {
		case 'decoded': {
			const verdict = judgeWith(config, result.values);
			if (verdict.type === 'accepted') return verdict;
			return verdict.type === 'other-kind'
				? {type: 'message', key: config.otherKindKey, token: config.otherKindToken}
				: {type: 'message', key: config.notKindKey, token: config.notKindToken};
		}
		case 'no-code':
			return {type: 'message', key: config.imageNoCodeKey, token: 'no-code'};
		case 'unreadable':
			return {type: 'message', key: config.imageUnreadableKey, token: 'unreadable'};
		case 'unavailable':
			return {type: 'message', key: config.imageUnavailableKey, token: 'unavailable'};
		case 'cancelled':
		default:
			return {type: 'message', key: config.imageCancelledKey, token: 'cancelled'};
	}
}

export interface ScanImagePicker {
	/** False on a build without the image picker: the button is shown disabled with a sentence. */
	available: boolean;
	/** True while the photo picker is open or its image is being read. */
	picking: boolean;
	/**
	 * Open the picker and judge the image. Resolves null when a pick is already open or the caller
	 * unmounted. Never rejects.
	 */
	pick(): Promise<ScanImageOutcome | null>;
}

/** The Choose image pick for one kind, shared by the scanner and the screens' camera-off notices. */
export function useScanImage(kind: ScanKind = 'join-code'): ScanImagePicker {
	const available = useMemo(() => isQrImageDecodeAvailable(), []);
	const [picking, setPicking] = useState(false);
	const pickingRef = useRef(false);
	const mountedRef = useRef(true);
	const kindRef = useRef(kind);
	kindRef.current = kind;
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const pick = useCallback(async (): Promise<ScanImageOutcome | null> => {
		if (pickingRef.current) return null;
		const config = SCAN_KINDS[kindRef.current];
		if (!available) {
			console.info(`${config.logTag} image: unavailable`);
			return scanImageOutcome({kind: 'unavailable'}, kindRef.current);
		}
		pickingRef.current = true;
		setPicking(true);
		try {
			let result: QrImageReadResult;
			try {
				result = await pickImageAndReadQrCodes({logTag: config.logTag});
			} catch {
				// pickImageAndReadQrCodes never rejects; a stand-in that does is an unreadable image.
				result = {kind: 'unreadable'};
			}
			if (!mountedRef.current) return null;
			const outcome = scanImageOutcome(result, kindRef.current);
			console.info(`${config.logTag} image: ${outcome.type === 'accepted' ? 'accepted' : outcome.token}`);
			return outcome;
		} finally {
			pickingRef.current = false;
			if (mountedRef.current) setPicking(false);
		}
	}, [available]);
	return {available, picking, pick};
}

// Fixed colours: they sit on live camera video, so they are not theme tokens.
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

/** A fresh Camera plus a fresh output per `resolution` (the parent keys it by resolution). */
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
	const {fonts} = useTheme() as ExtendedTheme;
	const {t} = useTranslation();
	const config = SCAN_KINDS[props.kind ?? 'join-code'];
	const prefix = config.testIDPrefix;
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
	const configRef = useRef(config);
	configRef.current = config;
	statusRef.current = status;
	deviceRef.current = device;
	requestPermissionRef.current = requestPermission;
	visibleRef.current = props.visible;
	onAcceptRef.current = props.onAccept;
	onCameraStateRef.current = props.onCameraState;

	const image = useScanImage(props.kind ?? 'join-code');
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

	// Availability, reported while the scanner is hidden too: this component owns the camera hooks.
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
				console.info(`${configRef.current.logTag} scan: no-camera`);
				report('none');
				setPhase('closed');
			} else {
				setPhase('starting');
			}
		};

		const known = statusRef.current;
		if (known === 'denied' || known === 'restricted') {
			console.info(`${configRef.current.logTag} scan: permission-blocked`);
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
					console.info(`${configRef.current.logTag} scan: permission-request-failed`);
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
			console.info(`${configRef.current.logTag} scan: permission-blocked`);
			report('blocked');
		} else {
			console.info(`${configRef.current.logTag} scan: permission-denied`);
			report('denied');
		}
		setPhase('closed');
	}, [phase, status, report]);

	// Stable (empty deps), refs only: the library memoises the output on formats and resolution.
	const onBarcodes = useCallback((barcodes: Barcode[]) => {
		if (lockRef.current) return;
		if (pausedRef.current) return;
		const kind = configRef.current;
		const verdict = judgeWith(kind, barcodes.map(barcode => barcode.rawValue));
		const accepted = verdict.type === 'accepted' ? verdict.value : undefined;
		const otherKind = verdict.type === 'other-kind';
		if (accepted !== undefined) {
			lockRef.current = true;
			if (bannerTimerRef.current !== undefined) clearTimeout(bannerTimerRef.current);
			setBannerKey(null);
			setPhase('accepted');
			console.info(`${configRef.current.logTag} scan: accepted`);
			onAcceptRef.current(accepted);
			return;
		}
		if (ignoreRejectRef.current) return;
		ignoreRejectRef.current = true;
		console.info(`${kind.logTag} scan: ${otherKind ? kind.otherKindToken : kind.notKindToken}`);
		setBannerKey(otherKind ? kind.otherKindKey : kind.notKindKey);
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
			console.info(`${configRef.current.logTag} scan: accepted`);
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
		console.info(`${configRef.current.logTag} scan: camera-failed`);
		report('failed');
		setPhase('closed');
	}, [report]);

	const onScannerError = useCallback(() => {
		console.info(`${configRef.current.logTag} scan: scanner-failed`);
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
	// Optional chaining: a theme without fonts (some screen tests mock only colors) keeps the defaults.
	const boldText = {fontFamily: fonts?.bold?.fontFamily, fontWeight: fonts?.bold?.fontWeight};
	const regularText = {fontFamily: fonts?.regular?.fontFamily, fontWeight: fonts?.regular?.fontWeight};

	return (
		<Modal
			visible={props.visible}
			presentationStyle="fullScreen"
			statusBarTranslucent
			supportedOrientations={['portrait']}
			animationType="slide"
			onRequestClose={props.onClose}>
			<View testID={`${prefix}-scanner`} style={styles.root}>
				{showCamera && device !== undefined ? (
					<View testID={`${prefix}-scan-preview`} style={StyleSheet.absoluteFill}>
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

				<View testID={`${prefix}-scan-viewfinder`} pointerEvents="none" style={{position: 'absolute', top, left, width: side, height: side}}>
					<View style={[styles.corner, styles.cornerTL]} />
					<View style={[styles.corner, styles.cornerTR]} />
					<View style={[styles.corner, styles.cornerBL]} />
					<View style={[styles.corner, styles.cornerBR]} />
				</View>

				<View style={[styles.titleRow, {top: insets.top + 8}]} pointerEvents="none">
					<Text testID={`${prefix}-scan-title`} style={[styles.title, boldText]}>
						{t(config.titleKey)}
					</Text>
				</View>
				<Pressable
					testID={`${prefix}-scan-close`}
					accessibilityRole="button"
					accessibilityLabel={t('joinScanClose')}
					onPress={props.onClose}
					style={[styles.closeButton, {top: insets.top + 8}]}>
					<FontAwesome6 name="xmark" size={24} color={INK} />
				</Pressable>

				<View style={{position: 'absolute', top: top + side + 24, left: textLeft, width: textWidth, alignItems: 'center'}}>
					{waiting ? (
						<View testID={`${prefix}-scan-starting`} style={styles.startingRow}>
							<ActivityIndicator color={INK} />
							<Text style={[styles.body, regularText, styles.startingText]}>{t('joinScanStarting')}</Text>
						</View>
					) : (
						<Text testID={`${prefix}-scan-instruction`} style={[styles.body, regularText]}>
							{slow ? t(config.slowKey) : t(config.instructionKey)}
						</Text>
					)}
				</View>

				<View style={[styles.bottomBar, {bottom: pasteBottom}]} pointerEvents="box-none">
					{bannerKey !== null ? (
						<View testID={`${prefix}-scan-banner`} accessibilityRole="alert" style={styles.banner}>
							<FontAwesome6 name="circle-exclamation" size={16} color={INK} />
							<Text style={[styles.body, regularText, styles.bannerText]}>{t(bannerKey)}</Text>
						</View>
					) : null}

					{!image.available ? (
						<Text testID={`${prefix}-scan-image-unavailable`} style={[styles.caption, regularText]}>
							{t(config.imageUnavailableKey)}
						</Text>
					) : null}
					<Pressable
						testID={`${prefix}-scan-image`}
						accessibilityRole="button"
						accessibilityLabel={t('scanImageLabel')}
						accessibilityState={{disabled: imageDisabled, busy: image.picking}}
						disabled={imageDisabled}
						onPress={onChooseImage}
						style={[styles.imageButton, !image.available ? styles.imageButtonDisabled : null]}>
						{image.picking ? (
							<ActivityIndicator testID={`${prefix}-scan-image-busy`} color={INK} />
						) : (
							<FontAwesome6 name="image" size={18} color={INK} />
						)}
						<Text style={[styles.imageLabel, boldText]}>{t('scanImageButton')}</Text>
					</Pressable>

					<Pressable
						testID={`${prefix}-scan-paste`}
						accessibilityRole="button"
						onPress={props.onPasteInstead}
						style={styles.pasteButton}>
						<Text style={[styles.pasteLabel, boldText]}>{t(config.pasteKey)}</Text>
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
