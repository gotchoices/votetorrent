/**
 * D-06 console and props hygiene across every scanner and Join flow (Phase 64 plan 64-18).
 *
 * The join code is a bearer credential. This renders the REAL JoinNetworkScreen, which renders the
 * REAL JoinCodeScanner, over the 64-01 VisionCamera mocks, and drives every flow that can touch the
 * code (type, paste, scan accept and reject, every decode error, join ok, every refused reason with a
 * hostile `detail`, a thrown join, camera and scanner errors, a rejected permission request, a
 * rejected openSettings) inside `captureConsole()`. In each flow:
 *  - no console call carries the code, any 16-char slice of it, the network name, the fingerprint, a
 *    rejected QR payload or a binary value (`allowBinary` is never set);
 *  - every call is one of the closed literal tokens, with at most a closed token as its second argument.
 * Then, after a scan accept and after a paste, no testID, accessibilityLabel, accessibilityHint or
 * nativeID in the tree carries a slice of the code.
 *
 * Titles carry fixture NAMES only. Code text is never given to a matcher that prints its operands.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Linking} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n';
import {JOIN_CODE_FIXTURES} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {JoinCodeFixtureName} from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import type {NetworkJoinFailureReason} from '@votetorrent/vote-engine/rn';
import {lightTheme} from '../../../theme/themes';
import {captureConsole, expectNoSecretInConsole} from '../../../engines/__fixtures__/console-leak';

const mockJoinNetwork = jest.fn();
jest.mock('../../../providers/VoterAppProvider', () => ({
	useVoterApp: () => ({joinNetwork: (...args: unknown[]) => mockJoinNetwork(...args)}),
}));
const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockSetOptions = jest.fn();
jest.mock('@react-navigation/native', () => ({
	...jest.requireActual('@react-navigation/native'),
	useNavigation: () => ({goBack: mockGoBack, navigate: mockNavigate, setParams: mockSetParams, setOptions: mockSetOptions}),
}));

import JoinNetworkScreen from '../JoinNetworkScreen';

interface VcMock {
	__setCameraPermissionStatus(s: string): void;
	__setCameraPermissionRequestResult(r: unknown): void;
	__resetVisionCameraMock(): void;
}
interface BsMock {
	__emitBarcodes(b: unknown[]): void;
	__emitBarcodeScannerError(e: Error): void;
	__resetBarcodeScannerMock(): void;
}
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;
const Clipboard = require('@react-native-clipboard/clipboard').default as {getString: () => Promise<string>};

const NAMES = Object.keys(JOIN_CODE_FIXTURES) as JoinCodeFixtureName[];
const sample = JOIN_CODE_FIXTURES['v2-1-member'];
const POSTER = 'https://example.org/poster/0123456789abcdef0123456789abcdef0123456789';
const REASONS: NetworkJoinFailureReason[] = [
	'invitation-malformed',
	'invitation-expired',
	'invitation-older-version',
	'invitation-used-up',
	'not-admitted',
	'no-peers',
	'not-synced',
	'digest-mismatch',
	'open-failed',
];

const FIRST_ARGS = new Set([
	'[join] scan: accepted',
	'[join] scan: rejected-not-join-code',
	'[join] scan: permission-denied',
	'[join] scan: permission-blocked',
	'[join] scan: permission-request-failed',
	'[join] scan: no-camera',
	'[join] scan: camera-failed',
	'[join] scan: scanner-failed',
	'[join] scan: open-settings-failed',
	'JoinNetworkScreen: join refused:',
	'JoinNetworkScreen: join failed:',
]);
const CLASS_TOKEN = /^(?:[A-Z][A-Za-z0-9]*|undefined|object|string|number)$/;

let tr: renderer.ReactTestRenderer | undefined;
function render() {
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<JoinNetworkScreen />
			</ThemeProvider>,
			{createNodeMock: () => ({})},
		);
	});
	return tr as renderer.ReactTestRenderer;
}
const byId = (id: string) => (tr as renderer.ReactTestRenderer).root.find(n => n.props.testID === id);
function type(value: string) {
	renderer.act(() => {
		byId('join-network-code-input').props.onChangeText(value);
	});
}
async function paste(value: string) {
	jest.spyOn(Clipboard, 'getString').mockResolvedValue(value);
	await renderer.act(async () => {
		await byId('join-network-paste').props.onPress();
	});
}
async function pressJoin() {
	await renderer.act(async () => {
		await byId('join-network-submit').props.onPress();
	});
}
async function pressScan() {
	await renderer.act(async () => {
		byId('join-network-scan').props.onPress();
	});
}
const emit = (barcodes: unknown[]) =>
	renderer.act(() => {
		bs.__emitBarcodes(barcodes);
	});
const cams = () => (tr as renderer.ReactTestRenderer).root.findAll(n => (n.type as unknown) === 'VisionCameraMock');

/** Run a flow inside a capture, then enforce the closed-token allowlist and the no-secret rule. */
async function flow(secrets: string[], body: () => void | Promise<void>, expectedRefusal?: NetworkJoinFailureReason) {
	const c = captureConsole();
	try {
		await body();
		const calls = c.calls();
		for (const args of calls) {
			expect(args.length === 1 || args.length === 2).toBe(true);
			expect(FIRST_ARGS.has(args[0] as string)).toBe(true);
			if (args.length === 2) {
				if (args[0] === 'JoinNetworkScreen: join refused:') {
					expect(expectedRefusal !== undefined && args[1] === expectedRefusal).toBe(true);
				} else {
					expect(args[0]).toBe('JoinNetworkScreen: join failed:');
					expect(CLASS_TOKEN.test(String(args[1]))).toBe(true);
				}
			}
		}
		expectNoSecretInConsole(c, secrets);
	} finally {
		c.restore();
	}
}

