/**
 * @format
 *
 * Phase 39 plan 39-08 (SHELL-05 / I18N-01) — namespace-aware i18n parity gate, ported from
 * Authority's `__tests__/i18n-parity.test.ts` (D-14) and rewritten for Voting's D-11 feature-
 * namespaced resource tree. Authority's flat single-namespace assumption (`resources.en` with a
 * `.translation` leaf, hardcoded as `enTranslation`/`esTranslation`) is invalid here — the
 * namespaced tree has no such top-level leaf, so deriving keys the same way would be `undefined`
 * and `Object.keys(undefined)` would throw (RESEARCH Pitfall 2). This test instead walks
 * `Object.keys(resources.en)` to discover the namespace list, then applies Authority's checks —
 * EN<->ES symmetry and no-orphans — per namespace, plus a literal-key source scan.
 *
 * Scope narrowed from Authority's whole `../src` to `src/screens/` + `src/components/` only
 * (D-14) — the two trees where user-visible copy lives this phase.
 *
 * Authority's fourth "no English-leftover" check is deliberately NOT ported unqualified: the
 * endonym keys `settings.languageEnglish` / `settings.languageSpanish` are intentionally
 * identical across EN/ES (mobile-locale-picker convention, 39-UI-SPEC.md) and would false-
 * positive against it. D-14 specifies exactly 3 checks (symmetry, no-orphans, literal-key scan);
 * this file implements exactly those 3.
 */
import * as fs from 'fs';
import * as path from 'path';
import {resources} from '../src/i18n/index';

type NamespaceTree = Record<string, string>;
type ResourceTree = Record<string, NamespaceTree>;

const enResources = resources.en as unknown as ResourceTree;
const esResources = resources.es as unknown as ResourceTree;

// The namespace list IS `Object.keys(resources.en)` (D-14) — the 6 feature namespaces
// (`common`, `home`, `ballot`, `registration`, `scan`, `settings`) — not a flat single-bucket
// key list (Pitfall 2).
const namespaces = Object.keys(resources.en);

// D-15: placeholder/debug-label allowlist. Stub scaffolding (dev-only trigger affordances,
// the __DEV__ lifecycle cycler, etc.) may in a future phase reference literal t()-keys that are
// intentionally not "final copy" bundle keys yet. Entries here are exempted from the
// literal-key scan's missing-key failure so early scaffolding doesn't force premature key
// creation, while the guard itself stays active (and will still catch anything NOT explicitly
// allowlisted) on every commit. Currently empty in practice — every t() call in the 39-05/06
// screens + PlaceholderModal already resolves — the mechanism is wired in ahead of Phases 40-43.
const PLACEHOLDER_ALLOWLIST = new Set<string>([]);

describe('i18n parity (D-14, namespace-aware)', () => {
	for (const ns of namespaces) {
		const enKeys = Object.keys(enResources[ns] ?? {});
		const esKeys = Object.keys(esResources[ns] ?? {});

		test(`[${ns}] es contains every en key (symmetry)`, () => {
			const missingInEs = enKeys.filter(k => !esKeys.includes(k));
			expect(missingInEs).toEqual([]);
		});

		test(`[${ns}] en contains every es key (no orphans)`, () => {
			const missingInEn = esKeys.filter(k => !enKeys.includes(k));
			expect(missingInEn).toEqual([]);
		});
	}

	test('every literal t("key") / t("ns:key") used in src/screens/ + src/components/ resolves in the bundle', () => {
		const srcDir = path.resolve(__dirname, '../src');
		const scanRoots = ['screens', 'components'].map(d => path.join(srcDir, d));

		// Port of Authority's fs.readdirSync walk, scoped to the D-14 roots (`src/screens/` +
		// `src/components/`, not Authority's whole `../src`).
		const walk = (dir: string): string[] => {
			if (!fs.existsSync(dir)) return [];
			return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === 'node_modules' || entry.name === '__tests__') return [];
					return walk(full);
				}
				return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
			});
		};

		const files = scanRoots.flatMap(walk);

		// Per-file alias -> namespace map, derived from `const {t[: alias]} = useTranslation('ns')`.
		// A bare t('key') call resolves against the CALLING file's mapped namespace for that alias
		// (not a single global bucket — Pitfall 2 correction, since Voting has 6 namespaces).
		const useTranslationRe =
			/const\s*\{\s*t(?:\s*:\s*(\w+))?\s*\}\s*=\s*useTranslation\(\s*['"]([\w-]+)['"]\s*\)/g;

		const missing = new Map<string, string>(); // reported key -> first file it appears in

		for (const file of files) {
			const text = fs.readFileSync(file, 'utf8');
			const relFile = path.relative(srcDir, file);

			const aliasToNs = new Map<string, string>();
			useTranslationRe.lastIndex = 0;
			let am: RegExpExecArray | null;
			while ((am = useTranslationRe.exec(text)) !== null) {
				const alias = am[1] ?? 't';
				aliasToNs.set(alias, am[2]);
			}
			if (aliasToNs.size === 0) continue; // no useTranslation() call in this file — nothing to check

			for (const [alias, defaultNs] of aliasToNs) {
				// Match `alias('key')` / `alias("ns:key")`, excluding member calls / longer
				// identifiers (e.g. `.split(...)`, `formatDate(...)`) — Authority's negative-
				// lookbehind form (line 69 of the Authority source).
				const callRe = new RegExp(`(?<![\\w.])${alias}\\(\\s*['"]([\\w:.-]+)['"]\\s*\\)`, 'g');
				let cm: RegExpExecArray | null;
				while ((cm = callRe.exec(text)) !== null) {
					const raw = cm[1];
					const colonIdx = raw.indexOf(':');
					const ns = colonIdx === -1 ? defaultNs : raw.slice(0, colonIdx);
					const key = colonIdx === -1 ? raw : raw.slice(colonIdx + 1);
					const resolved = enResources[ns]?.[key] !== undefined;
					const reportKey = colonIdx === -1 ? `${ns}:${raw}` : raw;

					if (
						!resolved &&
						!PLACEHOLDER_ALLOWLIST.has(raw) &&
						!PLACEHOLDER_ALLOWLIST.has(reportKey) &&
						!missing.has(reportKey)
					) {
						missing.set(reportKey, relFile);
					}
				}
			}
		}

		const report = Array.from(missing, ([key, file]) => `${key} (${file})`);
		expect(report).toEqual([]);
	});
});
