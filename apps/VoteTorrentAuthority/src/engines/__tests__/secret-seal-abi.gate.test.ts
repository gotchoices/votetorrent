/**
 * secret-seal-abi.gate.test.ts — the `sealSecret`/`unsealSecret` ABI must agree across the codegen spec (TS), the
 * Kotlin TurboModule, the Swift `@objc(...)` selectors and the ObjC `RCT_EXTERN_METHOD` externs, and the shared
 * constants (alias pattern, plaintext cap) must agree across TS, Kotlin and Swift.
 *
 * Why: `typecheck:ios` compiles only the Swift, never the .m, and a Swift/ObjC selector mismatch is an
 * "unrecognized selector" crash on the first call, not a compile error. Android arity is proven by the Kotlin
 * compile (codegen regenerates the Java spec from the TS spec). Extraction runs on comment-stripped text, and the
 * comparator is pure so the planted-mismatch tests below prove the gate can fail.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function strip(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
}

const PKG = join(resolve(__dirname, '..', '..', '..', '..', '..'), 'packages', 'attestation-native');
const KT = join(PKG, 'android', 'src', 'main', 'java', 'org', 'votetorrent', 'attestationnative');

interface Texts {
	spec: string;
	sealTs: string;
	kotlinModule: string;
	kotlinHelper: string;
	swift: string;
	objc: string;
}

function load(): Texts {
	const r = (p: string) => strip(readFileSync(p, 'utf8'));
	return {
		spec: r(join(PKG, 'src', 'specs', 'NativeAttestation.ts')),
		sealTs: r(join(PKG, 'src', 'secret-seal.ts')),
		kotlinModule: r(join(KT, 'AttestationNativeModule.kt')),
		kotlinHelper: r(join(KT, 'SecretSealHelper.kt')),
		swift: r(join(PKG, 'ios', 'AttestationNativeModule.swift')),
		objc: r(join(PKG, 'ios', 'AttestationNative.m')),
	};
}

const METHODS = ['sealSecret', 'unsealSecret'] as const;
type Method = (typeof METHODS)[number];

const EXPECTED_PARAMS: Record<Method, string[]> = {
	sealSecret: ['keyAlias', 'plaintextBase64'],
	unsealSecret: ['keyAlias', 'ciphertextBase64', 'promptTitle', 'promptSubtitle', 'promptNegativeButton'],
};

const names = (raw: string) =>
	raw
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => p.split(':')[0]!.trim());

function specParams(t: Texts, m: Method): string[] | undefined {
	const x = new RegExp(`\\b${m}\\(([\\s\\S]*?)\\):\\s*Promise<Object>`).exec(t.spec);
	return x ? names(x[1]!) : undefined;
}

function kotlinParams(t: Texts, m: Method): string[] | undefined {
	const x = new RegExp(`override fun ${m}\\(([\\s\\S]*?)\\)\\s*\\{`).exec(t.kotlinModule);
	return x ? names(x[1]!).filter((n) => n !== 'promise') : undefined;
}

/** Selector labels after the method name, e.g. `sealSecret:plaintextBase64:resolver:rejecter:` -> labels. */
function swiftSelector(t: Texts, m: Method): string | undefined {
	return new RegExp(`@objc\\((${m}:[A-Za-z0-9:]*)\\)`).exec(t.swift)?.[1];
}

