/**
 * keyholder-accept.test.ts — Phase 62 Plan 26 (D-21, D-26). Real-schema tests for
 * `acceptKeyholderInvitation`, over `@votetorrent/vote-engine/rn`'s real `InvitationEngine` and
 * the mapped `@votetorrent/vote-engine/test/fixtures/test-context` helpers — the same recipe
 * `keyholder-dkg-binding.spec.ts` (62-02) and `keyholder-identity.spec.ts` (62-09) use.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { InvitationEngine } from '@votetorrent/vote-engine/rn';
import {
	addTestAuthority,
	addTestElection,
	createTestNetwork,
	makeTestSignCallback,
} from '@votetorrent/vote-engine/test/fixtures/test-context';
import type { KeyholderInvite } from '@votetorrent/vote-core';
import { createAuthorityKeyVault } from '../../../engines/key-vault';
import { VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, keyholderVaultPrompt } from '../../../engines/keyholder-vault';
import { createFakeSecretWrapper, createMapStorage } from '../../../engines/__fixtures__/fake-secret-wrapper';
import { listKeyholderIdentities } from '../../../engines/keyholder-identity';
import type { KeyVaultStorage } from '../../../engines/key-vault';
import { acceptKeyholderInvitation } from '../keyholder-accept';
import { InviteShareError, inviteShareErrorKey } from '../../invitations/invite-share';

/**
 * A keyholder's own device context: the same strand db, no officer identity. The keyholder who accepts is never
 * the inviting officer (self-invite refusal, 62-103), so every 'k' accept runs on this context; slot creation
 * and reads may keep the inviter's context.
 */
const inviteeCtx = <C extends { db: unknown }>(ctx: C): C => ({ db: ctx.db }) as unknown as C;

async function seedElection() {
	const net = await createTestNetwork();
	const auth = await addTestAuthority(net);
	const { electionEngine, electionsEngine } = await addTestElection(auth);
	return { auth, electionEngine, electionsEngine };
}

function makeKeyholderInvite(name: string, inviteKey: string): KeyholderInvite {
	return {
		name,
		type: 'k',
		expiration: new Date(Date.now() + 3_600_000).toISOString(),
		inviteKey,
		inviteSignature: '',
	};
}

/** A fresh share in the exact onSend shape; the share is built WITHOUT any DB Cid query. */
function makeShare(name: string, type: 'k' | 'of' = 'k') {
	const priv = secp256k1.utils.randomSecretKey();
	const invitePrivate = bytesToHex(priv);
	const inviteKey = bytesToHex(secp256k1.getPublicKey(priv));
	return { invitePrivate, inviteKey, text: JSON.stringify({ invitePrivate, inviteKey, expiration: 'x', type, name }) };
}

/** Sends a real keyholder invite and returns the share text. The slot Cid is read ONLY for assertions. */
async function inviteKeyholder(seeded: Awaited<ReturnType<typeof seedElection>>, name: string): Promise<{ shareText: string; slotCid: string }> {
	const share = makeShare(name);
	const electionId = (await seeded.electionEngine.getElectionDetails()).election.id;
	await seeded.electionEngine.inviteKeyholder(makeKeyholderInvite(name, share.inviteKey), electionId, makeTestSignCallback(seeded.auth.user));
	const slotRow = await seeded.auth.ctx.db.prepare("select Cid from InviteSlot where Type = 'k' and Name = :name").get({ name });
	return { shareText: share.text, slotCid: slotRow!.Cid as string };
}

/** The status a committed accept reads back: the slot's result is an acceptance invoking `userId`. */
function committedStatus(userId: string) {
	return { invite: { name: 'held' }, result: { isAccepted: true, invitationSignature: '', invokedId: userId } };
}

function makeVaultHarness() {
	const wrapper = createFakeSecretWrapper();
	const vault = createAuthorityKeyVault({
		wrapper,
		storage: createMapStorage() as unknown as KeyVaultStorage,
		authRequiredWrap: { keyAlias: VOTETORRENT_AUTHORITY_KEYHOLDER_SHARE_WRAP_KEY_V1, prompt: keyholderVaultPrompt },
	});
	const storage = createMapStorage();
	return { wrapper, vault, storage };
}

