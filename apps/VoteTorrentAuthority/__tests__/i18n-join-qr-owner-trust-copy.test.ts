/**
 * Copy contract for the Authority join-by-QR, owner-trust and Join a network
 * strings (UI-SPEC Test Contract items 6 and 13, Addendum A4).
 *
 * EXPECTED was extracted mechanically from the approved UI-SPEC Copywriting
 * Contract plus Addendum A4 (A4 rows supersede earlier rows). The hand-quoted
 * A4 checks further down are the independent guard on that extraction.
 */
import fs from 'fs';
import path from 'path';
import i18n, { resources } from '../src/i18n/index';

type Row = readonly [string, string, string];

const EXPECTED: readonly Row[] = [
	['voterInviteReadyBody', 'Voters can scan the QR code in the VoteTorrent Voter app under Settings, Join a network, or paste the join code there. Publish the network fingerprint below through an official channel so voters can check it.', 'Los votantes pueden escanear el código QR en la aplicación VoteTorrent Voter, en Ajustes, Unirse a una red, o pegar allí el código de acceso. Publica la huella de la red que aparece abajo por un canal oficial para que los votantes puedan comprobarla.'],
	['voterInviteQrOpen', 'Show QR code', 'Mostrar código QR'],
	['voterInviteQrHint', 'Tap the QR code to show it full screen.', 'Toca el código QR para mostrarlo a pantalla completa.'],
	['voterInviteQrThumbA11y', 'QR code for the join code. Double tap to show it full screen.', 'Código QR del código de acceso. Toca dos veces para mostrarlo a pantalla completa.'],
	['voterInviteQrClose', 'Close', 'Cerrar'],
	['voterInviteQrWarning', 'Anyone who scans this code can join this network until it expires. Show it only to the voters you want to invite.', 'Cualquiera que escanee este código puede unirse a esta red hasta que caduque. Muéstralo solo a los votantes que quieras invitar.'],
	['voterInviteQrShareImage', 'Share QR image', 'Compartir imagen del QR'],
	['voterInviteQrShareFailed', 'Could not share the QR image. Try Share join code instead.', 'No se pudo compartir la imagen del QR. Prueba a compartir el código de acceso.'],
	['voterInviteQrRenderFailed', 'This join code is too long to show as a QR code. Use Copy or Share instead.', 'Este código de acceso es demasiado largo para mostrarlo como código QR. Usa Copiar o Compartir.'],
	['ownerTrustReinviteTitle', 'Invite this phone again', 'Invita este teléfono de nuevo'],
	['ownerTrustReinviteBody', 'This phone does not remember which owners to trust on its network, so ask the election office for a new join code and join with it on the Join a network screen.', 'Este teléfono no recuerda en qué propietarios debe confiar en su red, así que pide un código de acceso nuevo a la oficina electoral y úsalo en la pantalla Unirse a una red.'],
	['ownerTrustReinviteAction', 'Join a network', 'Unirse a una red'],
	['ownerTrustMemoryTitle', 'Owner trust is not being saved', 'La confianza en los propietarios no se está guardando'],
	['ownerTrustMemoryBody', 'This phone could not open its saved list of trusted owners, so it will forget them when the app closes and you may need to be invited again. To stop the app from connecting this way, turn on Require saved owner trust in Settings, then reopen the app.', 'Este teléfono no pudo abrir su lista guardada de propietarios de confianza, así que los olvidará al cerrar la aplicación y quizá debas ser invitado de nuevo. Para evitar que la aplicación se conecte así, activa Exigir confianza de propietarios guardada en Ajustes y vuelve a abrir la aplicación.'],
	['ownerTrustBlockedTitle', 'The network connection did not start', 'La conexión a la red no se inició'],
	['ownerTrustBlockedBody', 'This phone could not open its saved list of trusted owners, and Require saved owner trust is on, so it did not connect. Reopen the app to try again, or turn the setting off in Settings and then reopen the app to connect without saved trust.', 'Este teléfono no pudo abrir su lista guardada de propietarios de confianza y Exigir confianza de propietarios guardada está activado, así que no se conectó. Vuelve a abrir la aplicación para intentarlo de nuevo, o desactiva la opción en Ajustes y luego vuelve a abrir la aplicación para conectarte sin confianza guardada.'],
	['ownerTrustOpenSettings', 'Open Settings', 'Abrir Ajustes'],
	['settingsRequireOwnerTrust', 'Require saved owner trust', 'Exigir confianza de propietarios guardada'],
	['settingsRequireOwnerTrustHelp', 'When on, this phone will not connect to the network if it cannot load its saved trusted owners. When off, it connects and shows a warning. Takes effect the next time the app starts.', 'Si está activado, este teléfono no se conectará a la red si no puede cargar sus propietarios de confianza guardados. Si está desactivado, se conecta y muestra una advertencia. Se aplica la próxima vez que se inicie la aplicación.'],
	['joinNetworkButton', 'Join a network', 'Unirse a una red'],
	['joinNetworkTitle', 'Join a network', 'Unirse a una red'],
	['joinNetworkIntro', "Paste the join code the election office gave you. It connects this phone to that network and lets it trust the network's owners.", 'Pega el código de acceso que te dio la oficina electoral. Conecta este teléfono a esa red y le permite confiar en los propietarios de la red.'],
	['joinNetworkCodeLabel', 'Join code', 'Código de acceso'],
	['joinNetworkCodePlaceholder', 'Paste the join code', 'Pega el código de acceso'],
	['joinNetworkPaste', 'Paste', 'Pegar'],
	['joinNetworkPreviewCheck', 'Before you join, check that this fingerprint matches the one the election office published.', 'Antes de unirte, comprueba que esta huella coincide con la que publicó la oficina electoral.'],
	['joinNetworkSubmit', 'Join network', 'Unirse a la red'],
	['joinNetworkStepAdmitting', 'Joining the network…', 'Uniéndote a la red…'],
	['joinNetworkStepSyncing', 'Downloading the network…', 'Descargando la red…'],
	['joinNetworkStepVerifying', 'Checking the network matches the code…', 'Comprobando que la red coincide con el código…'],
	['joinNetworkJoinedTitle', 'You joined {{name}}', 'Te uniste a {{name}}'],
	['joinNetworkTrustNotSaved', 'You joined the network, but this phone could not save which owners to trust, so join again with a new code from the election office.', 'Te uniste a la red, pero este teléfono no pudo guardar en qué propietarios confiar, así que vuelve a unirte con un código nuevo de la oficina electoral.'],
	['joinNetworkDone', 'Done', 'Listo'],
	['joinNetworkErrorInvalidCode', "This isn't a valid join code, so check that you copied all of it or ask the election office for a new one.", 'Este no es un código de acceso válido, así que comprueba que lo copiaste completo o pide uno nuevo a la oficina electoral.'],
	['joinNetworkErrorNewerCode', 'This join code needs a newer version of the app, so update the app and try again.', 'Este código de acceso requiere una versión más reciente de la aplicación, así que actualízala e inténtalo de nuevo.'],
	['joinNetworkErrorOlderCode', 'This join code was made by an older version of VoteTorrent, so ask the election office for a new one.', 'Este código de acceso lo creó una versión anterior de VoteTorrent, así que pide uno nuevo a la oficina electoral.'],
	['joinNetworkErrorNotJoinCode', "This isn't a VoteTorrent join code, so paste the one from the election office.", 'Este no es un código de acceso de VoteTorrent, así que pega el de la oficina electoral.'],
	['joinNetworkErrorExpired', 'This join code has expired, so ask the election office for a new one.', 'Este código de acceso ha caducado, así que pide uno nuevo a la oficina electoral.'],
	['joinNetworkErrorUsedUp', 'This join code can no longer be used, so ask the election office for a new one.', 'Este código de acceso ya no se puede usar, así que pide uno nuevo a la oficina electoral.'],
	['joinNetworkErrorNotAdmitted', 'The network did not accept this code, so ask the election office for a new one.', 'La red no aceptó este código, así que pide uno nuevo a la oficina electoral.'],
	['joinNetworkErrorNoPeers', "We couldn't reach the network, so check your connection and try again.", 'No pudimos conectar con la red, así que comprueba tu conexión e inténtalo de nuevo.'],
	['joinNetworkErrorNotSynced', 'The network is taking too long to download, so check your connection and try again.', 'La red tarda demasiado en descargarse, así que comprueba tu conexión e inténtalo de nuevo.'],
	['joinNetworkErrorDigestMismatch', "This network doesn't match the join code, so this phone did not join it; ask the election office for a new code.", 'Esta red no coincide con el código de acceso, así que este teléfono no se unió a ella; pide un código nuevo a la oficina electoral.'],
	['joinNetworkErrorOpenFailed', "We couldn't open the network on this phone, so try again.", 'No pudimos abrir la red en este teléfono, así que inténtalo de nuevo.'],
	['joinNetworkErrorGeneric', 'Something went wrong while joining, so try again.', 'Algo salió mal al unirte, así que inténtalo de nuevo.'],
];

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