function objcSelector(t: Texts, m: Method): string | undefined {
	const x = new RegExp(`RCT_EXTERN_METHOD\\(${m}:([\\s\\S]*?)\\)\\s*(?:\\n|$)`).exec(t.objc);
	if (!x) return undefined;
	const labels = [...`${m}:${x[1]}`.matchAll(/([A-Za-z0-9]+):\(/g)].map((g) => g[1]);
	return `${m}:${labels.slice(1).map((l) => `${l}:`).join('')}`;
}

function expectedSelector(m: Method): string {
	return `${m}:${EXPECTED_PARAMS[m].slice(1).map((p) => `${p}:`).join('')}resolver:rejecter:`;
}

/** Pure comparator: every mismatch as a line. */
export function abiMismatches(t: Texts): string[] {
	const out: string[] = [];
	for (const m of METHODS) {
		const want = EXPECTED_PARAMS[m].join(',');
		if (specParams(t, m)?.join(',') !== want) out.push(`spec ${m}: ${specParams(t, m)?.join(',')} != ${want}`);
		if (kotlinParams(t, m)?.join(',') !== want) out.push(`kotlin ${m}: ${kotlinParams(t, m)?.join(',')} != ${want}`);
		if (swiftSelector(t, m) !== expectedSelector(m)) out.push(`swift ${m}: ${swiftSelector(t, m)} != ${expectedSelector(m)}`);
		if (objcSelector(t, m) !== expectedSelector(m)) out.push(`objc ${m}: ${objcSelector(t, m)} != ${expectedSelector(m)}`);
	}
	const tsPattern = /SEAL_KEY_ALIAS_PATTERN = \/(.+?)\//.exec(t.sealTs)?.[1];
	const ktPattern = /SEAL_KEY_ALIAS_PATTERN = Regex\("(.+?)"\)/.exec(t.kotlinHelper)?.[1];
	const swPattern = /sealKeyAliasPattern = try! NSRegularExpression\(pattern: "(.+?)"\)/.exec(t.swift)?.[1];
	if (!tsPattern || tsPattern !== ktPattern || tsPattern !== swPattern) out.push(`alias pattern: ts=${tsPattern} kt=${ktPattern} swift=${swPattern}`);
	const tsMax = /MAX_SEAL_PLAINTEXT_BYTES = (\d+)/.exec(t.sealTs)?.[1];
	const ktMax = /MAX_SEAL_PLAINTEXT_BYTES = (\d+)/.exec(t.kotlinHelper)?.[1];
	const swMax = /maxSealPlaintextBytes = (\d+)/.exec(t.swift)?.[1];
	if (!tsMax || tsMax !== ktMax || tsMax !== swMax) out.push(`max plaintext: ts=${tsMax} kt=${ktMax} swift=${swMax}`);
	return out;
}

describe('secret-seal native ABI gate', () => {
	it('spec, Kotlin, Swift and ObjC agree on both methods, and TS/Kotlin/Swift on the shared constants', () => {
		expect(abiMismatches(load())).toEqual([]);
	});

	/** A planted edit that must apply exactly once, or the self-test would prove nothing. */
	function mutate(text: string, from: string, to: string): string {
		expect(text.split(from).length - 1).toBe(1);
		return text.replace(from, to);
	}

	it('self-test: a renamed ObjC label is caught', () => {
		const t = load();
		const objc = mutate(t.objc, 'unsealSecret:(NSString *)keyAlias\n                  ciphertextBase64:', 'unsealSecret:(NSString *)keyAlias\n                  cipherBase64:');
		expect(abiMismatches({ ...t, objc })).not.toEqual([]);
	});

	it('self-test: a dropped Kotlin parameter, a drifted alias pattern and a drifted cap are each caught', () => {
		const t = load();
		const kotlinModule = mutate(t.kotlinModule, 'override fun unsealSecret(\n\t\tkeyAlias: String,\n\t\tciphertextBase64: String,', 'override fun unsealSecret(\n\t\tkeyAlias: String,');
		expect(abiMismatches({ ...t, kotlinModule })).not.toEqual([]);
		const swift = mutate(t.swift, '_SEAL_KEY_V[0-9]+$', '_SEAL_KEY_V[0-9]*$');
		expect(abiMismatches({ ...t, swift })).not.toEqual([]);
		const kotlinHelper = mutate(t.kotlinHelper, 'MAX_SEAL_PLAINTEXT_BYTES = 128', 'MAX_SEAL_PLAINTEXT_BYTES = 190');
		expect(abiMismatches({ ...t, kotlinHelper })).not.toEqual([]);
	});
});
