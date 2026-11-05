/**
 * The voter's association-verifier gate: the stub is dev-only, and everything else fails
 * closed. The factory-wiring half is a comment-stripped source scan (the same technique as
 * `no-vrg-ceremony.gate.test.ts`) because building the real `'association'` engine needs an
 * established network ctx this unit tier does not have.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {AttestationChallenge, DeviceAttestation} from '@votetorrent/vote-core';
import {StubAttestationVerifier} from '@votetorrent/vote-engine/rn';
import {RefusingAttestationVerifier, selectAttestationVerifier} from '../attestation-verifier';
import {USE_STUB_ATTESTATION_VERIFIER} from '../proof-flags.generated';

// A challenge/attestation pair the STUB passes (no Android platform nonce to mismatch), so a
// refusal below can only come from the refusing verifier itself.
const challenge = {nonce: 'n-1'} as unknown as AttestationChallenge;
const attestation = {} as unknown as DeviceAttestation;

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('selectAttestationVerifier', () => {
	it('selects the stub only when __DEV__ AND the flag are both true', () => {
		expect(selectAttestationVerifier(true, true)).toBeInstanceOf(StubAttestationVerifier);
	});

	it.each([
		['release build, flag on', false, true],
		['dev build, flag off', true, false],
		['release build, flag off', false, false],
	])('fails closed for %s', async (_label, isDev, useStub) => {
		const verifier = selectAttestationVerifier(isDev, useStub);
		expect(verifier).toBeInstanceOf(RefusingAttestationVerifier);
		await expect(verifier.verify(challenge, attestation)).resolves.toMatchObject({ok: false});
	});

	it('the stub would have passed the same input (so the refusal is the gate, not the fixture)', async () => {
		await expect(new StubAttestationVerifier().verify(challenge, attestation)).resolves.toEqual({ok: true});
	});
});

describe('committed defaults and factory wiring', () => {
	it('commits USE_STUB_ATTESTATION_VERIFIER as false', () => {
		expect(USE_STUB_ATTESTATION_VERIFIER).toBe(false);
	});

	it("builds the 'association' verifier through the __DEV__ gate, never a bare stub", () => {
		const source = stripComments(fs.readFileSync(path.resolve(__dirname, '../engine-factory.ts'), 'utf8'));
		expect(source).toMatch(/selectAttestationVerifier\(\s*__DEV__\s*,\s*USE_STUB_ATTESTATION_VERIFIER\s*\)/);
		expect(source).not.toMatch(/\bStubAttestationVerifier\b/);
	});
});
