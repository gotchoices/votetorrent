/**
 * The officer's "Require saved owner trust" setting (D-11), kept in its own AsyncStorage key.
 *
 * Off by default (an absent key is off). It is a plain async module because CadreNodeProvider reads
 * it from its boot effect before any React context exists, so it must NOT be routed through
 * SettingsProvider. The provider reads it ONLY when the saved trusted-owner store fails to open, and
 * treats a rejection as ON (fail closed). The Settings row (64-15) is the writer.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const REQUIRE_OWNER_TRUST_KEY = '@votetorrent/settings/requireOwnerTrust';

/** Absent is false. An unknown stored value rejects with fixed text; a read failure propagates. */
export async function readRequireOwnerTrust(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(REQUIRE_OWNER_TRUST_KEY);
  if (raw === null) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('require-owner-trust setting unreadable');
}

export async function writeRequireOwnerTrust(on: boolean): Promise<void> {
  await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, on ? 'true' : 'false');
}
