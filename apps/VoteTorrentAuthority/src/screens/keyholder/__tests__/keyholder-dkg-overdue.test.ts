/**
 * keyholder-dkg-overdue.test.ts: the pure mapping from the engine's overdue ids to keyholder names.
 */
import type { InviteStatus, KeyholderDkgStatus, SentKeyholderInvite } from '@votetorrent/vote-core';
import { overdueKeyholderLabels } from '../keyholder-dkg-overdue';

const kh = (name: string | undefined, id?: string) =>
  ({ invite: name === undefined ? undefined : { name }, result: id ? { invokedId: id } : undefined }) as unknown as InviteStatus<SentKeyholderInvite>;
const status = (over: Record<string, unknown>) => ({ phase: 'in-progress', ...over }) as unknown as KeyholderDkgStatus;
const KEYHOLDERS = [kh('Bea', 'u-b'), kh('Ana', 'u-a')];

describe('overdueKeyholderLabels', () => {
  it('H1 names matched keyholders sorted, then one fallback per unmatched id', () => {
    expect(overdueKeyholderLabels(status({ overdueUserIds: ['u-b', 'u-c'] }), KEYHOLDERS, 'UNNAMED')).toEqual(['Bea', 'UNNAMED']);
  });
  it('H1b sorts listed names', () => {
    expect(overdueKeyholderLabels(status({ overdueUserIds: ['u-b', 'u-a'] }), KEYHOLDERS, 'UNNAMED')).toEqual(['Ana', 'Bea']);
  });
  it('H2 null, absent and empty give []', () => {
    expect(overdueKeyholderLabels(null, KEYHOLDERS, 'U')).toEqual([]);
    expect(overdueKeyholderLabels(status({}), KEYHOLDERS, 'U')).toEqual([]);
    expect(overdueKeyholderLabels(status({ overdueUserIds: [] }), KEYHOLDERS, 'U')).toEqual([]);
  });
  it.each(['complete', 'failed', 'blocked'])('H3 phase %s gives []', (phase) => {
    expect(overdueKeyholderLabels(status({ phase, overdueUserIds: ['u-b'] }), KEYHOLDERS, 'U')).toEqual([]);
  });
  it('H4 empty name uses the fallback; duplicate ids give one entry', () => {
    expect(overdueKeyholderLabels(status({ overdueUserIds: ['u-x'] }), [kh('', 'u-x')], 'U')).toEqual(['U']);
    expect(overdueKeyholderLabels(status({ overdueUserIds: ['u-b', 'u-b'] }), KEYHOLDERS, 'U')).toEqual(['Bea']);
  });
  it('H5 the viewing keyholder is never flagged to themselves', () => {
    expect(
      overdueKeyholderLabels(status({ self: { userId: 'u-b' }, overdueUserIds: ['u-b', 'u-c'] }), KEYHOLDERS, 'UNNAMED')
    ).toEqual(['UNNAMED']);
  });
});
