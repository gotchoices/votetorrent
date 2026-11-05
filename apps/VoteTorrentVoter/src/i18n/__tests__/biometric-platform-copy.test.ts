import fs from 'fs';
import path from 'path';
import {resources} from '../index';

// D-101: base key = iOS (Face ID), "<key>.android" = Android (fingerprint); screens pick by Platform.OS.
export const BIOMETRIC_PLATFORM_KEYS = [
	'receipt.revealHint',
	'receipt.revealBiometricUnavailable',
	'receipt.prompt.subtitle',
	'send.hint',
	'send.confirming',
	'send.biometricUnavailable',
	'send.recordPrompt.subtitle',
	'submit.recordPrompt.subtitle',
	'submit.failure.canceled',
	'submit.failure.biometricUnavailable',
	'submit.failure.keyInvalidated',
	'confirmation.error.biometricNotEnrolled',
];
// Keys that live outside the ballot namespace.
const KEY_NAMESPACE: Record<string, 'ballot' | 'registration'> = {
	'confirmation.error.biometricNotEnrolled': 'registration',
};
export const BIOMETRIC_CONSUMERS: Record<string, string[]> = {
	'SendVoteCard.tsx': ['send.hint', 'send.confirming', 'send.biometricUnavailable', 'send.recordPrompt.subtitle'],
	'VoteReceiptScreen.tsx': ['receipt.revealHint', 'receipt.revealBiometricUnavailable', 'receipt.prompt.subtitle'],
	'ReviewSubmitScreen.tsx': ['submit.recordPrompt.subtitle', 'submit.failure.canceled', 'submit.failure.biometricUnavailable', 'submit.failure.keyInvalidated'],
	'../registration/ConfirmationScreen.tsx': ['confirmation.error.biometricNotEnrolled'],
	'../registration/ContinueOnAnotherDeviceScreen.tsx': ['confirmation.error.biometricNotEnrolled'],
};

// Today's Android text, pinned exactly (it was proven on device).
const ANDROID_TEXT: Record<'en' | 'es', Record<string, string>> = {
	en: {
		'receipt.revealHint': "You'll be asked for your fingerprint.",
		'receipt.revealBiometricUnavailable': "Your fingerprint can't be checked right now. Make sure a fingerprint is set up on this phone, then try again.",
		'receipt.prompt.subtitle': 'Use your fingerprint to see your choices and vote codes',
		'send.hint': "You'll be asked for your fingerprint to open your saved vote, and again to confirm each group it is sent in.",
		'send.confirming': 'Confirm with your fingerprint to send.',
		'send.biometricUnavailable': "Your fingerprint can't be checked right now. Make sure a fingerprint is set up on this phone, then try again.",
		'send.recordPrompt.subtitle': 'Use your fingerprint to send your saved vote',
		'submit.recordPrompt.subtitle': 'Use your fingerprint to protect your saved vote',
		'submit.failure.canceled': 'Your vote was not saved. The fingerprint check was canceled.',
		'submit.failure.biometricUnavailable': "Your vote was not saved. Your fingerprint can't be checked right now. Make sure a fingerprint is set up on this phone, then try again.",
		'submit.failure.keyInvalidated': "Your vote was not saved. The fingerprint settings on this phone changed, so the vote couldn't be protected.",
		'confirmation.error.biometricNotEnrolled': 'Set up fingerprint or face unlock to continue',
	},
	es: {
		'receipt.revealHint': 'Se te pedirá tu huella digital.',
		'receipt.revealBiometricUnavailable': 'No podemos comprobar tu huella digital ahora. Asegúrate de tener una huella configurada en este teléfono e inténtalo de nuevo.',
		'receipt.prompt.subtitle': 'Usa tu huella digital para ver tus opciones y códigos de voto',
		'send.hint': 'Se te pedirá tu huella digital para abrir tu voto guardado y otra vez para confirmar cada grupo en el que se envía.',
		'send.confirming': 'Confirma con tu huella digital para enviar.',
		'send.biometricUnavailable': 'No se puede comprobar tu huella digital ahora. Asegúrate de tener una huella configurada en este teléfono e inténtalo de nuevo.',
		'send.recordPrompt.subtitle': 'Usa tu huella digital para enviar tu voto guardado',
		'submit.recordPrompt.subtitle': 'Usa tu huella digital para proteger tu voto guardado',
		'submit.failure.canceled': 'Tu voto no se guardó. Se canceló la comprobación de huella digital.',
		'submit.failure.biometricUnavailable': 'Tu voto no se guardó. No podemos comprobar tu huella digital ahora. Asegúrate de tener una huella configurada en este teléfono e inténtalo de nuevo.',
		'submit.failure.keyInvalidated': 'Tu voto no se guardó. La configuración de huellas de este teléfono cambió, así que el voto no se pudo proteger.',
		'confirmation.error.biometricNotEnrolled': 'Configura el desbloqueo por huella o rostro para continuar',
	},
};

type Tree = {[k: string]: string | Tree};
const nsOf = (lang: 'en' | 'es', key: string) =>
	(resources[lang] as unknown as Record<string, Tree>)[KEY_NAMESPACE[key] ?? 'ballot'] as Record<string, string>;

describe('biometric copy is split per platform (D-101)', () => {
	for (const lang of ['en', 'es'] as const) {
		for (const key of BIOMETRIC_PLATFORM_KEYS) {
			it(`${lang} ${key}: base names Face ID, .android keeps today's text`, () => {
				const ns = nsOf(lang, key);
				const base = ns[key];
				const android = ns[`${key}.android`];
				expect(typeof base).toBe('string');
				expect(typeof android).toBe('string');
				expect(base).toMatch(/Face ID/);
				expect(base).not.toMatch(/fingerprint|huella/i);
				expect(android).toMatch(lang === 'en' ? /fingerprint/ : /huella/);
				expect(android).toBe(ANDROID_TEXT[lang][key]);
				expect(base).not.toMatch(/\bphase\s*\d/i);
				expect(android).not.toMatch(/\bphase\s*\d/i);
			});
		}
	}

	for (const [file, keys] of Object.entries(BIOMETRIC_CONSUMERS)) {
		it(`${file} uses both literal keys for each split key it references`, () => {
			const src = fs.readFileSync(path.join(__dirname, '..', '..', 'screens', 'ballot', file), 'utf8');
			for (const key of keys) {
				expect(src).toContain(`'${key}'`);
				expect(src).toContain(`'${key}.android'`);
			}
		});
	}
});
