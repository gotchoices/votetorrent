import type { InviteStatus, KeyholderDkgStatus, SentKeyholderInvite } from '@votetorrent/vote-core';

/**
 * Maps the engine's `overdueUserIds` to the names shown in the overdue notice.
 *
 * The flag is advisory: the engine computes it at the status read (injected time, per-round deadline) and no
 * automatic action follows. The viewing keyholder's own id (`status.self.userId`) is dropped, so nobody is told
 * they are overdue on their own screen; their own state is the Key Generation row. Pure: no React, no i18n; the
 * caller passes the translated fallback for an id that matches no listed keyholder or has no name.
 */
export function overdueKeyholderLabels(
	status: KeyholderDkgStatus | null,
	keyholders: ReadonlyArray<InviteStatus<SentKeyholderInvite>>,
	unnamedLabel: string
): string[] {
	const ids = status?.overdueUserIds;
	if (!status || !ids || ids.length === 0) return [];
	if (status.phase === 'complete' || status.phase === 'failed' || status.phase === 'blocked') return [];
	const selfId = status.self?.userId;
	const names: string[] = [];
	let unmatched = 0;
	for (const id of new Set(ids)) {
		if (id === selfId) continue;
		const match = keyholders.find((k) => k.result?.invokedId === id);
		const name = match?.invite?.name;
		if (name) names.push(name);
		else unmatched += 1;
	}
	names.sort((a, b) => a.localeCompare(b));
	for (let i = 0; i < unmatched; i += 1) names.push(unnamedLabel);
	return names;
}