const QR = EXPECTED.slice(0, 9).map((r) => r[0]);
const OWNER_TRUST = EXPECTED.slice(9, 19).map((r) => r[0]);
const JOIN = EXPECTED.slice(19).map((r) => r[0]);

const FAILURE_KEYS = [
	'joinNetworkErrorInvalidCode',
	'joinNetworkErrorNewerCode',
	'joinNetworkErrorOlderCode',
	'joinNetworkErrorNotJoinCode',
	'joinNetworkErrorExpired',
	'joinNetworkErrorUsedUp',
	'joinNetworkErrorNotAdmitted',
	'joinNetworkErrorNoPeers',
	'joinNetworkErrorNotSynced',
	'joinNetworkErrorDigestMismatch',
	'joinNetworkErrorOpenFailed',
	'joinNetworkErrorGeneric',
	'joinNetworkTrustNotSaved',
] as const;

const PHASE_RE = /phase\s*\d+/i;
const FASE_RE = /fase\s*\d+/i;
const DECISION_RE = /\bD-\d{2}\b/;

const tokensOf = (s: string): string[] =>
	[...s.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]).sort();
const sentenceCount = (s: string): number => (s.match(/[.!?](?=\s|$)/g) ?? []).length;

function copyMismatches(table: readonly Row[], lng: 'en' | 'es'): string[] {
	const t = i18n.getFixedT(lng);
	const out: string[] = [];
	for (const [key, enText, esText] of table) {
		const expected = lng === 'en' ? enText : esText;
		const actual =
			key === 'joinNetworkJoinedTitle'
				? (resources[lng].translation as Record<string, string>)[key]
				: t(key);
		if (actual !== expected) out.push(`${lng}:${key}`);
	}
	return out;
}

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'index.ts'), 'utf8');

