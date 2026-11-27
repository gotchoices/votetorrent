/**
 * D-30: the founder-intent windows and the founder-flag resolution table.
 *
 * The module under test is pure module state: one slot (null, a founding window, or a joining
 * window for one hash). This file is a TypeScript module (import/export below) so its top-level
 * helper names never collide with sibling test files in this directory.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../founder-intent');

export {};

type Intent = 'founding' | 'joining' | null;

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const spies: jest.SpyInstance[] = [];

describe('64-08 D-30: founder intent (FI)', () => {
	beforeAll(() => {
		for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			spies.push(jest.spyOn(console, m).mockImplementation(() => undefined));
		}
	});

	afterEach(() => {
		// No window may leak out of any test.
		expect(fi.takeFounderIntent('__probe__')).toBeNull();
	});

	afterAll(() => {
		for (const s of spies) s.mockRestore();
	});

	const intents: Intent[] = ['founding', 'joining', null];
	const rows: Array<[Intent, boolean, number, boolean]> = [];
	for (const intent of intents) {
		for (const joined of [true, false]) {
			for (const controlConnections of [0, 1, 3]) {
				let expected: boolean;
				if (joined) expected = false;
				else if (intent === 'joining') expected = false;
				else if (intent === 'founding') expected = true;
				else expected = controlConnections === 0;
				rows.push([intent, joined, controlConnections, expected]);
			}
		}
	}

	it.each(rows)(
		'FI-1 resolveFounderFlag intent=%s joined=%s connections=%s -> %s',
		(intent, joined, controlConnections, expected) => {
			expect(fi.resolveFounderFlag({ intent, joined, controlConnections })).toBe(expected);
		},
	);

	it('FI-2 outside any window, take returns null for any hash', () => {
		expect(fi.takeFounderIntent('a')).toBeNull();
		expect(fi.takeFounderIntent('b')).toBeNull();
	});

	it('FI-3 first take inside withFounding is founding, the second is null, value passes through', async () => {
		const out = await fi.withFounding(async () => {
			const first = fi.takeFounderIntent('hashA');
			const second = fi.takeFounderIntent('hashA');
			const third = fi.takeFounderIntent('hashB');
			return { first, second, third };
		});
		expect(out).toEqual({ first: 'founding', second: null, third: null });
	});

	it('FI-4 an unconsumed founding window ends on resolve, reject and sync throw', async () => {
		await expect(fi.withFounding(async () => 'ok')).resolves.toBe('ok');
		expect(fi.takeFounderIntent('h')).toBeNull();

		const boom = new Error('boom');
		await expect(
			fi.withFounding(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(fi.takeFounderIntent('h')).toBeNull();

		const sync = new Error('sync');
		let caught: unknown;
		try {
			await fi.withFounding(() => {
				throw sync;
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(sync);
		expect(fi.takeFounderIntent('h')).toBeNull();
		// a fresh window can open afterwards
		await expect(fi.withFounding(async () => 1)).resolves.toBe(1);
	});

	it('FI-5 withJoining answers joining for every open of its own hash only', async () => {
		const out = await fi.withJoining('hJ', async () => [
			fi.takeFounderIntent('hJ'),
			fi.takeFounderIntent('hJ'),
			fi.takeFounderIntent('hJ'),
			fi.takeFounderIntent('hK'),
		]);
		expect(out).toEqual(['joining', 'joining', 'joining', null]);
		expect(fi.takeFounderIntent('hJ')).toBeNull();
	});

	it('FI-6 busy rules reject with FounderIntentBusyError and never call the inner fn', async () => {
		const inner = jest.fn(async () => 'x');

		// founding inside an unconsumed founding window
		await fi.withFounding(async () => {
			await expect(fi.withFounding(inner)).rejects.toMatchObject({ name: 'FounderIntentBusyError' });
			await expect(fi.withJoining('h', inner)).rejects.toMatchObject({ name: 'FounderIntentBusyError' });
			// outer window intact after refused calls
			expect(fi.takeFounderIntent('outer')).toBe('founding');
		});

		// anything inside a joining window
		await fi.withJoining('hJ', async () => {
			await expect(fi.withFounding(inner)).rejects.toMatchObject({ name: 'FounderIntentBusyError' });
			await expect(fi.withJoining('hK', inner)).rejects.toMatchObject({ name: 'FounderIntentBusyError' });
			expect(fi.takeFounderIntent('hJ')).toBe('joining');
		});

		// two overlapping calls started from separate async flows
		const gate = deferred<void>();
		const first = fi.withFounding(() => gate.promise);
		const second = fi.withFounding(inner);
		await expect(second).rejects.toBeInstanceOf(fi.FounderIntentBusyError);
		gate.resolve();
		await first;

		expect(inner).not.toHaveBeenCalled();
	});

	it('FI-7 after consumption a second founding window may start; token identity protects it', async () => {
		const gate = deferred<void>();
		const firstRan = deferred<string | null>();
		const first = fi.withFounding(async () => {
			firstRan.resolve(fi.takeFounderIntent('one'));
			await gate.promise;
		});
		expect(await firstRan.promise).toBe('founding');

		const gate2 = deferred<void>();
		const secondTaken = deferred<string | null>();
		const second = fi.withFounding(async () => {
			secondTaken.resolve(fi.takeFounderIntent('two'));
			await gate2.promise;
		});
		expect(await secondTaken.promise).toBe('founding');

		// first settles while the second window object is long consumed; nothing is cleared wrongly
		gate.resolve();
		await first;
		expect(fi.takeFounderIntent('three')).toBeNull();
		gate2.resolve();
		await second;
	});

	it('FI-7b the first settle does not clear a LIVE second window', async () => {
		const gate = deferred<void>();
		const firstRan = deferred<void>();
		const first = fi.withFounding(async () => {
			fi.takeFounderIntent('one');
			firstRan.resolve();
			await gate.promise;
		});
		await firstRan.promise;
		const gate2 = deferred<void>();
		const second = fi.withFounding(async () => {
			await gate2.promise;
		});
		gate.resolve();
		await first;
		// the second window is unconsumed and must still be live
		expect(fi.takeFounderIntent('late')).toBe('founding');
		gate2.resolve();
		await second;
	});

	it('FI-8 withJoining validates the hash and leaves no window open', async () => {
		const inner = jest.fn(async () => 'x');
		await expect(fi.withJoining('', inner)).rejects.toBeInstanceOf(TypeError);
		await expect(fi.withJoining(42 as never, inner)).rejects.toBeInstanceOf(TypeError);
		expect(inner).not.toHaveBeenCalled();
		expect(fi.takeFounderIntent('')).toBeNull();
		await expect(fi.withFounding(async () => 1)).resolves.toBe(1);
	});

	it('FI-9a wrapCreateWithFounding forwards args and this and returns the original result', async () => {
		const engine = {
			tag: 'E',
			async create(this: { tag: string }, a: number, b: string) {
				return [this.tag, a, b];
			},
		};
		const ret = fi.wrapCreateWithFounding(engine);
		expect(ret).toBe(engine);
		await expect(engine.create(1, 'two')).resolves.toEqual(['E', 1, 'two']);
	});

	it('FI-9b a take inside the original returns founding', async () => {
		const engine = {
			async create(hash: string) {
				return fi.takeFounderIntent(hash);
			},
		};
		fi.wrapCreateWithFounding(engine);
		await expect(engine.create('h')).resolves.toBe('founding');
	});

	it('FI-9c a second install is a no-op', async () => {
		const engine = { async create() { return 1; } };
		fi.wrapCreateWithFounding(engine);
		const installed = engine.create;
		fi.wrapCreateWithFounding(engine);
		expect(engine.create).toBe(installed);
		await expect(engine.create()).resolves.toBe(1);
		await expect(engine.create()).resolves.toBe(1);
	});

	it('FI-9d on an object with no create, install does not throw and create rejects TypeError', async () => {
		const engine: { create?: () => Promise<unknown> } = {};
		expect(() => fi.wrapCreateWithFounding(engine)).not.toThrow();
		await expect((engine.create as () => Promise<unknown>)()).rejects.toBeInstanceOf(TypeError);
		expect(fi.takeFounderIntent('h')).toBeNull();
	});

	it('FI-10 error classes: names, markers, fixed messages and guards', () => {
		const busy = new fi.FounderIntentBusyError();
		expect(busy).toBeInstanceOf(Error);
		expect(busy.name).toBe('FounderIntentBusyError');
		expect(busy.founderIntentBusy).toBe(true);
		expect(busy.message).toBe('Another network is being created or joined; try again when it finishes.');
		expect(fi.isFounderIntentBusyError(busy)).toBe(true);
		expect(fi.isFounderIntentBusyError(new Error('x'))).toBe(false);
		expect(fi.isFounderIntentBusyError(null)).toBe(false);
		expect(fi.isFounderIntentBusyError({ name: 'FounderIntentBusyError' })).toBe(false);

		const unreadable = new fi.JoinedNetworksUnreadableError();
		expect(unreadable).toBeInstanceOf(Error);
		expect(unreadable.name).toBe('JoinedNetworksUnreadableError');
		expect(unreadable.joinedNetworksUnreadable).toBe(true);
		expect(unreadable.message).toBe(
			'The list of joined networks could not be read, so the network was not opened.',
		);
		expect(fi.isJoinedNetworksUnreadableError(unreadable)).toBe(true);
		expect(fi.isJoinedNetworksUnreadableError(new Error('x'))).toBe(false);
		expect(fi.isJoinedNetworksUnreadableError(null)).toBe(false);
		expect(fi.isJoinedNetworksUnreadableError({ name: 'JoinedNetworksUnreadableError' })).toBe(false);
	});

	// MUST stay the last `it` in the file: it sees every earlier call.
	it('FI-11 the module never logs', () => {
		for (const s of spies) expect(s).not.toHaveBeenCalled();
	});
});
