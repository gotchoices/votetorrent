/**
 * @format
 *
 * Guards the react-native-nitro-modules JSICache patch
 * (.yarn/patches/react-native-nitro-modules-npm-0.37.1-votetorrent.patch) in both apps.
 *
 * Unpatched, JSICache kept a WeakReference for every value it converted and released them only
 * when the runtime was torn down, so each ArrayBuffer handed to a native method (a hash update,
 * an Ed25519 verify, a Noise frame) left ~100 bytes of native memory behind. On the iPhone that
 * grew the Voter past iOS's ~2 GB limit and the app was killed mid-registration.
 *
 * The C++ check (fixtures/nitro-jsicache-prune.cpp) is compiled against the INSTALLED headers and
 * appends to the cache the way makeShared does; built with -DUNPATCHED it keeps all 100000
 * entries and states, which is the red control below.
 */
import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const APP_DIRS = {
	voter: path.resolve(__dirname, '..'),
	authority: path.resolve(__dirname, '..', '..', 'VoteTorrentAuthority'),
};
const FIXTURE = path.join(__dirname, 'fixtures', 'nitro-jsicache-prune.cpp');
const CXX = process.env.CXX || 'c++';

function nitroCpp(appDir: string): string {
	return path.join(appDir, 'node_modules', 'react-native-nitro-modules', 'cpp');
}

interface PruneResult {
	fullAppendsWhileLive: number;
	sizeAfterReleased: number;
	statesAfterReleased: number;
	lockable: number;
	heldIntact: boolean;
	heldDestroyed: boolean;
	sizeAtEnd: number;
}

function runCheck(extraFlags: string[]): PruneResult {
	const utils = path.join(nitroCpp(APP_DIRS.voter), 'utils');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-prune-'));
	try {
		const bin = path.join(dir, 'prune');
		execFileSync(
			CXX,
			['-std=c++20', '-O1', '-fsized-deallocation', ...extraFlags, `-I${utils}`, FIXTURE, path.join(utils, 'NitroTypeInfo.cpp'), '-o', bin],
			{stdio: 'pipe'},
		);
		return JSON.parse(execFileSync(bin, {encoding: 'utf8'}));
	} finally {
		fs.rmSync(dir, {recursive: true, force: true});
	}
}

describe('react-native-nitro-modules JSICache prunes released references', () => {
	it.each(Object.entries(APP_DIRS))('%s: every makeShared appends through appendPruningExpired', (_app, appDir) => {
		const header = fs.readFileSync(path.join(nitroCpp(appDir), 'jsi', 'JSICache.hpp'), 'utf8');
		expect(header).not.toMatch(/push_back\(owning\.weak\(\)\)/);
		expect(header.match(/appendPruningExpired\(_strongCache->_\w+Cache, owning\.weak\(\)\)/g)).toHaveLength(6);
		expect(fs.existsSync(path.join(nitroCpp(appDir), 'utils', 'WeakReferenceCache.hpp'))).toBe(true);
	});

	it('released values leave no entries or states behind; held values stay lockable and are destroyed at teardown', () => {
		const result = runCheck([]);
		expect(result.sizeAfterReleased).toBeLessThanOrEqual(2);
		expect(result.statesAfterReleased).toBeLessThanOrEqual(2);
		expect(result.lockable).toBe(1000);
		expect(result.heldIntact).toBe(true);
		expect(result.heldDestroyed).toBe(true);
		expect(result.sizeAtEnd).toBeLessThan(2048);
	});

	it('a mostly-live cache grows instead of being rescanned on almost every append', () => {
		// 20000 appends over a 1000-value live window: with the capacity doubling a prune leaves
		// ~1000 free slots (~20 prunes); without it, ~24 (~800 prunes).
		expect(runCheck([]).fullAppendsWhileLive).toBeLessThanOrEqual(60);
	});

	it('red control: the unpatched push_back keeps every released entry and its state', () => {
		const result = runCheck(['-DUNPATCHED']);
		expect(result.sizeAfterReleased).toBe(100000);
		expect(result.statesAfterReleased).toBe(100000);
	});
});