describe('acceptKeyholderInvitation (D-21/D-26, real schema)', () => {
	it('A1/A6: accept writes InviteResult/User/UserKey/Keyholder/KeyholderDkgBinding atomically, with the exact 6-arg call shape, from the share string alone', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Alice');
		const { vault, storage } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		const result = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);

		const irCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from InviteResult where SlotCid = :cid').get({ cid: slotCid }))!.c as number;
		expect(irCount).toBe(1);
		const userCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from User where Id = :id').get({ id: result.userId }))!.c as number;
		expect(userCount).toBe(1);
		const keyCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from UserKey where UserId = :id').get({ id: result.userId }))!.c as number;
		expect(keyCount).toBe(1);
		const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder where UserId = :id').get({ id: result.userId }))!.c as number;
		expect(khCount).toBe(1);
		const bindingRow = (await seeded.auth.ctx.db
			.prepare('select DkgPublicKey, SignerKey, InviteSlotCid from KeyholderDkgBinding where UserId = :id')
			.get({ id: result.userId })) as { DkgPublicKey: string; SignerKey: string; InviteSlotCid: string };
		const record = (await listKeyholderIdentities(storage)).find((r) => r.userId === result.userId)!;
		expect(bindingRow.DkgPublicKey).toBe(record.dkgReceivingPublicKey);
		expect(bindingRow.SignerKey).toBe(record.signingPublicKey);
		expect(bindingRow.InviteSlotCid).toBe(slotCid);
	});

	it('A2: two devices take two distinct seats of one election; a second seat on the same device is refused before any prompt', async () => {
		const seeded = await seedElection();
		const Alice = await inviteKeyholder(seeded, 'Alice');
		const Carol = await inviteKeyholder(seeded, 'Carol');
		const Dana = await inviteKeyholder(seeded, 'Dana');
		const h1 = makeVaultHarness();
		const h2 = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		const alice = await acceptKeyholderInvitation({ invitationEngine, vault: h1.vault, storage: h1.storage }, Alice.shareText);
		const carol = await acceptKeyholderInvitation({ invitationEngine, vault: h2.vault, storage: h2.storage }, Carol.shareText);

		expect(alice.userId).not.toBe(seeded.auth.user.id);
		expect(alice.userId).not.toBe(carol.userId);
		const officerKeys = seeded.auth.user.activeKeys.map((k: { key: string }) => k.key);
		for (const storage of [h1.storage, h2.storage]) {
			const identities = await listKeyholderIdentities(storage);
			expect(identities).toHaveLength(1);
			expect(officerKeys).not.toContain(identities[0]!.signingPublicKey);
		}

		const before = h1.wrapper.authWraps;
		await expect(
			acceptKeyholderInvitation({ invitationEngine, vault: h1.vault, storage: h1.storage }, Dana.shareText)
		).rejects.toMatchObject({ code: 'seat-already-held' });
		expect(h1.wrapper.authWraps).toBe(before);
		expect(await listKeyholderIdentities(h1.storage)).toHaveLength(1);
	});

	describe('one seat per device per election, never the inviter (seat pre-checks)', () => {
		const stubEngine = (
			seats: Record<string, { electionId: string; selfInvite: boolean } | undefined>,
			statuses: Record<string, unknown> = {}
		) => {
			const respondToInvite = jest.fn(async () => undefined);
			return {
				respondToInvite,
				engine: {
					resolveInviteSlot: jest.fn(async () => ({ status: 'live', cid: 'new-slot' })),
					respondToInvite,
					getKeyholderInvite: jest.fn(async (cid: string) => statuses[cid] as never),
					getKeyholderSlotSeat: jest.fn(async (cid: string) => seats[cid]),
				},
			};
		};

		it('refuses self-invite before provisioning', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			const { engine, respondToInvite } = stubEngine({ 'new-slot': { electionId: 'e1', selfInvite: true } });
			await expect(acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text)).rejects.toMatchObject({
				code: 'self-invite',
			});
			expect(wrapper.authWraps).toBe(0);
			expect(await listKeyholderIdentities(storage)).toHaveLength(0);
			expect(respondToInvite).not.toHaveBeenCalled();
		});

		it('refuses a second seat of the same election with 0 wraps', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			await storage.setItem(
				'vt.keyholder-identities.v1',
				JSON.stringify({ v: 1, identities: [{ userId: 'u-held', inviteSlotCid: 'held-slot' }] })
			);
			const { engine, respondToInvite } = stubEngine(
				{
					'new-slot': { electionId: 'e1', selfInvite: false },
					'held-slot': { electionId: 'e1', selfInvite: false },
				},
				{ 'held-slot': committedStatus('u-held') }
			);
			await expect(acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text)).rejects.toMatchObject({
				code: 'seat-already-held',
			});
			expect(wrapper.authWraps).toBe(0);
			expect(respondToInvite).not.toHaveBeenCalled();
		});

		it('an orphan whose slot is still unanswered is never a seat: the accept proceeds and the orphan is kept', async () => {
			const { vault, storage } = makeVaultHarness();
			await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [{ userId: 'u-orphan', inviteSlotCid: 'held-slot' }] }));
			const { engine, respondToInvite } = stubEngine(
				{
					'new-slot': { electionId: 'e1', selfInvite: false },
					'held-slot': { electionId: 'e1', selfInvite: false },
				},
				{ 'held-slot': { invite: { name: 'held' } } }
			);
			await acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text);
			expect(respondToInvite).toHaveBeenCalledTimes(1);
			const ids = (await listKeyholderIdentities(storage)).map((r) => r.userId);
			expect(ids).toContain('u-orphan');
			expect(ids).toHaveLength(2);
		});

		it.each([
			['answered by another identity', { invite: { name: 'held' }, result: { isAccepted: true, invitationSignature: '', invokedId: 'u-other' } }],
			['declined', { invite: { name: 'held' }, result: { isAccepted: false, invitationSignature: '' } }],
		])('an orphan whose slot was %s is discarded and the accept proceeds', async (_name, status) => {
			const { vault, storage } = makeVaultHarness();
			await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [{ userId: 'u-orphan', inviteSlotCid: 'held-slot' }] }));
			const { engine, respondToInvite } = stubEngine(
				{
					'new-slot': { electionId: 'e1', selfInvite: false },
					'held-slot': { electionId: 'e1', selfInvite: false },
				},
				{ 'held-slot': status }
			);
			await acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text);
			expect(respondToInvite).toHaveBeenCalledTimes(1);
			const ids = (await listKeyholderIdentities(storage)).map((r) => r.userId);
			expect(ids).not.toContain('u-orphan');
			expect(ids).toHaveLength(1);
		});

		it('a failing status read of a held same-election slot propagates with 0 wraps and discards nothing', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [{ userId: 'u-held', inviteSlotCid: 'held-slot' }] }));
			const { engine, respondToInvite } = stubEngine({
				'new-slot': { electionId: 'e1', selfInvite: false },
				'held-slot': { electionId: 'e1', selfInvite: false },
			});
			engine.getKeyholderInvite = jest.fn(async (cid: string) => {
				if (cid === 'held-slot') throw new Error('status read down');
				return undefined as never;
			});
			await expect(acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text)).rejects.toThrow(
				'status read down'
			);
			expect(wrapper.authWraps).toBe(0);
			expect(respondToInvite).not.toHaveBeenCalled();
			expect((await listKeyholderIdentities(storage)).map((r) => r.userId)).toEqual(['u-held']);
		});

		it('a held seat of another election, or of an unknown slot, does not block', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			await storage.setItem(
				'vt.keyholder-identities.v1',
				JSON.stringify({
					v: 1,
					identities: [
						{ userId: 'u-a', inviteSlotCid: 'other-election' },
						{ userId: 'u-b', inviteSlotCid: 'other-network' },
					],
				})
			);
			const { engine, respondToInvite } = stubEngine({
				'new-slot': { electionId: 'e1', selfInvite: false },
				'other-election': { electionId: 'e2', selfInvite: false },
				'other-network': undefined,
			});
			await acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text);
			expect(respondToInvite).toHaveBeenCalledTimes(1);
			expect(wrapper.authWraps).toBe(2);
		});

		it('an unreadable new slot rejects not-found before provisioning', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			const { engine } = stubEngine({});
			await expect(acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text)).rejects.toMatchObject({
				code: 'not-found',
			});
			expect(wrapper.authWraps).toBe(0);
		});

		it('a seat-lookup rejection propagates without provisioning', async () => {
			const { vault, storage, wrapper } = makeVaultHarness();
			const { engine } = stubEngine({});
			engine.getKeyholderSlotSeat = jest.fn(async (_cid: string): Promise<{ electionId: string; selfInvite: boolean } | undefined> => {
				throw new Error('seat lookup down');
			});
			await expect(acceptKeyholderInvitation({ invitationEngine: engine as never, vault, storage }, makeShare('Zed').text)).rejects.toThrow(
				'seat lookup down'
			);
			expect(wrapper.authWraps).toBe(0);
		});
	});

	describe('re-accept after a revision change: a held seat is released only on positive proof (A1-A4)', () => {
		type Facts = { revision: number | null; liveRoster?: string[]; earlierRevisionUserIds?: string[] } | undefined;
		const U = 'u-held';

		async function run(reader: ((electionId: string) => Promise<Facts>) | undefined, held = true) {
			const { vault, storage, wrapper } = makeVaultHarness();
			if (held) {
				await storage.setItem('vt.keyholder-identities.v1', JSON.stringify({ v: 1, identities: [{ userId: U, inviteSlotCid: 'held-slot' }] }));
			}
			const respondToInvite = jest.fn(async () => undefined);
			const engine = {
				resolveInviteSlot: jest.fn(async () => ({ status: 'live', cid: 'new-slot' })),
				respondToInvite,
				getKeyholderInvite: jest.fn(async (cid: string) => (cid === 'held-slot' ? committedStatus(U) : undefined)),
				getKeyholderSlotSeat: jest.fn(async (cid: string) => ({ electionId: 'e1', selfInvite: false, cid })),
			};
			const deps = { invitationEngine: engine as never, vault, storage, ...(reader ? { readKeyholderSeatFacts: reader } : {}) };
			return { promise: acceptKeyholderInvitation(deps, makeShare('Zed').text), respondToInvite, wrapper };
		}

		it('A1: earlier-revision proof (revision read, absent from liveRoster, present in earlierRevisionUserIds) lets the accept proceed', async () => {
			const reader = jest.fn(async () => ({ revision: 1, liveRoster: ['other'], earlierRevisionUserIds: [U] }));
			const { promise, respondToInvite } = await run(reader);
			await promise;
			expect(respondToInvite).toHaveBeenCalledTimes(1);
			expect(reader).toHaveBeenCalledTimes(1);
			expect(reader).toHaveBeenCalledWith('e1');
		});

		it('A2: a held id in the live roster refuses with 0 wraps', async () => {
			const { promise, respondToInvite, wrapper } = await run(async () => ({ revision: 1, liveRoster: [U], earlierRevisionUserIds: [] }));
			await expect(promise).rejects.toMatchObject({ code: 'seat-already-held' });
			expect(wrapper.authWraps).toBe(0);
			expect(respondToInvite).not.toHaveBeenCalled();
		});

		const refusals: Array<[string, ((electionId: string) => Promise<Facts>) | undefined]> = [
			['revision null with empty lists', async () => ({ revision: null, liveRoster: [], earlierRevisionUserIds: [] })],
			['liveRoster undefined', async () => ({ revision: 1, liveRoster: undefined, earlierRevisionUserIds: [U] })],
			['earlierRevisionUserIds undefined', async () => ({ revision: 1, liveRoster: [], earlierRevisionUserIds: undefined })],
			['held id in neither list', async () => ({ revision: 1, liveRoster: [], earlierRevisionUserIds: [] })],
			['reader absent', undefined],
			['reader resolves undefined', async () => undefined],
			['reader rejects', async () => { throw new Error('status down'); }],
		];
		it.each(refusals)('A3: fail closed when %s', async (_name, reader) => {
			const { promise, respondToInvite, wrapper } = await run(reader);
			await expect(promise).rejects.toMatchObject({ code: 'seat-already-held' });
			expect(wrapper.authWraps).toBe(0);
			expect(respondToInvite).not.toHaveBeenCalled();
		});

		it('A4: with no held identity of the same election the reader is never called', async () => {
			const reader = jest.fn(async () => ({ revision: 1, liveRoster: [], earlierRevisionUserIds: [] }));
			const { promise, respondToInvite } = await run(reader, false);
			await promise;
			expect(reader).not.toHaveBeenCalled();
			expect(respondToInvite).toHaveBeenCalledTimes(1);
		});
	});

	it('A3: a failure before any write rejects with the original error and leaves nothing behind', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Dana');
		const { vault, storage } = makeVaultHarness();
		const failingEngine = {
			resolveInviteSlot: jest.fn(async (k: string, t: 'k') => new InvitationEngine(inviteeCtx(seeded.auth.ctx)).resolveInviteSlot(k, t)),
			respondToInvite: jest.fn(async () => {
				throw new Error('bad invitePrivate');
			}),
			getKeyholderInvite: jest.fn(async () => undefined),
			getKeyholderSlotSeat: jest.fn(async (id: string) => new InvitationEngine(inviteeCtx(seeded.auth.ctx)).getKeyholderSlotSeat(id)),
		};

		await expect(acceptKeyholderInvitation({ invitationEngine: failingEngine as never, vault, storage }, shareText)).rejects.toThrow(
			'bad invitePrivate'
		);

		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
		const khCount = (await seeded.auth.ctx.db.prepare('select count(*) as c from Keyholder').get())!.c as number;
		expect(khCount).toBe(0);
	});

	it('A4: a failure AFTER commit (reconcile) resolves success and keeps the keys', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Erin');
		const { vault, storage } = makeVaultHarness();
		const realEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
		let committedUserId: string | undefined;
		const reconcileEngine = {
			resolveInviteSlot: jest.fn(async (k: string, t: 'k') => realEngine.resolveInviteSlot(k, t)),
			respondToInvite: jest.fn(async (...args: Parameters<InvitationEngine['respondToInvite']>) => {
				committedUserId = args[4];
				await realEngine.respondToInvite(...args);
				throw new Error('post-commit transport hiccup');
			}),
			getKeyholderInvite: jest.fn(async (id: string) => realEngine.getKeyholderInvite(id)),
			getKeyholderSlotSeat: jest.fn(async (id: string) => realEngine.getKeyholderSlotSeat(id)),
		};

		const result = await acceptKeyholderInvitation({ invitationEngine: reconcileEngine as never, vault, storage }, shareText);

		expect(result.userId).toBe(committedUserId);
		expect(await vault.hasSecret(`vt.keyholder-signing.${result.userId}`)).toBe(true);
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);
	});

	it('A5: a failure whose reconcile re-read ALSO rejects rethrows the original error and discards nothing', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Frank');
		const { vault, storage } = makeVaultHarness();
		let statusCalls = 0;
		const unknownOutcomeEngine = {
			resolveInviteSlot: jest.fn(async (k: string, t: 'k') => new InvitationEngine(inviteeCtx(seeded.auth.ctx)).resolveInviteSlot(k, t)),
			respondToInvite: jest.fn(async () => {
				throw new Error('original failure');
			}),
			// The first read is the answered-slot pre-check (must succeed); the reconcile re-read fails.
			getKeyholderInvite: jest.fn(async (id: string) => {
				if (++statusCalls === 1) return new InvitationEngine(inviteeCtx(seeded.auth.ctx)).getKeyholderInvite(id);
				throw new Error('re-read also failed');
			}),
			getKeyholderSlotSeat: jest.fn(async (id: string) => new InvitationEngine(inviteeCtx(seeded.auth.ctx)).getKeyholderSlotSeat(id)),
		};

		await expect(
			acceptKeyholderInvitation({ invitationEngine: unknownOutcomeEngine as never, vault, storage }, shareText)
		).rejects.toThrow('original failure');

		// Unknown outcome — nothing is discarded.
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);
	});

	it('A5b: re-accepting after a respond + re-read double failure succeeds; the orphan never counts as a seat and is discarded once its slot is answered', async () => {
		const seeded = await seedElection();
		const Frank = await inviteKeyholder(seeded, 'Frank');
		const Gail = await inviteKeyholder(seeded, 'Gail');
		const { vault, storage } = makeVaultHarness();
		const realEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
		let statusCalls = 0;
		const outageEngine = {
			resolveInviteSlot: jest.fn(async (k: string, t: 'k') => realEngine.resolveInviteSlot(k, t)),
			respondToInvite: jest.fn(async () => {
				throw new Error('peers unreachable (write)');
			}),
			getKeyholderInvite: jest.fn(async (id: string) => {
				if (++statusCalls === 1) return realEngine.getKeyholderInvite(id);
				throw new Error('peers unreachable (read)');
			}),
			getKeyholderSlotSeat: jest.fn(async (id: string) => realEngine.getKeyholderSlotSeat(id)),
		};

		// 1. Unknown outcome: the identity is kept.
		await expect(acceptKeyholderInvitation({ invitationEngine: outageEngine as never, vault, storage }, Frank.shareText)).rejects.toThrow(
			'peers unreachable (write)'
		);
		const [orphan] = await listKeyholderIdentities(storage);
		expect(orphan).toBeDefined();

		// 2. Connectivity returns: the same invitation is accepted, not refused seat-already-held.
		const accepted = await acceptKeyholderInvitation({ invitationEngine: realEngine, vault, storage }, Frank.shareText);
		expect(accepted.userId).not.toBe(orphan!.userId);
		expect(accepted.slotCid).toBe(Frank.slotCid);

		// 3. A second seat of the same election is still refused, and the now-answered orphan is discarded on the way.
		await expect(acceptKeyholderInvitation({ invitationEngine: realEngine, vault, storage }, Gail.shareText)).rejects.toMatchObject({
			code: 'seat-already-held',
		});
		expect((await listKeyholderIdentities(storage)).map((r) => r.userId)).toEqual([accepted.userId]);
		expect(await vault.hasSecret(`vt.keyholder-signing.${orphan!.userId}`)).toBe(false);
		expect(await vault.hasSecret(`vt.keyholder-signing.${accepted.userId}`)).toBe(true);
	});

	it('A6: the engine receives exactly (slotCid, true, invitePrivate, undefined, userId, provisioning), and release() has run by the time the promise settles', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Hank');
		const { vault, storage } = makeVaultHarness();
		const realEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));
		let capturedArgs: unknown[] | undefined;
		const capturingEngine = {
			resolveInviteSlot: jest.fn(async (k: string, t: 'k') => realEngine.resolveInviteSlot(k, t)),
			respondToInvite: jest.fn(async (...args: Parameters<InvitationEngine['respondToInvite']>) => {
				capturedArgs = args;
				return realEngine.respondToInvite(...args);
			}),
			getKeyholderInvite: jest.fn(async (id: string) => realEngine.getKeyholderInvite(id)),
			getKeyholderSlotSeat: jest.fn(async (id: string) => realEngine.getKeyholderSlotSeat(id)),
		};

		const result = await acceptKeyholderInvitation({ invitationEngine: capturingEngine as never, vault, storage }, shareText);

		expect(capturedArgs).toHaveLength(6);
		expect(capturedArgs![0]).toBe(slotCid);
		expect(capturedArgs![1]).toBe(true);
		expect(typeof capturedArgs![2]).toBe('string');
		expect(capturedArgs![3]).toBeUndefined();
		expect(capturedArgs![4]).toBe(result.userId);
		const provisioning = capturedArgs![5] as { sign: (digest: Uint8Array) => Promise<unknown> };
		await expect(provisioning.sign(new Uint8Array(32))).rejects.toMatchObject({ code: 'signing-key-missing' });
	});

	it('A7 budget: one accept performs exactly 2 auth-required wraps and 0 unwraps', async () => {
		const seeded = await seedElection();
		const { shareText, slotCid } = await inviteKeyholder(seeded, 'Grace');
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);

		expect(wrapper.authWraps).toBe(2);
		expect(wrapper.authUnwraps).toBe(0);
	});

	it('A8: a share for an invite that does not exist rejects not-found with 0 auth wraps and 0 identities', async () => {
		const seeded = await seedElection();
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		const err = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, makeShare('Ghost').text).catch((e) => e);

		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('not-found');
		expect(wrapper.authWraps).toBe(0);
		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
	});

	it('A9: an officer share pasted into keyholder accept rejects wrong-type with 0 wraps', async () => {
		const seeded = await seedElection();
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		await expect(
			acceptKeyholderInvitation({ invitationEngine, vault, storage }, makeShare('Officer', 'of').text)
		).rejects.toMatchObject({ code: 'wrong-type' });

		expect(wrapper.authWraps).toBe(0);
		expect(await listKeyholderIdentities(storage)).toHaveLength(0);
	});

	it('A10: re-accepting an ALREADY-ANSWERED slot rejects already-answered with 0 further wraps and 0 further identities', async () => {
		const seeded = await seedElection();
		const { shareText } = await inviteKeyholder(seeded, 'Kay Two');
		const { vault, storage, wrapper } = makeVaultHarness();
		const invitationEngine = new InvitationEngine(inviteeCtx(seeded.auth.ctx));

		await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText);
		expect(wrapper.authWraps).toBe(2);
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);

		const err = await acceptKeyholderInvitation({ invitationEngine, vault, storage }, shareText).catch((e) => e);

		expect(err).toBeInstanceOf(InviteShareError);
		expect(err.code).toBe('already-answered');
		expect(inviteShareErrorKey(err)).toBe('invitationAcceptAlreadyAnswered');
		expect(wrapper.authWraps).toBe(2);
		expect(await listKeyholderIdentities(storage)).toHaveLength(1);
	});
});
