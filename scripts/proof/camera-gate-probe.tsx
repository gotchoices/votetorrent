// camera-gate-probe.tsx - the D-05 build-and-boot gate probe (Phase 64, plan 06).
//
// It answers one question before any scanner screen exists: do VisionCamera 5.2.3, its QR
// output and Nitro mount on this React Native, inside an RN Modal, on a phone? It is reachable
// ONLY when metro.camera-gate.config.js (in the camera-gate evidence dir) redirects the Voter
// entry to this file, so it is never part of a shipped bundle. For the iOS embedded bundle the
// build's ENTRY_FILE names this file instead.
//
// It is driven from the host through CDP: globalThis.__vt64Probes.cameraGate has start(argsJson)
// and result(). Nothing on screen asks for the camera. The permission request happens only on
// an explicit open command, so no tap can trigger it by accident.
//
// It never reads, stores or logs scanner payloads, frames or images. It handles no join code
// (D-06). The scan handler takes no parameter on purpose. Every log line is ONE string of closed
// tokens, booleans and small integers.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppRegistry, Modal, StyleSheet, Text, View } from 'react-native'
import {
	Camera,
	useCameraDevice,
	useCameraPermission,
	type CameraDevice,
} from 'react-native-vision-camera'
import { useBarcodeScannerOutput } from 'react-native-vision-camera-barcode-scanner'
import { name as appName } from '../../apps/VoteTorrentVoter/app.json'

const CAMERA_GATE_PROBE_VERSION = 'camera-gate-probe/1'
// A stable reference: the scanner output memoises on this array.
const QR_FORMATS: ('qr-code')[] = ['qr-code']
const MOUNT_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

type Resolution = 'preview' | 'full'
type Phase = 'idle' | 'requesting' | 'opening' | 'active' | 'closing' | 'closed' | 'failed'
type ErrorSource = 'none' | 'camera' | 'scanner' | 'request' | 'probe'

interface ProbeState {
	v: 1
	probe: string
	phase: Phase
	lastCommand: 'none' | 'open' | 'close' | 'rejected-busy' | 'rejected-args' | 'rejected-not-ready'
	cycle: number
	resolution: 'none' | Resolution
	permissionBefore: string
	requestResult: 'none' | 'not-needed' | 'granted' | 'refused' | 'threw'
	permission: string
	device: 'present' | 'none'
	modalShown: boolean
	configured: boolean
	started: boolean
	previewStarted: boolean
	mounted: boolean
	stopped: boolean
	scanCallback: boolean
	mountLatency: 'none' | 'lt2s' | 'lt5s' | 'lt10s' | 'lt30s' | 'timeout'
	error: string
	errorSource: ErrorSource
}

function errorToken(e: unknown): string {
	try {
		const o = e as { code?: unknown; name?: unknown } | null | undefined
		const code = o && typeof o === 'object' ? o.code : undefined
		if (typeof code === 'string' && code.length <= 64 && /^[a-z][a-z0-9]*([-/][a-z0-9]+)*$/.test(code)) {
			return code
		}
		const name = o && typeof o === 'object' ? o.name : undefined
		if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) {
			return name
		}
	} catch {
		// fall through to the closed token
	}
	return 'unknown'
}

function latencyBucket(ms: number): 'lt2s' | 'lt5s' | 'lt10s' | 'lt30s' | 'timeout' {
	if (ms < 2000) return 'lt2s'
	if (ms < 5000) return 'lt5s'
	if (ms < 10000) return 'lt10s'
	if (ms < MOUNT_TIMEOUT_MS) return 'lt30s'
	return 'timeout'
}

const state: ProbeState = {
	v: 1,
	probe: CAMERA_GATE_PROBE_VERSION,
	phase: 'idle',
	lastCommand: 'none',
	cycle: 0,
	resolution: 'none',
	permissionBefore: 'unknown',
	requestResult: 'none',
	permission: 'unknown',
	device: 'none',
	modalShown: false,
	configured: false,
	started: false,
	previewStarted: false,
	mounted: false,
	stopped: false,
	scanCallback: false,
	mountLatency: 'none',
	error: 'none',
	errorSource: 'none',
}

