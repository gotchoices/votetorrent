/**
 * Copy contract for the Voter scan, join-failure and registration-wait strings
 * (UI-SPEC Test Contract items 6 and 13, Addendum A4).
 *
 * The tables were extracted mechanically from the approved UI-SPEC Copywriting
 * Contract plus Addendum A4 (A4 rows supersede earlier rows). The hand-quoted
 * used-up checks below are the independent guard on that extraction.
 */
import fs from 'fs';
import path from 'path';
import i18n, { resources } from '../src/i18n/index';

type Row = readonly [string, string, string];

const EXPECTED_JOIN: readonly Row[] = [
	['intro', "Scan the QR code your election authority showed you, or paste the join code. It connects this phone to the authority's voting network.", 'Escanea el código QR que te mostró tu autoridad electoral o pega el código de acceso. Conecta este teléfono a la red de votación de la autoridad.'],
	['codePlaceholder', 'Paste the join code', 'Pega el código de acceso'],
	['scanButton', 'Scan QR code', 'Escanear código QR'],
	['scanTitle', 'Scan the join code', 'Escanea el código de acceso'],
	['scanInstruction', 'Point the camera at the QR code from your election authority.', 'Apunta la cámara al código QR de tu autoridad electoral.'],
	['scanSlow', 'Hold the phone steady and move closer until the whole QR code fills the frame, or paste the code instead.', 'Sostén el teléfono firme y acércalo hasta que todo el código QR llene el marco, o pega el código.'],
	['scanStarting', 'Starting the camera…', 'Iniciando la cámara…'],
	['scanClose', 'Close scanner', 'Cerrar escáner'],
	['scanPasteInstead', 'Paste instead', 'Pegar el código'],
	['scannedNotice', 'Code scanned. Check the network name and fingerprint below, then tap Join network.', 'Código escaneado. Revisa el nombre y la huella de la red que aparecen abajo y toca Unirse a la red.'],
	['scanNotJoinCode', "That QR code isn't a VoteTorrent join code, so scan the one from your election authority or paste the code instead.", 'Ese código QR no es un código de acceso de VoteTorrent, así que escanea el de tu autoridad electoral o pega el código.'],
	['cameraDenied', "Camera access was not allowed, so this phone can't scan. Try again, or paste the join code instead.", 'No se permitió el acceso a la cámara, así que este teléfono no puede escanear. Inténtalo de nuevo o pega el código de acceso.'],
	['cameraBlocked', 'Camera access is turned off for VoteTorrent. Turn it on in Settings, or paste the join code instead.', 'El acceso a la cámara está desactivado para VoteTorrent. Actívalo en Ajustes o pega el código de acceso.'],
	['cameraNone', 'This phone has no camera to scan with. Paste the join code instead.', 'Este teléfono no tiene cámara para escanear. Pega el código de acceso.'],
	['cameraFailed', 'The camera could not start. Close other apps that use the camera and try again, or paste the join code instead.', 'No se pudo iniciar la cámara. Cierra otras aplicaciones que usen la cámara e inténtalo de nuevo, o pega el código de acceso.'],
	['openSettings', 'Open Settings', 'Abrir Ajustes'],
	['olderCode', 'This join code was made by an older version of VoteTorrent, so ask your election authority for a new one.', 'Este código de acceso lo creó una versión anterior de VoteTorrent, así que pide uno nuevo a tu autoridad electoral.'],
	['notJoinCode', "This isn't a VoteTorrent join code, so paste the one from your election authority or scan their QR code.", 'Este no es un código de acceso de VoteTorrent, así que pega el de tu autoridad electoral o escanea su código QR.'],
	['error.invitationUsedUp', 'This join code can no longer be used, so ask the election office for a new one.', 'Este código de acceso ya no se puede usar, así que pide uno nuevo a la oficina electoral.'],
];