/** Every testID, accessibilityLabel, accessibilityHint and nativeID string currently in the tree. */
function propStrings(): string[] {
	const out = new Set<string>();
	for (const node of (tr as renderer.ReactTestRenderer).root.findAll(() => true)) {
		for (const key of ['testID', 'accessibilityLabel', 'accessibilityHint', 'nativeID']) {
			const value = node.props[key];
			if (typeof value === 'string') out.add(value);
		}
	}
	return [...out];
}

beforeEach(() => {
	mockJoinNetwork.mockReset();
	mockGoBack.mockReset();
	mockNavigate.mockReset();
	mockSetParams.mockReset();
	mockSetOptions.mockReset();
	vc.__resetVisionCameraMock();
	bs.__resetBarcodeScannerMock();
});

afterEach(() => {
	expect(mockNavigate).not.toHaveBeenCalled();
	expect(mockSetParams).not.toHaveBeenCalled();
	expect(mockSetOptions).not.toHaveBeenCalled();
	renderer.act(() => {
		tr?.unmount();
	});
	tr = undefined;
	jest.restoreAllMocks();
});

describe.each(NAMES)('Join flows with the %s code', name => {
	const f = JOIN_CODE_FIXTURES[name];
	const secrets = [f.text, f.name, f.fingerprint];
	const okNetworkRef = {hash: f.networkHash, relays: [], name: f.name, primaryAuthorityDomainName: 'example.org'};

	it('typing the text logs nothing sensitive', async () => {
		await flow(secrets, () => {
			render();
			type(f.text);
		});
	});

	it('pasting it logs nothing sensitive', async () => {
		await flow(secrets, async () => {
			render();
			await paste(f.text);
		});
	});

	it('a join that resolves ok logs nothing sensitive', async () => {
		mockJoinNetwork.mockResolvedValue({ok: true, outcome: 'joined', admittedVia: 'redeemed', networkRef: okNetworkRef, fingerprint: f.fingerprint});
		const isDecodable = name !== 'v1-114-no-prefix';
		await flow(secrets, async () => {
			render();
			type(f.text);
			if (isDecodable) await pressJoin();
		});
	});

	it.each(REASONS)('a refused join (%s) with a hostile detail logs only the reason token', async reason => {
		mockJoinNetwork.mockResolvedValue({ok: false, reason, detail: f.text});
		const decodable = name !== 'v1-114-no-prefix';
		await flow(
			secrets,
			async () => {
				render();
				type(f.text);
				if (decodable) await pressJoin();
			},
			reason,
		);
	});

	it('a thrown join whose message and cause carry the code logs only a class token', async () => {
		mockJoinNetwork.mockRejectedValue(Object.assign(new Error(f.text), {cause: new Error(f.text)}));
		await flow(secrets, async () => {
			render();
			type(f.text);
			if (name !== 'v1-114-no-prefix') await pressJoin();
		});
	});
});