function emit(): void {
	console.log('[camera-gate] ' + JSON.stringify(state))
}

interface Controller {
	open: (resolution: Resolution) => void
	close: () => void
}

let controller: Controller | null = null
let componentMounted = false
let stopWaiter: (() => void) | null = null
let shownAt = 0

const BUSY: Phase[] = ['requesting', 'opening', 'active', 'closing']

function setFailed(source: ErrorSource, token: string): void {
	state.error = token
	state.errorSource = source
	if (state.phase !== 'closing' && state.phase !== 'closed') state.phase = 'failed'
	emit()
}

function fail(source: ErrorSource, e: unknown): void {
	setFailed(source, errorToken(e))
}

function parseArgs(argsJson: string): { action: 'open'; resolution: Resolution } | { action: 'close' } | null {
	try {
		const a = JSON.parse(argsJson) as { action?: unknown; resolution?: unknown }
		if (a && a.action === 'close') return { action: 'close' }
		if (a && a.action === 'open' && (a.resolution === 'preview' || a.resolution === 'full')) {
			return { action: 'open', resolution: a.resolution }
		}
	} catch {
		// rejected below
	}
	return null
}

function start(argsJson: string): void {
	try {
		const args = parseArgs(argsJson)
		if (!args) {
			state.lastCommand = 'rejected-args'
			emit()
			return
		}
		if (!controller) {
			state.lastCommand = 'rejected-not-ready'
			emit()
			return
		}
		if (args.action === 'open') {
			if (BUSY.indexOf(state.phase) >= 0) {
				state.lastCommand = 'rejected-busy'
				emit()
				return
			}
			state.lastCommand = 'open'
			controller.open(args.resolution)
		} else {
			state.lastCommand = 'close'
			controller.close()
		}
	} catch {
		state.lastCommand = 'rejected-args'
	}
}

function result(): string | null {
	try {
		if (!componentMounted) return null
		return JSON.stringify(state)
	} catch {
		return '{"v":1,"probe":"camera-gate-probe/1","phase":"failed","error":"result-threw","errorSource":"probe"}'
	}
}

if (__DEV__) {
	const g = globalThis as unknown as { __vt64Probes?: Record<string, unknown> }
	g.__vt64Probes = g.__vt64Probes || {}
	g.__vt64Probes.cameraGate = { start, result }
}

function ProbeCamera(props: {
	device: CameraDevice
	resolution: Resolution
	active: boolean
}): React.JSX.Element {
	const { device, resolution, active } = props
	const output = useBarcodeScannerOutput({
		barcodeFormats: QR_FORMATS,
		outputResolution: resolution,
		onBarcodeScanned: () => {
			if (!state.scanCallback) {
				state.scanCallback = true
				emit()
			}
		},
		onError: (e) => fail('scanner', e),
	})
	const outputs = useMemo(() => [output], [output])
	const mountTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		mountTimer.current = setTimeout(() => {
			if (!state.mounted && state.phase !== 'closing' && state.phase !== 'closed') {
				state.mountLatency = 'timeout'
				setFailed('probe', 'mount-timeout')
			}
		}, MOUNT_TIMEOUT_MS)
		return () => {
			if (mountTimer.current) clearTimeout(mountTimer.current)
		}
	}, [])

	const maybeMounted = (): void => {
		if (state.started && state.previewStarted && !state.mounted) {
			state.mounted = true
			state.mountLatency = latencyBucket(Date.now() - shownAt)
			if (mountTimer.current) clearTimeout(mountTimer.current)
			if (state.phase === 'opening') state.phase = 'active'
		}
		emit()
	}

	return (
		<Camera
			style={StyleSheet.absoluteFill}
			device={device}
			isActive={active}
			outputs={outputs}
			onConfigured={() => {
				state.configured = true
				emit()
			}}
			onStarted={() => {
				state.started = true
				maybeMounted()
			}}
			onPreviewStarted={() => {
				state.previewStarted = true
				maybeMounted()
			}}
			onStopped={() => {
				state.stopped = true
				emit()
				if (stopWaiter) stopWaiter()
			}}
			onError={(e) => fail('camera', e)}
		/>
	)
}

