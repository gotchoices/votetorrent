/**
 * Boot sweep of the retired dashboard sign-in code storage.
 *
 * Builds before this change could stage a dashboard sign-in code on the phone. They kept it under
 * two AsyncStorage keys: the staged code record (a bearer code secret, its digest and lookup id
 * and, on some older builds, a whole copy of the local database) and a pending-revoke marker
 * (the lookup id and its expiry). The retired dashboard sign-in code store that wrote them is
 * gone, and nothing reads either key any more, so on an upgraded phone they would sit in plain
 * app storage forever.
 *
 * The sweep removes both keys BLINDLY. It never reads a value: the record can hold a bearer secret
 * and a whole-database payload, so no byte of it is ever loaded into memory, logged, echoed or
 * put into an error. It never throws and never logs; a storage failure resolves `'failed'`, and
 * the caller decides what to say. Removing absent keys is a no-op, so it is safe to run on every
 * boot.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Exactly the two keys the retired store wrote. */
export const RETIRED_DASHBOARD_CODE_STORAGE_KEYS = Object.freeze([
	'votetorrent.dashboardBootstrap.stagedCode',
	'votetorrent.dashboardBootstrap.pendingRevoke',
] as const);

export type RetiredDashboardCodeSweepOutcome = 'removed' | 'failed';

/** Removes both retired keys. Resolves `'removed'` (also when they were absent) or `'failed'`; never rejects. */
export async function sweepRetiredDashboardCodeStorage(): Promise<RetiredDashboardCodeSweepOutcome> {
	try {
		await AsyncStorage.multiRemove([...RETIRED_DASHBOARD_CODE_STORAGE_KEYS]);
		return 'removed';
	} catch {
		return 'failed';
	}
}