const EXPECTED_REGISTRATION: readonly Row[] = [
	['confirmation.waiting', 'Waiting for the election office to approve your registration, so keep this screen open.', 'Esperando a que la oficina electoral apruebe tu registro, así que mantén esta pantalla abierta.'],
	['confirmation.waitingCancel', 'Stop waiting', 'Dejar de esperar'],
	['confirmation.error.decisionTimeout', "The election office hasn't answered yet, so tap Try Again after they approve your registration.", 'La oficina electoral aún no ha respondido, así que toca Intentar de nuevo cuando apruebe tu registro.'],
	['confirmation.error.waitStopped', 'You stopped waiting, so tap Try Again when the election office has approved your registration.', 'Dejaste de esperar, así que toca Intentar de nuevo cuando la oficina electoral haya aprobado tu registro.'],
];

const FAILURE_KEYS: readonly (readonly [string, string])[] = [
	['join', 'olderCode'],
	['join', 'notJoinCode'],
	['join', 'error.invitationUsedUp'],
	['join', 'scanNotJoinCode'],
	['registration', 'confirmation.error.decisionTimeout'],
	['registration', 'confirmation.error.waitStopped'],
];

const PHASE_RE = /phase\s*\d+/i;
const FASE_RE = /fase\s*\d+/i;
const DECISION_RE = /\bD-\d{2}\b/;

const tokensOf = (s: string): string[] =>
	[...s.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]).sort();
const sentenceCount = (s: string): number => (s.match(/[.!?](?=\s|$)/g) ?? []).length;

type Catalog = Record<string, Record<string, string>>;
const catalog = (lng: 'en' | 'es'): Catalog => resources[lng] as unknown as Catalog;
const raw = (lng: 'en' | 'es', ns: string, key: string): string => catalog(lng)[ns][key];

function copyMismatches(table: readonly Row[], ns: string, lng: 'en' | 'es'): string[] {
	const t = i18n.getFixedT(lng, ns);
	const out: string[] = [];
	for (const [key, enText, esText] of table) {
		if (t(key) !== (lng === 'en' ? enText : esText)) out.push(`${lng}:${ns}:${key}`);
	}
	return out;
}

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'index.ts'), 'utf8');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALL: readonly (readonly [string, Row])[] = [
	...EXPECTED_JOIN.map((r) => ['join', r] as const),
	...EXPECTED_REGISTRATION.map((r) => ['registration', r] as const),
];