describe('Authority join, QR and owner-trust copy contract', () => {
	it('(a) has 45 distinct keys partitioned 9 / 10 / 26', () => {
		const keys = EXPECTED.map((r) => r[0]);
		expect(new Set(keys).size).toBe(45);
		expect(EXPECTED).toHaveLength(45);
		expect(QR).toHaveLength(9);
		expect(OWNER_TRUST).toHaveLength(10);
		expect(JOIN).toHaveLength(26);
		expect([...QR, ...OWNER_TRUST, ...JOIN]).toEqual(keys);
	});

	describe('(b) every key resolves to its exact en and es text', () => {
		it.each(EXPECTED as unknown as Row[])('%s', (key, enText, esText) => {
			if (key !== 'joinNetworkJoinedTitle') {
				expect(i18n.getFixedT('en')(key)).toBe(enText);
				expect(i18n.getFixedT('es')(key)).toBe(esText);
			}
			expect(en[key]).toBe(enText);
			expect(es[key]).toBe(esText);
			expect(esText).not.toBe(enText);
		});

		it('interpolates the network name in joinNetworkJoinedTitle', () => {
			expect(i18n.getFixedT('en')('joinNetworkJoinedTitle', { name: 'Springfield' })).toBe(
				'You joined Springfield',
			);
			expect(i18n.getFixedT('es')('joinNetworkJoinedTitle', { name: 'Springfield' })).toBe(
				'Te uniste a Springfield',
			);
		});
	});

	it('(c) copyMismatches is empty in both locales', () => {
		expect(copyMismatches(EXPECTED, 'en')).toEqual([]);
		expect(copyMismatches(EXPECTED, 'es')).toEqual([]);
	});

	it.each(EXPECTED.map((r) => r[0]))('(d) %s is declared exactly twice in the source', (key) => {
		const hits = SOURCE.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? [];
		expect(hits).toHaveLength(2);
	});

	it('(e) no new value or catalog value carries a phase number or decision id', () => {
		for (const [key, enText, esText] of EXPECTED) {
			for (const v of [enText, esText]) {
				expect({ key, hit: PHASE_RE.test(v) }).toEqual({ key, hit: false });
				expect({ key, hit: FASE_RE.test(v) }).toEqual({ key, hit: false });
				expect({ key, hit: DECISION_RE.test(v) }).toEqual({ key, hit: false });
			}
		}
		for (const [lng, cat] of [['en', en], ['es', es]] as const) {
			for (const [key, v] of Object.entries(cat)) {
				if (typeof v !== 'string') continue;
				expect({ lng, key, hit: PHASE_RE.test(v) }).toEqual({ lng, key, hit: false });
				expect({ lng, key, hit: FASE_RE.test(v) }).toEqual({ lng, key, hit: false });
			}
		}
	});

	it('(f) interpolation tokens match across locales; only the joined title has one', () => {
		for (const [key, enText, esText] of EXPECTED) {
			expect(tokensOf(enText)).toEqual(tokensOf(esText));
			expect({ key, tokens: tokensOf(enText) }).toEqual({
				key,
				tokens: key === 'joinNetworkJoinedTitle' ? ['name'] : [],
			});
		}
	});

	it('(g) no new value contains a join-code prefix', () => {
		for (const [key, enText, esText] of EXPECTED) {
			for (const v of [enText, esText]) {
				expect({ key, hit: /vtjoin|sereus-invite/.test(v) }).toEqual({ key, hit: false });
			}
		}
	});

	it('(h) used-up wording is neutral', () => {
		expect(en.joinNetworkErrorUsedUp).toContain('election office');
		expect(en.joinNetworkErrorUsedUp).not.toMatch(/too many/i);
		expect(es.joinNetworkErrorUsedUp).toContain('oficina electoral');
		expect(es.joinNetworkErrorUsedUp).not.toMatch(/demasiad/i);
	});

	it('(i) Addendum A4 supersessions, hand-quoted', () => {
		expect(en.ownerTrustReinviteAction).toBe('Join a network');
		expect(es.ownerTrustReinviteAction).toBe('Unirse a una red');
		expect(en.ownerTrustReinviteBody).toContain('Join a network screen');
		expect(en.ownerTrustReinviteBody).toContain('election office');
		expect(en.ownerTrustReinviteBody).not.toMatch(/accept|invitation/i);
		expect(es.ownerTrustReinviteBody).toContain('Unirse a una red');
		expect(es.ownerTrustReinviteBody).toContain('oficina electoral');
		expect(es.ownerTrustReinviteBody).not.toMatch(/acépt|invitación/i);
		expect(en.joinNetworkTrustNotSaved).toBe(
			'You joined the network, but this phone could not save which owners to trust, so join again with a new code from the election office.',
		);
		expect(es.joinNetworkTrustNotSaved).toBe(
			'Te uniste a la red, pero este teléfono no pudo guardar en qué propietarios confiar, así que vuelve a unirte con un código nuevo de la oficina electoral.',
		);
		expect(en.joinNetworkErrorUsedUp).toBe(
			'This join code can no longer be used, so ask the election office for a new one.',
		);
		expect(es.joinNetworkErrorUsedUp).toBe(
			'Este código de acceso ya no se puede usar, así que pide uno nuevo a la oficina electoral.',
		);
	});

	it('(j) the bearer warning is exact', () => {
		expect(en.voterInviteQrWarning).toBe(
			'Anyone who scans this code can join this network until it expires. Show it only to the voters you want to invite.',
		);
		expect(es.voterInviteQrWarning).toBe(
			'Cualquiera que escanee este código puede unirse a esta red hasta que caduque. Muéstralo solo a los votantes que quieras invitar.',
		);
	});

	it('(k) every failure is one sentence ending with a full stop', () => {
		for (const key of FAILURE_KEYS) {
			for (const v of [en[key], es[key]]) {
				expect({ key, n: sentenceCount(v) }).toEqual({ key, n: 1 });
				expect(v.endsWith('.')).toBe(true);
			}
		}
	});

	it('(l) prefix groups have the expected sizes in both locales', () => {
		for (const cat of [en, es]) {
			const keys = Object.keys(cat);
			expect(keys.filter((k) => /^voterInviteQr[A-Z]/.test(k))).toHaveLength(8);
			expect(keys.filter((k) => /^ownerTrust[A-Z]/.test(k))).toHaveLength(8);
			expect(keys.filter((k) => /^settingsRequireOwnerTrust/.test(k))).toHaveLength(2);
		}
	});

	describe('(m) negative and paired controls', () => {
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
			expect(sentenceCount(en.joinNetworkErrorUsedUp)).toBe(1);
		});

		it('the used-up matchers fire on planted input', () => {
			expect(/too many/i.test('used too many times')).toBe(true);
			expect(/demasiad/i.test('demasiadas veces')).toBe(true);
		});

		it('copyMismatches reports a changed es value and a missing key', () => {
			const planted: Row[] = EXPECTED.map((r, i) =>
				i === 3 ? ([r[0], r[1], `${r[2]} x`] as const) : r,
			);
			planted.push(['notARealKey64', 'x', 'y']);
			const found = copyMismatches(planted, 'es');
			expect(found).toHaveLength(2);
			expect(found).toEqual([`es:${EXPECTED[3][0]}`, 'es:notARealKey64']);
		});
	});
});