describe('decode errors', () => {
	const cases: Array<[string, string]> = [
		['an older invitation', JOIN_CODE_FIXTURES['v1-114-no-prefix'].text],
		['a truncated v2 code', sample.text.slice(0, 600)],
		['a newer-version code', 'vtjoin9.' + sample.text.slice(100, 140)],
		['a non-VoteTorrent text', 'hello world, this is not a join code at all 0123456789'],
	];
	it.each(cases)('%s logs nothing sensitive', async (_label, text) => {
		await flow([text], () => {
			render();
			type(text);
		});
	});
});

describe('scan flows', () => {
	const secrets = [sample.text, sample.name, sample.fingerprint, POSTER];

	it('accepting the join code from a frame that also holds a poster logs only the accepted token', async () => {
		await flow(secrets, async () => {
			render();
			await pressScan();
			emit([{rawValue: POSTER}, {rawValue: sample.text, rawBytes: new Uint8Array(32), cornerPoints: [{x: 1, y: 2}]}]);
		});
		expect(cams().length).toBe(0);
	});

	it('rejecting a poster logs only the rejected token', async () => {
		await flow(secrets, async () => {
			render();
			await pressScan();
			emit([{rawValue: POSTER}]);
		});
		expect(cams().length).toBe(1);
	});

	it('a camera error that carries the code logs only the camera-failed token', async () => {
		await flow(secrets, async () => {
			render();
			await pressScan();
			renderer.act(() => {
				cams()[0].props.onError(new Error(sample.text));
			});
		});
	});

	it('a scanner error that carries the code logs only the scanner-failed token', async () => {
		await flow(secrets, async () => {
			render();
			await pressScan();
			renderer.act(() => {
				bs.__emitBarcodeScannerError(Object.assign(new Error(sample.text), {code: 'x'}));
			});
		});
	});

	it('a rejected permission request that carries the code logs only the request-failed token', async () => {
		vc.__setCameraPermissionStatus('not-determined');
		vc.__setCameraPermissionRequestResult(new Error(sample.text));
		await flow(secrets, async () => {
			render();
			await pressScan();
		});
	});

	it('a rejected openSettings that carries the code logs only the open-settings-failed token', async () => {
		vc.__setCameraPermissionStatus('denied');
		jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error(sample.text));
		await flow(secrets, async () => {
			render();
			await renderer.act(async () => {
				byId('join-network-scan-open-settings').props.onPress();
			});
		});
	});
});

describe('props hygiene', () => {
	/** No string in `values` carries a 16-char slice of any secret (checked through the same helper). */
	function expectCleanProps(values: string[], secrets: string[]) {
		const c = captureConsole();
		try {
			for (const value of values) console.info(value);
			expectNoSecretInConsole(c, secrets);
		} finally {
			c.restore();
		}
	}

	it.each(NAMES)('after a scan accept of the %s code, no testID or accessibility string carries it', async name => {
		const f = JOIN_CODE_FIXTURES[name];
		render();
		await pressScan();
		const openIds = propStrings();
		expect(openIds.length).toBeGreaterThan(10);
		expectCleanProps(openIds, [f.text, f.name, f.fingerprint]);
		emit([{rawValue: f.text}]);
		expect(cams().length).toBe(0);
		expect(propStrings().length).toBeGreaterThan(3);
		expectCleanProps(propStrings(), [f.text, f.name, f.fingerprint]);
		// the code lives in the input's value and nowhere else in the id and label props
		expect((byId('join-network-code-input').props.value as string) === f.text).toBe(true);
		expect(mockJoinNetwork).not.toHaveBeenCalled();
	});

	it.each(NAMES)('after a paste of the %s code, no testID or accessibility string carries it', async name => {
		const f = JOIN_CODE_FIXTURES[name];
		render();
		await paste(f.text);
		expectCleanProps(propStrings(), [f.text, f.name, f.fingerprint]);
		expect((byId('join-network-code-input').props.value as string) === f.text).toBe(true);
	});
});