function CameraGateProbe(): React.JSX.Element {
	if (!__DEV__) {
		return <Text>camera gate probe: dev only</Text>
	}
	const permission = useCameraPermission()
	const device = useCameraDevice('back')
	const [, setTick] = useState(0)
	const [shown, setShown] = useState(false)
	const [active, setActive] = useState(false)
	const [resolution, setResolution] = useState<Resolution>('preview')

	const permRef = useRef(permission)
	permRef.current = permission
	const deviceRef = useRef(device)
	deviceRef.current = device
	state.permission = permission.status
	state.device = device ? 'present' : 'none'

	const open = useCallback((res: Resolution): void => {
		const run = async (): Promise<void> => {
			state.cycle += 1
			state.resolution = res
			state.configured = false
			state.started = false
			state.previewStarted = false
			state.mounted = false
			state.stopped = false
			state.scanCallback = false
			state.mountLatency = 'none'
			state.error = 'none'
			state.errorSource = 'none'
			state.requestResult = 'none'
			state.modalShown = false
			state.permissionBefore = permRef.current.status
			if (permRef.current.status === 'not-determined') {
				state.phase = 'requesting'
				emit()
				try {
					const granted = await permRef.current.requestPermission()
					state.requestResult = granted ? 'granted' : 'refused'
				} catch {
					state.requestResult = 'threw'
					setFailed('request', 'request-threw')
					return
				}
			} else if (permRef.current.status === 'authorized') {
				state.requestResult = 'not-needed'
			}
			state.permission = permRef.current.status
			if (state.requestResult !== 'granted' && state.requestResult !== 'not-needed') {
				setFailed('request', 'permission-not-granted')
				return
			}
			if (!deviceRef.current) {
				setFailed('probe', 'no-device')
				return
			}
			state.phase = 'opening'
			emit()
			shownAt = Date.now()
			setResolution(res)
			setActive(true)
			setShown(true)
			setTick((t) => t + 1)
		}
		run().catch((e) => fail('probe', e))
	}, [])

	const close = useCallback((): void => {
		const run = async (): Promise<void> => {
			const failedEarlier = state.phase === 'failed'
			if (!failedEarlier) state.phase = 'closing'
			setActive(false)
			if (state.started && !state.stopped) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						stopWaiter = null
						resolve()
					}, STOP_TIMEOUT_MS)
					stopWaiter = () => {
						clearTimeout(timer)
						stopWaiter = null
						resolve()
					}
				})
				if (!state.stopped) {
					state.error = 'stop-timeout'
					state.errorSource = 'probe'
				}
			}
			setShown(false)
			if (!failedEarlier && state.error !== 'stop-timeout') state.phase = 'closed'
			else if (state.error === 'stop-timeout') state.phase = 'failed'
			emit()
			setTick((t) => t + 1)
		}
		run().catch((e) => fail('probe', e))
	}, [])

	useEffect(() => {
		controller = { open, close }
		componentMounted = true
		emit()
		return () => {
			controller = null
		}
	}, [open, close])

	return (
		<View style={styles.root}>
			<Text testID="camera-gate-status" style={styles.text}>
				{CAMERA_GATE_PROBE_VERSION + ' ' + state.phase}
			</Text>
			<Modal
				visible={shown}
				animationType="none"
				presentationStyle="fullScreen"
				supportedOrientations={['portrait']}
				onShow={() => {
					state.modalShown = true
					shownAt = Date.now()
					emit()
				}}
				onRequestClose={close}
			>
				<View testID="camera-gate-preview" style={styles.preview}>
					{shown && device ? (
						<ProbeCamera
							key={state.cycle}
							device={device}
							resolution={resolution}
							active={active}
						/>
					) : null}
				</View>
			</Modal>
		</View>
	)
}

const styles = StyleSheet.create({
	root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ffffff' },
	text: { fontSize: 16, color: '#000000' },
	preview: { flex: 1, backgroundColor: '#000000' },
})

AppRegistry.registerComponent(appName, () => CameraGateProbe)
