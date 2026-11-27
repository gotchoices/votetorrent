import AsyncStorage from '@react-native-async-storage/async-storage';
import { REQUIRE_OWNER_TRUST_KEY, readRequireOwnerTrust, writeRequireOwnerTrust } from '../owner-trust-setting';

describe('require saved owner trust setting', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lives under its own key', () => {
    expect(REQUIRE_OWNER_TRUST_KEY).toBe('@votetorrent/settings/requireOwnerTrust');
  });

  it('reads absent as off', async () => {
    await expect(readRequireOwnerTrust()).resolves.toBe(false);
  });

  it('reads the two stored strings', async () => {
    await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, 'true');
    await expect(readRequireOwnerTrust()).resolves.toBe(true);
    await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, 'false');
    await expect(readRequireOwnerTrust()).resolves.toBe(false);
  });

  it('rejects any other stored text without repeating it', async () => {
    await AsyncStorage.setItem(REQUIRE_OWNER_TRUST_KEY, 'yes-planted');
    const err = await readRequireOwnerTrust().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain('yes-planted');
  });

  it('rejects when AsyncStorage cannot be read', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('planted-io'));
    await expect(readRequireOwnerTrust()).rejects.toThrow('planted-io');
  });

  it('writes exactly true or false under the key', async () => {
    await writeRequireOwnerTrust(true);
    await expect(AsyncStorage.getItem(REQUIRE_OWNER_TRUST_KEY)).resolves.toBe('true');
    await writeRequireOwnerTrust(false);
    await expect(AsyncStorage.getItem(REQUIRE_OWNER_TRUST_KEY)).resolves.toBe('false');
  });

  it('lets a write failure propagate', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('planted-io'));
    await expect(writeRequireOwnerTrust(true)).rejects.toThrow('planted-io');
  });
});
