/**
 * ContinueOnAnotherDeviceScreen (62-UI-SPEC Surfaces 8 and 9, D-40/D-43/D-45). The new device's
 * continuity entry point: code / identity-fallback evidence submission, a non-dismissible pending
 * wait (resuming from replicated rows, never persisted state), and the restart branch for a voter
 * who knows their prior registration is still pending (D-43).
 *
 * D-40: this device generates and keeps its own P-256 key — never exports, backs up or reads a
 * private key anywhere in this file. Every signature is produced through
 * `resolveAttestationProducer().signDeviceKeyDigest`, closed over by `continuity.ts`'s ceremony
 * helpers.
 *
 * D-45: the real registrant is resolved by the authority from the sealed code or identity fields
 * — this screen never names a registrant (`buildReassociationRequestInit` always sets the
 * sentinel). D-43: a new device cannot learn that a registration is pending (codes exist only
 * after approval, identity matching is officer-side after decrypt), so the restart branch is
 * entered by the voter's OWN choice (the GAP `newDevice.restartLink`) — it submits nothing, it
 * only routes into the ordinary first-time registration flow.
 *
 * Pending is non-dismissible (`beforeRemove` prevented) and resumes from the replicated
 * `AssociationRequest` row on every mount — never from persisted state, so an app kill loses
 * nothing resumable. Polling is bounded (`REASSOCIATION_MAX_POLL_ROUNDS`, timer-free) and re-runs
 * on screen focus and on return to the foreground.
 *
 * The election the requests name comes from `resolveCurrentElectionId` (64 D-28), once per mount,
 * and is omitted when nothing resolves (OQ10).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {LayoutChangeEvent, ScrollViewInstance} from 'react-native';
import {useFocusEffect, useNavigation, useTheme} from '@react-navigation/native';
import type {ExtendedTheme} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {INetworkEngine} from '@votetorrent/vote-core';
import {normalizeRegistrationCode} from '@votetorrent/vote-core';
import {useVoterApp} from '../../providers/VoterAppProvider';
import {useKeyboardInset} from '../../hooks/useKeyboardInset';
import {resolveAttestationProducer} from '../../engines/attestation-producer';
import {resolveCurrentElectionId} from '../../engines/election-read';
import {classifyAttestationFailure, isDeviceKeyAbsent, type AttestationFailureClass} from '../../engines/attestation-failure';
import {resolveVoterRequestTransports} from './attach-voter-request-transport';
import {
	advanceReassociation,
	buildIdentityFallbackFields,
	buildReassociationRequestInit,
	resolveReassociationResume,
	submitReassociationRequest,
} from '../../engines/continuity';
import type {IdentityFallbackInput, ReassociationCeremonyDeps, ReassociationEvidenceInput} from '../../engines/continuity';
import type {AssociationRequestInit} from '@votetorrent/vote-core';
import {globalStyles} from '../../theme/styles';
import {errorClassName} from '../../utils/errorClassName';
import {IdentityRecoveryView} from '../../components/IdentityRecoveryView';
import type {RegistrationStackParamList} from '../../navigation/types';

type ContinueNavigationProp = NativeStackNavigationProp<RegistrationStackParamList, 'ContinueOnAnotherDevice'>;

type Branch = 'resolving' | 'code' | 'identity' | 'restart' | 'pending' | 'approved' | 'rejected';

type IdentityErrors = Partial<Record<'firstName' | 'lastName', 'required'>>;

const EMPTY_IDENTITY: IdentityFallbackInput = {
	firstName: '',
	lastName: '',
	dob: '',
	email: '',
	phone: '',
	addressLine1: '',
	addressLine2: '',
	addressLine3: '',
};

/** Pure — the ScrollView offset that brings a field's full frame inside the (keyboard-shrunken)
 * viewport, with `margin` of breathing room past the field's bottom edge. Never negative. */
export function revealOffsetFor({
	fieldY,
	fieldHeight,
	viewportHeight,
	margin,
}: {
	fieldY: number;
	fieldHeight: number;
	viewportHeight: number;
	margin: number;
}): number {
	return Math.max(0, fieldY + fieldHeight + margin - viewportHeight);
}

const REVEAL_MARGIN = 16;