describe('Voter scan, join-failure and registration-wait copy contract', () => {
	it('(a) the tables have 19 and 4 distinct keys', () => {
		expect(new Set(EXPECTED_JOIN.map((r) => r[0])).size).toBe(19);
		expect(EXPECTED_JOIN).toHaveLength(19);
		expect(new Set(EXPECTED_REGISTRATION.map((r) => r[0])).size).toBe(4);
		expect(EXPECTED_REGISTRATION).toHaveLength(4);
	});

	describe('(b) every key resolves to its exact en and es text', () => {
		it.each(ALL.map(([ns, r]) => [ns, ...r] as [string, string, string, string]))(
			'%s / %s',
			(ns, key, enText, esText) => {
				const tEn = i18n.getFixedT('en', ns)(key);
				const tEs = i18n.getFixedT('es', ns)(key);
				expect(tEn).toBe(enText);
				expect(tEs).toBe(esText);
				expect(tEn).not.toBe(key);
				expect(tEs).not.toBe(key);
				expect(raw('en', ns, key)).toBe(enText);
				expect(raw('es', ns, key)).toBe(esText);
				expect(esText).not.toBe(enText);
			},
		);
	});

	it('(c) copyMismatches is empty for both namespaces and locales', () => {
		for (const lng of ['en', 'es'] as const) {
			expect(copyMismatches(EXPECTED_JOIN, 'join', lng)).toEqual([]);
			expect(copyMismatches(EXPECTED_REGISTRATION, 'registration', lng)).toEqual([]);
		}
	});

	it.each(ALL.map(([, r]) => r[0]))('(d) %s is declared exactly twice in the source', (key) => {
		const hits = SOURCE.match(new RegExp(`^\\s*(?:'${escapeRe(key)}'|${escapeRe(key)}):`, 'gm')) ?? [];
		expect(hits).toHaveLength(2);
	});

	it('(e) no new value or catalog value carries a phase number or decision id', () => {
		for (const [, [key, enText, esText]] of ALL) {
			for (const v of [enText, esText]) {
				expect({ key, hit: PHASE_RE.test(v) }).toEqual({ key, hit: false });
				expect({ key, hit: FASE_RE.test(v) }).toEqual({ key, hit: false });
				expect({ key, hit: DECISION_RE.test(v) }).toEqual({ key, hit: false });
			}
		}
		for (const lng of ['en', 'es'] as const) {
			for (const [ns, entries] of Object.entries(catalog(lng))) {
				for (const [key, v] of Object.entries(entries)) {
					if (typeof v !== 'string') continue;
					expect({ lng, ns, key, hit: PHASE_RE.test(v) }).toEqual({ lng, ns, key, hit: false });
					expect({ lng, ns, key, hit: FASE_RE.test(v) }).toEqual({ lng, ns, key, hit: false });
				}
			}
		}
	});

	it('(f) no new value has an interpolation token', () => {
		for (const [, [key, enText, esText]] of ALL) {
			expect({ key, tokens: tokensOf(enText) }).toEqual({ key, tokens: [] });
			expect({ key, tokens: tokensOf(esText) }).toEqual({ key, tokens: [] });
		}
	});

	it('(g) no new value contains a join-code prefix', () => {
		for (const [, [key, enText, esText]] of ALL) {
			for (const v of [enText, esText]) {
				expect({ key, hit: /vtjoin|sereus-invite/.test(v) }).toEqual({ key, hit: false });
			}
		}
		expect(raw('en', 'join', 'codePlaceholder')).not.toMatch(/vtjoin/);
		expect(raw('es', 'join', 'codePlaceholder')).not.toMatch(/vtjoin/);
	});

	it('(h) used-up wording is neutral, hand-quoted', () => {
		const en = raw('en', 'join', 'error.invitationUsedUp');
		const es = raw('es', 'join', 'error.invitationUsedUp');
		expect(en).toBe('This join code can no longer be used, so ask the election office for a new one.');
		expect(es).toBe(
			'Este código de acceso ya no se puede usar, así que pide uno nuevo a la oficina electoral.',
		);
		expect(en).not.toMatch(/too many/i);
		expect(es).not.toMatch(/demasiad/i);
	});

	it('(i) retained keys still resolve', () => {
		for (const lng of ['en', 'es'] as const) {
			const t = i18n.getFixedT(lng, 'join');
			for (const key of ['newerCode', 'invalidCode', 'error.invitationExpired']) {
				expect(t(key)).not.toBe(key);
				expect(t(key).length).toBeGreaterThan(0);
			}
		}
	});

	it('(j) every failure is one sentence ending with a full stop', () => {
		for (const [ns, key] of FAILURE_KEYS) {
			for (const lng of ['en', 'es'] as const) {
				const v = raw(lng, ns, key);
				expect({ ns, key, n: sentenceCount(v) }).toEqual({ ns, key, n: 1 });
				expect(v.endsWith('.')).toBe(true);
			}
		}
	});

	describe('(k) negative and paired controls', () => {
		it('the phase matcher fires on planted input and not on clean copy', () => {
			expect(PHASE_RE.test('Phase 64')).toBe(true);
			expect(PHASE_RE.test('phase 7')).toBe(true);
			expect(PHASE_RE.test('Join a network')).toBe(false);
			expect(FASE_RE.test('Fase 3')).toBe(true);
		});

		it('the sentence counter distinguishes one sentence from two', () => {
			expect(
				sentenceCount('Camera access was not allowed, so this phone cannot scan. Try again.'),
			).toBe(2);
			expect(sentenceCount(raw('en', 'join', 'error.invitationUsedUp'))).toBe(1);
		});

		it('the used-up matchers fire on planted input', () => {
			expect(/too many/i.test('used too many times')).toBe(true);
			expect(/demasiad/i.test('demasiadas veces')).toBe(true);
		});

		it('copyMismatches reports a changed es value and a missing key', () => {
			const planted: Row[] = EXPECTED_JOIN.map((r, i) =>
				i === 3 ? ([r[0], r[1], `${r[2]} x`] as const) : r,
			);
			planted.push(['notARealKey64', 'x', 'y']);
			const found = copyMismatches(planted, 'join', 'es');
			expect(found).toHaveLength(2);
			expect(found).toEqual([`es:join:${EXPECTED_JOIN[3][0]}`, 'es:join:notARealKey64']);
		});
	});
});
