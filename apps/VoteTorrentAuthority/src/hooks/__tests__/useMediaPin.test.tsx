/**
 * useMediaPin — the state behind each "Make Permanent" chip. vote-engine's fingerprintMedia is
 * stubbed at the module boundary; the hook's pin/un-pin rules and status copy are real.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import '../../i18n';

class MockMediaFingerprintError extends Error {
	constructor(readonly reason: string, message: string) {
		super(message);
		this.name = 'MediaFingerprintError';
	}
}

const mockFingerprint = jest.fn();
jest.mock('@votetorrent/vote-engine/rn', () => ({
	fingerprintMedia: (...args: unknown[]) => mockFingerprint(...args),
	MediaFingerprintError: MockMediaFingerprintError,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {useMediaPin} = require('../useMediaPin');

type Pin = ReturnType<typeof useMediaPin>;

function mount(initial?: {url?: string; cid?: string}) {
	const captured: {value: Pin | null} = {value: null};
	function Probe() {
		captured.value = useMediaPin(initial);
		return null;
	}
	renderer.act(() => {
		renderer.create(<Probe />);
	});
	return captured;
}

async function flush() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

describe('useMediaPin', () => {
	beforeEach(() => mockFingerprint.mockReset());

	it('pins a URL and returns its cid only while the field still holds that URL', async () => {
		mockFingerprint.mockResolvedValue({url: 'https://x.test/a.png', cid: 'bafkreiabcdefghijklmnop'});
		const pin = mount();

		renderer.act(() => {
			pin.value!.pin(' https://x.test/a.png ');
		});
		expect(pin.value!.isPinning).toBe(true);
		expect(pin.value!.statusFor('https://x.test/a.png')).toEqual({label: 'Making permanent…', tone: 'muted'});
		await flush();

		expect(mockFingerprint).toHaveBeenCalledWith('https://x.test/a.png');
		expect(pin.value!.cidFor('https://x.test/a.png')).toBe('bafkreiabcdefghijklmnop');
		expect(pin.value!.statusFor('https://x.test/a.png')?.tone).toBe('success');
		// Editing the URL un-pins it: no cid is ever saved next to a URL it does not describe.
		expect(pin.value!.cidFor('https://x.test/b.png')).toBeUndefined();
		expect(pin.value!.statusFor('https://x.test/b.png')).toBeUndefined();
	});

	it('maps a typed failure to its message and yields no cid', async () => {
		mockFingerprint.mockRejectedValue(new MockMediaFingerprintError('too-large', 'big'));
		const pin = mount();
		renderer.act(() => {
			pin.value!.pin('https://x.test/huge.mp4');
		});
		await flush();

		expect(pin.value!.cidFor('https://x.test/huge.mp4')).toBeUndefined();
		expect(pin.value!.statusFor('https://x.test/huge.mp4')).toEqual({
			label: 'This file is too large to make permanent (25 MB limit)',
			tone: 'error',
		});
	});

	it('treats an unexpected error as a network failure', async () => {
		mockFingerprint.mockRejectedValue(new Error('boom'));
		const pin = mount();
		renderer.act(() => {
			pin.value!.pin('https://x.test/a.png');
		});
		await flush();
		expect(pin.value!.statusFor('https://x.test/a.png')?.tone).toBe('error');
	});

	it('seeds from an existing pinned record and reset() re-seeds', async () => {
		const pin = mount({url: 'https://x.test/a.png', cid: 'bafkexisting'});
		expect(pin.value!.cidFor('https://x.test/a.png')).toBe('bafkexisting');

		renderer.act(() => {
			pin.value!.reset({url: 'https://x.test/c.png'});
		});
		expect(pin.value!.cidFor('https://x.test/a.png')).toBeUndefined();
		expect(mockFingerprint).not.toHaveBeenCalled();
	});
});