export default function ContinueOnAnotherDeviceScreen() {
	// WR-02: `createNewIdentity` is reached ONLY from the recovery view's confirm step below.
	const {getEngine, seededElectionId, createNewIdentity} = useVoterApp();
	const navigation = useNavigation<ContinueNavigationProp>();
	const {colors, fonts, type: typeScale, radii} = useTheme() as ExtendedTheme;
	const {t} = useTranslation('continuity');
	const {t: tRegistration} = useTranslation('registration');
	const {t: tCommon} = useTranslation('common');
	const insets = useSafeAreaInsets();
	const keyboardInset = useKeyboardInset();

	const [branch, setBranch] = useState<Branch>('resolving');
	const [codeValue, setCodeValue] = useState('');
	const [codeError, setCodeError] = useState<string | null>(null);
	const [identity, setIdentity] = useState<IdentityFallbackInput>(EMPTY_IDENTITY);
	const [identityErrors, setIdentityErrors] = useState<IdentityErrors>({});
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [failureClass, setFailureClass] = useState<AttestationFailureClass | null>(null);

	const branchRef = useRef<Branch>('resolving');
	branchRef.current = branch;

	const deviceKeyRef = useRef<string | null>(null);
	const authorityIdRef = useRef<string | null>(null);
	const requestIdRef = useRef<string | null>(null);
	const requestInitRef = useRef<AssociationRequestInit | null>(null);
	const evidenceKeyRef = useRef<string | null>(null);
	// 64 D-28: the election id is resolved once per mount (a holder tells "not resolved yet" from
	// "resolved to undefined"); a rejected read is never memoised, so a retry re-reads.
	const electionIdRef = useRef<{value: string | undefined} | null>(null);
	const answeredRef = useRef(false);
	const advanceInFlightRef = useRef(false);
	// Set just before an intentional exit (Check Back Later / Back to Registration) so the pending
	// `beforeRemove` guard lets that one navigation through instead of swallowing it.
	const allowLeaveRef = useRef(false);

	const scrollRef = useRef<ScrollViewInstance>(null);
	const viewportHeightRef = useRef(0);
	const fieldFramesRef = useRef<Record<string, {y: number; height: number}>>({});
	const focusedFieldKeyRef = useRef<string | null>(null);

	function recordViewportLayout(e: LayoutChangeEvent) {
		viewportHeightRef.current = e.nativeEvent.layout.height;
	}

	function recordFieldLayout(key: string) {
		return (e: LayoutChangeEvent) => {
			fieldFramesRef.current[key] = {y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height};
		};
	}

	function revealField(key: string) {
		focusedFieldKeyRef.current = key;
		const frame = fieldFramesRef.current[key];
		if (!frame) return;
		const y = revealOffsetFor({
			fieldY: frame.y,
			fieldHeight: frame.height,
			viewportHeight: viewportHeightRef.current,
			margin: REVEAL_MARGIN,
		});
		scrollRef.current?.scrollTo({y, animated: true});
	}

	function onFieldFocus(key: string) {
		return () => revealField(key);
	}

	// The viewport shrinks only after the IME appears — re-reveal the last-focused field once the
	// keyboard inset (and so the re-measured viewport height) actually changes.
	useEffect(() => {
		if (focusedFieldKeyRef.current) {
			revealField(focusedFieldKeyRef.current);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [keyboardInset]);

	// --- Bootstrap: provision the P-256 key, the authority id, and resume from replicated rows ---
	useEffect(() => {
		let cancelled = false;
		async function bootstrap() {
			try {
				const producer = resolveAttestationProducer();
				// READ the current key first and create one only when none exists. provisionDeviceKey on
				// every mount minted a NEW Android key each time (attestation-producer.ts:80), so after
				// leaving and re-opening the screen the resume read looked for requests under a key that
				// never submitted one and the pending request was lost (initial/G5 WR-02 way-out fix).
				let publicKey: string;
				try {
					({publicKey} = await producer.getCurrentDeviceKey());
				} catch (keyErr) {
					if (!isDeviceKeyAbsent(keyErr)) throw keyErr;
					({publicKey} = await producer.provisionDeviceKey());
				}
				if (cancelled) return;
				deviceKeyRef.current = publicKey;

				const networkEngine = await getEngine<INetworkEngine>('network');
				const details = await networkEngine.getDetails();
				if (cancelled) return;
				authorityIdRef.current = details.network.primaryAuthorityId;

				const resume = await resolveReassociationResume({
					getEngine,
					getCurrentDeviceKey: () => producer.getCurrentDeviceKey(),
				});
				if (cancelled) return;
				if (resume.kind === 'pending') {
					requestIdRef.current = resume.requestId;
					setBranch('pending');
				} else if (resume.kind === 'approved') {
					setBranch('approved');
				} else {
					setBranch('code');
				}
			} catch (err) {
				console.error('ContinueOnAnotherDeviceScreen: bootstrap failed:', errorClassName(err));
				if (!cancelled) setBranch('code');
			}
		}
		bootstrap();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// --- Pending: guarded against an accidental back gesture while a request is in flight and no
	// failure is showing. On a failure the voter can always leave (initial/G5 WR-02). ---
	useEffect(() => {
		if (branch !== 'pending' || failureClass !== null) return;
		const unsubscribe = navigation.addListener('beforeRemove', e => {
			if (allowLeaveRef.current) return;
			e.preventDefault();
		});
		return unsubscribe;
	}, [branch, failureClass, navigation]);

	async function resolveAttemptElectionId(): Promise<string | undefined> {
		if (electionIdRef.current !== null) return electionIdRef.current.value;
		const value = await resolveCurrentElectionId({getEngine, fallbackElectionId: __DEV__ ? seededElectionId : undefined});
		electionIdRef.current = {value};
		return value;
	}

	async function runAdvance() {
		if (advanceInFlightRef.current) return;
		if (branchRef.current !== 'pending') return;
		const requestId = requestIdRef.current;
		if (!requestId) return;
		advanceInFlightRef.current = true;
		try {
			const authorityId = authorityIdRef.current;
			const deviceKey = deviceKeyRef.current;
			if (!authorityId || !deviceKey) return;
			const electionId = await resolveAttemptElectionId();
			const transports = await resolveVoterRequestTransports({getEngine, authorityId});
			if (!transports) {
				setSubmitError(t('newDevice.submitError'));
				return;
			}
			const producer = resolveAttestationProducer();
			const deps: ReassociationCeremonyDeps = {
				transports,
				producer,
				authorityId,
				electionId,
				deviceKey,
			};
			setFailureClass(null);
			const progress = await advanceReassociation(deps, requestId, answeredRef.current);
			if (progress.kind === 'approved') {
				setBranch('approved');
			} else if (progress.kind === 'rejected') {
				setBranch('rejected');
			} else {
				answeredRef.current = progress.answered;
			}
		} catch (err) {
			console.error('ContinueOnAnotherDeviceScreen: advance failed:', errorClassName(err));
			setFailureClass(classifyAttestationFailure(err));
		} finally {
			advanceInFlightRef.current = false;
		}
	}

	useFocusEffect(
		useCallback(() => {
			if (branch === 'pending') {
				runAdvance();
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [branch]),
	);

	useEffect(() => {
		const sub = AppState.addEventListener('change', state => {
			if (state === 'active' && branchRef.current === 'pending') {
				runAdvance();
			}
		});
		return () => sub.remove();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function submitEvidence(evidence: ReassociationEvidenceInput, fingerprint: string) {
		setSubmitError(null);
		try {
			const producer = resolveAttestationProducer();
			let deviceKey = deviceKeyRef.current;
			if (!deviceKey) {
				deviceKey = (await producer.provisionDeviceKey()).publicKey;
				deviceKeyRef.current = deviceKey;
			}
			let authorityId = authorityIdRef.current;
			if (!authorityId) {
				const networkEngine = await getEngine<INetworkEngine>('network');
				const details = await networkEngine.getDetails();
				authorityId = details.network.primaryAuthorityId;
				authorityIdRef.current = authorityId;
			}

			const electionId = await resolveAttemptElectionId();
			const transports = await resolveVoterRequestTransports({getEngine, authorityId});
			if (!transports) {
				setSubmitError(t('newDevice.submitError'));
				return;
			}

			let init = requestInitRef.current;
			if (init === null || evidenceKeyRef.current !== fingerprint) {
				init = buildReassociationRequestInit({
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					id: (globalThis as any).crypto.randomUUID() as string,
					authorityId,
					deviceKey,
					electionId,
					submittedAt: new Date().toISOString(),
				});
				requestInitRef.current = init;
				evidenceKeyRef.current = fingerprint;
			}

			const deps: ReassociationCeremonyDeps = {
				transports,
				producer,
				authorityId,
				electionId,
				deviceKey,
			};
			const requestId = await submitReassociationRequest(deps, init, evidence);
			requestIdRef.current = requestId;
			answeredRef.current = false;
			setFailureClass(null);
			setBranch('pending');
		} catch (err) {
			console.error('ContinueOnAnotherDeviceScreen: submit failed:', errorClassName(err));
			// WR-02: a permanently lost identity gets the recovery view, not a resubmit that can
			// never succeed. Every other submit failure keeps the generic submit error.
			if (classifyAttestationFailure(err) === 'identity-lost') {
				setFailureClass('identity-lost');
				return;
			}
			setSubmitError(t('newDevice.submitError'));
		}
	}

	function onSubmitCode() {
		const normalized = normalizeRegistrationCode(codeValue);
		if (!normalized) {
			setCodeError(t('newDevice.codeRequired'));
			return;
		}
		setCodeError(null);
		submitEvidence({kind: 'code', code: codeValue}, normalized);
	}

	function onSubmitIdentity() {
		const errs: IdentityErrors = {};
		if (identity.firstName.trim() === '') errs.firstName = 'required';
		if (identity.lastName.trim() === '') errs.lastName = 'required';
		if (Object.keys(errs).length > 0) {
			setIdentityErrors(errs);
			return;
		}
		setIdentityErrors({});
		const fields = buildIdentityFallbackFields(identity);
		const fingerprint = JSON.stringify(fields);
		submitEvidence({kind: 'identity', fields}, fingerprint);
	}

	function updateIdentityField(field: keyof IdentityFallbackInput) {
		return (value: string) => {
			setIdentity(prev => ({...prev, [field]: value}));
			if (field === 'firstName' || field === 'lastName') {
				setIdentityErrors(prev => (prev[field] ? {...prev, [field]: undefined} : prev));
			}
		};
	}

	async function handleSetupDeviceUnlock() {
		try {
			await Linking.sendIntent('android.settings.BIOMETRIC_ENROLL');
		} catch (err) {
			console.error('ContinueOnAnotherDeviceScreen: BIOMETRIC_ENROLL intent failed, falling back:', errorClassName(err));
			try {
				await Linking.sendIntent('android.settings.SECURITY_SETTINGS');
			} catch (fallbackErr) {
				console.error('ContinueOnAnotherDeviceScreen: SECURITY_SETTINGS fallback intent also failed:', errorClassName(fallbackErr));
			}
		}
	}

	function retryAdvance() {
		setFailureClass(null);
		runAdvance();
	}

	const showClose = (branch !== 'pending' && branch !== 'resolving') || failureClass !== null;

	// Non-destructive exit to the Registration root: the pending request lives in replicated rows and
	// is found again on the next visit (read-only key lookup in bootstrap).
	const backToRegistrationButton = (testID: string, label: string) => (
		<Pressable
			testID={testID}
			onPress={() => {
				allowLeaveRef.current = true;
				navigation.popToTop();
			}}
			style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
			<Text style={[styles.ctaLabel, {color: colors.primary}]}>{label}</Text>
		</Pressable>
	);

	if (branch === 'resolving') {
		return (
			<View style={[styles.screen, {backgroundColor: colors.background}, globalStyles.container]}>
				<ActivityIndicator testID="continue-device-resolving" color={colors.primary} />
			</View>
		);
	}

	// WR-02: same recovery as the boot and the registration Confirm screen. createNewIdentity
	// re-runs the boot (re-mounting the app tree), so no navigation is needed; the view's Try Again
	// (shown only after a failed create) clears the failure and re-runs the pending advance.
	if (failureClass === 'identity-lost') {
		return (
			<View testID="continue-device-identity-lost" style={[styles.screen, {backgroundColor: colors.background}]}>
				<IdentityRecoveryView onCreateNewIdentity={createNewIdentity} onRetry={retryAdvance} />
				{backToRegistrationButton('continue-device-back-to-registration', t('newDevice.backToRegistrationButton'))}
			</View>
		);
	}

	const errorCopy =
		failureClass === 'recoverable-action'
			? Platform.OS === 'ios'
				? tRegistration('confirmation.error.biometricNotEnrolled')
				: tRegistration('confirmation.error.biometricNotEnrolled.android')
			: failureClass === 'terminal'
				? tRegistration('confirmation.error.terminal')
				: failureClass === 'recoverable-transient'
					? tRegistration('confirmation.error.transient')
					: failureClass === 'intake-unavailable'
						? tRegistration('confirmation.error.intakeUnavailable')
						: null;

	return (
		<View
			style={[
				styles.screen,
				{
					backgroundColor: colors.background,
					paddingTop: insets.top,
					paddingBottom: insets.bottom + keyboardInset,
				},
			]}>
			<ScrollView
				ref={scrollRef}
				testID="continue-device-scroll"
				onLayout={recordViewportLayout}
				keyboardShouldPersistTaps="handled"
				style={styles.scroll}
				contentContainerStyle={globalStyles.container}>
				<View style={styles.topBar}>
					{showClose ? (
						<Pressable
							testID="continue-device-close"
							onPress={() => navigation.goBack()}
							hitSlop={8}
							style={styles.closeButton}
							accessibilityLabel={tCommon('close')}>
							<FontAwesome6 name="xmark" size={22} color={colors.text} />
						</Pressable>
					) : null}
				</View>

				<Text
					style={[
						styles.title,
						{
							color: colors.text,
							fontFamily: fonts.medium.fontFamily,
							fontWeight: fonts.medium.fontWeight,
							fontSize: typeScale.h2.fontSize,
							lineHeight: typeScale.h2.lineHeight,
						},
					]}>
					{t('newDevice.screenTitle')}
				</Text>

				{branch === 'code' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text style={[styles.fieldLabel, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
							{t('newDevice.codeFieldLabel')}
						</Text>
						<View testID="continue-device-code-field" onLayout={recordFieldLayout('code')}>
							<TextInput
								testID="continue-device-code-input"
								value={codeValue}
								onChangeText={v => {
									setCodeValue(v);
									if (codeError) setCodeError(null);
								}}
								onFocus={onFieldFocus('code')}
								placeholder={t('newDevice.codeFieldPlaceholder')}
								placeholderTextColor={codeError ? colors.error : colors.textSecondary}
								autoCapitalize="characters"
								autoCorrect={false}
								style={[
									styles.input,
									{
										color: colors.text,
										borderColor: codeError ? colors.error : colors.primary,
										fontFamily: fonts.regular.fontFamily,
										fontWeight: fonts.regular.fontWeight,
										fontSize: typeScale.body.fontSize,
									},
								]}
							/>
						</View>
						{codeError ? (
							<Text style={[styles.fieldError, {color: colors.error, fontSize: typeScale.caption.fontSize}]}>
								{codeError}
							</Text>
						) : null}

						{submitError ? (
							<Text
								testID="continue-device-submit-error"
								style={[styles.fieldError, {color: colors.error, fontSize: typeScale.body.fontSize}]}>
								{submitError}
							</Text>
						) : null}

						<Pressable
							testID="continue-device-code-submit"
							onPress={onSubmitCode}
							style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
								{t('newDevice.submitButton')}
							</Text>
						</Pressable>

						<Pressable
							testID="continue-device-lost-code-link"
							onPress={() => setBranch('identity')}
							style={styles.linkRow}>
							<Text style={[styles.linkLabel, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('newDevice.lostCodeLink')}
							</Text>
						</Pressable>

						<Pressable
							testID="continue-device-restart-link"
							onPress={() => setBranch('restart')}
							style={styles.linkRow}>
							<Text style={[styles.linkLabel, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('newDevice.restartLink')}
							</Text>
						</Pressable>
					</View>
				) : null}

				{branch === 'identity' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text
							style={[
								styles.sectionHeading,
								{color: colors.text, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight},
							]}>
							{t('newDevice.identityFallbackHeading')}
						</Text>
						<Text style={[styles.sectionBody, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
							{t('newDevice.identityFallbackBody')}
						</Text>

						<IdentityField
							testID="continue-device-identity-firstName"
							placeholder={tRegistration('form.firstName')}
							value={identity.firstName}
							onChangeText={updateIdentityField('firstName')}
							onFocus={onFieldFocus('identity-firstName')}
							onLayoutFrame={recordFieldLayout('identity-firstName')}
							error={identityErrors.firstName ? tRegistration('form.errors.required') : undefined}
						/>
						<IdentityField
							testID="continue-device-identity-lastName"
							placeholder={tRegistration('form.lastName')}
							value={identity.lastName}
							onChangeText={updateIdentityField('lastName')}
							onFocus={onFieldFocus('identity-lastName')}
							onLayoutFrame={recordFieldLayout('identity-lastName')}
							error={identityErrors.lastName ? tRegistration('form.errors.required') : undefined}
						/>
						<IdentityField
							testID="continue-device-identity-dob"
							placeholder={tRegistration('form.dobPlaceholder')}
							value={identity.dob}
							onChangeText={updateIdentityField('dob')}
							onFocus={onFieldFocus('identity-dob')}
							onLayoutFrame={recordFieldLayout('identity-dob')}
						/>
						<IdentityField
							testID="continue-device-identity-email"
							placeholder={tRegistration('form.email')}
							value={identity.email}
							onChangeText={updateIdentityField('email')}
							onFocus={onFieldFocus('identity-email')}
							onLayoutFrame={recordFieldLayout('identity-email')}
						/>
						<IdentityField
							testID="continue-device-identity-phone"
							placeholder={tRegistration('form.phone')}
							value={identity.phone}
							onChangeText={updateIdentityField('phone')}
							onFocus={onFieldFocus('identity-phone')}
							onLayoutFrame={recordFieldLayout('identity-phone')}
						/>
						<IdentityField
							testID="continue-device-identity-addressLine1"
							placeholder={tRegistration('form.addressLine1')}
							value={identity.addressLine1}
							onChangeText={updateIdentityField('addressLine1')}
							onFocus={onFieldFocus('identity-addressLine1')}
							onLayoutFrame={recordFieldLayout('identity-addressLine1')}
						/>
						<IdentityField
							testID="continue-device-identity-addressLine2"
							placeholder={tRegistration('form.addressLine2')}
							value={identity.addressLine2}
							onChangeText={updateIdentityField('addressLine2')}
							onFocus={onFieldFocus('identity-addressLine2')}
							onLayoutFrame={recordFieldLayout('identity-addressLine2')}
						/>
						<IdentityField
							testID="continue-device-identity-addressLine3"
							placeholder={tRegistration('form.addressLine3')}
							value={identity.addressLine3}
							onChangeText={updateIdentityField('addressLine3')}
							onFocus={onFieldFocus('identity-addressLine3')}
							onLayoutFrame={recordFieldLayout('identity-addressLine3')}
						/>

						{submitError ? (
							<Text
								testID="continue-device-submit-error"
								style={[styles.fieldError, {color: colors.error, fontSize: typeScale.body.fontSize}]}>
								{submitError}
							</Text>
						) : null}

						<Pressable
							testID="continue-device-identity-submit"
							onPress={onSubmitIdentity}
							style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
								{t('newDevice.identityFallbackSubmitButton')}
							</Text>
						</Pressable>

						<Pressable
							testID="continue-device-back-to-code-link"
							onPress={() => setBranch('code')}
							style={styles.linkRow}>
							<Text style={[styles.linkLabel, {color: colors.link, fontSize: typeScale.body.fontSize}]}>
								{t('newDevice.backToCodeLink')}
							</Text>
						</Pressable>
					</View>
				) : null}

				{branch === 'restart' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text
							style={[
								styles.sectionHeading,
								{color: colors.text, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight},
							]}>
							{t('restart.heading')}
						</Text>
						<Text style={[styles.sectionBody, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
							{t('restart.body')}
						</Text>
						<Pressable
							testID="continue-device-restart-confirm"
							onPress={() => navigation.navigate('DeviceAttestation')}
							style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
								{t('restart.confirmButton')}
							</Text>
						</Pressable>
					</View>
				) : null}

				{branch === 'pending' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						{errorCopy ? (
							<>
								<Text
									testID="continue-device-pending-error"
									style={[styles.sectionBody, {color: colors.text, fontSize: typeScale.body.fontSize}]}>
									{errorCopy}
								</Text>
								{failureClass === 'terminal' ? null : failureClass === 'recoverable-action' ? (
									<Pressable
										testID="continue-device-setup-cta"
										onPress={handleSetupDeviceUnlock}
										style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
										<Text style={[styles.ctaLabel, {color: colors.light}]}>
											{tRegistration('confirmation.error.setupCta')}
										</Text>
									</Pressable>
								) : null}
								{failureClass === 'terminal' ? null : (
									<Pressable
										testID="continue-device-retry"
										onPress={retryAdvance}
										style={[styles.retryCta, {borderColor: colors.primary, borderRadius: radii.pill}]}>
										<Text style={[styles.ctaLabel, {color: colors.primary}]}>{t('newDevice.retryButton')}</Text>
									</Pressable>
								)}
								{failureClass === 'terminal'
									? backToRegistrationButton('continue-device-back-to-registration', t('newDevice.backToRegistrationButton'))
									: null}
							</>
						) : (
							<>
								<Text
									testID="continue-device-pending-heading"
									style={[
										styles.sectionHeading,
										{color: colors.text, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight},
									]}>
									{t('newDevice.pendingHeading')}
								</Text>
								<Text style={[styles.sectionBody, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
									{t('newDevice.pendingBody')}
								</Text>
								<Text style={[styles.sectionBody, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
									{t('newDevice.checkBackLaterBody')}
								</Text>
								{backToRegistrationButton('continue-device-check-back-later', t('newDevice.checkBackLaterButton'))}
							</>
						)}
					</View>
				) : null}

				{branch === 'approved' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text
							style={[
								styles.sectionHeading,
								{color: colors.text, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight},
							]}>
							{t('newDevice.approvedHeading')}
						</Text>
						<Pressable
							testID="continue-device-approved-continue"
							onPress={() => navigation.popToTop()}
							style={[styles.cta, {backgroundColor: colors.primary, borderRadius: radii.pill}]}>
							<Text style={[styles.ctaLabel, {color: colors.light, fontFamily: fonts.bold.fontFamily, fontWeight: fonts.bold.fontWeight}]}>
								{tRegistration('form.continueCta')}
							</Text>
						</Pressable>
					</View>
				) : null}

				{branch === 'rejected' ? (
					<View style={[globalStyles.cardSurface, {backgroundColor: colors.card}]}>
						<Text
							style={[
								styles.sectionHeading,
								{color: colors.error, fontSize: typeScale.h4.fontSize, lineHeight: typeScale.h4.lineHeight},
							]}>
							{t('newDevice.rejectedHeading')}
						</Text>
						<Text style={[styles.sectionBody, {color: colors.textSecondary, fontSize: typeScale.body.fontSize}]}>
							{t('newDevice.rejectedBody')}
						</Text>
					</View>
				) : null}
			</ScrollView>
		</View>
	);
}

interface IdentityFieldProps {
	testID: string;
	placeholder: string;
	value: string;
	onChangeText: (value: string) => void;
	onFocus: () => void;
	onLayoutFrame: (e: LayoutChangeEvent) => void;
	error?: string;
}

/** One identity-fallback row. Local to this screen (FieldGroup's FieldRow has no onFocus/onLayout
 * seam this geometry requirement needs). */
function IdentityField({testID, placeholder, value, onChangeText, onFocus, onLayoutFrame, error}: IdentityFieldProps) {
	const {colors, fonts, type: typeScale} = useTheme() as ExtendedTheme;
	return (
		<View testID={testID} onLayout={onLayoutFrame} style={styles.identityFieldRow}>
			<TextInput
				testID={`${testID}-input`}
				value={value}
				onChangeText={onChangeText}
				onFocus={onFocus}
				placeholder={placeholder}
				placeholderTextColor={error ? colors.error : colors.textSecondary}
				style={[
					styles.input,
					{
						color: colors.text,
						borderColor: error ? colors.error : colors.border,
						fontFamily: fonts.regular.fontFamily,
						fontWeight: fonts.regular.fontWeight,
						fontSize: typeScale.body.fontSize,
					},
				]}
			/>
			{error ? (
				<Text style={[styles.fieldError, {color: colors.error, fontSize: typeScale.caption.fontSize}]}>{error}</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
	},
	scroll: {
		flex: 1,
	},
	topBar: {
		flexDirection: 'row',
		justifyContent: 'flex-end',
		minHeight: 44,
	},
	closeButton: {
		minWidth: 44,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
	},
	title: {
		marginBottom: 16, // md
	},
	fieldLabel: {
		marginBottom: 8, // sm
	},
	input: {
		borderWidth: 1,
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 12,
		minHeight: 44,
	},
	fieldError: {
		marginTop: 4, // xs
	},
	identityFieldRow: {
		marginTop: 12,
	},
	sectionHeading: {
		marginBottom: 8, // sm
	},
	sectionBody: {
		marginBottom: 16, // md
	},
	cta: {
		marginTop: 16, // md
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
	},
	retryCta: {
		marginTop: 12,
		minHeight: 44,
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 24,
		borderWidth: 1,
	},
	ctaLabel: {
		fontWeight: '600',
	},
	linkRow: {
		marginTop: 16, // md
		minHeight: 44,
		justifyContent: 'center',
	},
	linkLabel: {},
});
