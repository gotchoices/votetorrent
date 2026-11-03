import { Database, MisuseError, QuereusError } from '@quereus/quereus';
import { NetworkEngine } from '../network/network-engine.js';
import { H16, fromCanonicalDatetime, nowCanonicalDatetime, toCanonicalDatetime } from '../utils.js';
import type { EngineContext } from '../types.js';
import type { DbFactory } from '../types.js';
import type {
	LocalStorage,
	INetworkEngine,
	NetworkInit,
	NetworkReference,
	User,
	FoundingBundleExporter,
	FoundingBundleExport,
	FoundingBundleImportOptions,
	FoundingBundleImportResult,
	FoundingBundleInspection,
	FoundingBundleRows,
	FoundingAnchor,
	FoundingAnchorFounder,
	JoinFromStrandOptions,
	JoinFromStrandResult,
	NetworkJoinAnchor,
} from '@votetorrent/vote-core';
import type {
	INetworksEngine,
	INetworksCreateBuilder,
} from '@votetorrent/vote-core';

import {
	registerDbPlugins,
	initDB,
	isSchemaInitialized,
	markSchemaInitialized,
	ensureTidSequence,
	declareViewsInMain,
	prepareDb,
} from '../database/initialize.js';
import { allocateTid } from '../database/tid-allocator.js';
import { NetworksCreateBuilder } from './builders/index.js';
import {
	FOUNDING_BUNDLE_TABLE_ORDER,
	readGenesisRows,
	replayGenesisRows,
	type GenesisRowKeys,
} from './genesis-rows.js';
import {
	FOUNDING_BUNDLE_FORMAT,
	FOUNDING_BUNDLE_FORMAT_VERSION,
	FOUNDING_FAILURE_CATEGORY,
	FoundingBundleExportError,
	deriveFoundingDescriptor,
	foundingBundleFingerprint,
	foundingBundleSigningDigest,
	parseFoundingBundle,
	serializeFoundingBundle,
	verifyFoundingBundle,
} from './founding-bundle.js';
import { buildManifest, computeContentDigest, computeSchemaHash } from '../bootstrap/snapshot-manifest.js';
import type { SnapshotTables } from '../bootstrap/snapshot-types.js';

// D-02: default in-memory factory — keeps all 581 existing tests passing unchanged.
// Lives at module scope (not inside the class) so it is a stable default parameter.
const inMemoryFactory: DbFactory = async (_hash: string) => new Database();

/**
 * 62-16: parse the violated CHECK constraint's name out of a Quereus error
 * thrown by a genesis-row replay — the only detail `importFoundingBundle`'s
 * `replay-rejected` result carries (never a row or column value, matching
 * the detail-string discipline `founding-bundle.ts` uses). Quereus's own
 * constraint-violation text is `CHECK constraint failed: <name>[ (...)]`
 * (row-constraints.js / deferred-constraint-queue.js / view-mutation-builder.js).
 */
function extractConstraintName(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const match = /CHECK constraint failed:\s*([A-Za-z0-9_]+)/.exec(message);
	return match?.[1] ?? 'unknown constraint';
}

export class NetworksEngine implements INetworksEngine {
	// D-07: per-instance hash→EngineContext cache.
	// Lifetime is bound to this NetworksEngine instance (AppProvider owns one).
	// D-11: no eviction in v1.0 — revisit at the v2 persistence milestone.
	private readonly contexts = new Map<string, EngineContext>();

	constructor(
		private readonly localStorage: LocalStorage,
		private readonly dbFactory: DbFactory = inMemoryFactory,
	) {}

	async clearRecentNetworks(): Promise<void> {
		// WR-04: await the async storage write so callers observe a settled state.
		await this.localStorage.removeItem('recentNetworks');
	}

	async create(networkInit: NetworkInit, user: User): Promise<INetworkEngine> {
		// Compute networkHash early so we can pass it to createContext (D-01).
		const networkId = crypto.randomUUID().toString();
		const networkHash = H16(networkId);

		let ctx: EngineContext;
		try {
			ctx = await this.createContext(user, networkHash);
		} catch (error) {
			throw new Error('Failed to create database context: ' + error);
		}

		// Prepare json fields
		const networkImageRefJson = storedImageRefJson(networkInit.imageUrl, networkInit.imageCid);
		const primaryAuthorityImageRefJson = storedImageRefJson(
			networkInit.primaryAuthority.imageUrl,
			networkInit.primaryAuthority.imageCid,
		);
		const relaysJson = JSON.stringify(networkInit.relays ?? []);
		const tsaJson = JSON.stringify(
			networkInit.policies?.timestampAuthorities ?? [],
		);
		const numberRequiredTSAs = networkInit.policies?.numberRequiredTSAs ?? 0;
		const electionType = networkInit.policies?.electionType ?? null;
		const thresholdPolicies = JSON.stringify(
			networkInit.admin.thresholdPolicies ?? [],
		);
		const userImageRefJson = user?.imageRef?.url
			? JSON.stringify(user.imageRef)
			: null;

		const primaryAuthorityId = crypto.randomUUID().toString();

		const firstOfficer = networkInit.admin.officers?.[0];
		if (!firstOfficer?.init) {
			throw new Error('Failed to create network: Officer init is required');
		}
		const officerInit = firstOfficer.init;
		// The entered admin name is the founder's network display name (UAT 62 gap 4 item 5);
		// the provisioned device user's name is only a fallback.
		const founderName = officerInit.name?.trim() || user.name;
		const officerScopesJson = JSON.stringify(officerInit.scopes);

		const firstKey = user.activeKeys?.[0];
		if (!firstKey) {
			throw new Error('Failed to create network: User key is required');
		}

		// 999.1 D-02/D-09: shared durable allocator, 'networks' namespace —
		// reserve-before-use persist happens inside allocateTid, before the
		// db.exec(insert ...) below consumes the returned tid.
		const tid = await allocateTid(ctx.db, 'networks');

		const params = {
			networkId,
			networkHash,
			networkName: networkInit.name,
			networkImageRef: networkImageRefJson,
			relays: relaysJson,
			timestampAuthorities: tsaJson,
			numberRequiredTSAs,
			electionType: electionType.toString(),
			primaryAuthorityId,
			primaryAuthorityName: networkInit.primaryAuthority.name,
			primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
			primaryAuthorityImageRef: primaryAuthorityImageRefJson,
			adminEffectiveAt: toCanonicalDatetime(networkInit.admin.effectiveAt),
			thresholdPolicies,
			userId: user.id,
			title: officerInit.title,
			scopes: officerScopesJson,
			userName: founderName,
			userImageRef: userImageRefJson,
			// 49-02 bugfix: this was hardcoded to the literal string 'user' — a value
			// that is not any valid UserKeyType code ('M'/'Y'/'P') — so the founding
			// user's UserKey.Type never actually reflected the key's real curve. That
			// went unnoticed while every founding key was secp256k1 (any non-'P' value
			// happened to route UserKey.SignatureValid's curve-branch correctly by
			// accident), but a P-256 founding key would silently mis-dispatch to the
			// wrong verifier on its own SECOND key insert (D-02/D-03). Must be
			// `firstKey.type` — the actual UserKeyType code from the caller.
			keyType: firstKey.type,
			keyValue: firstKey.key,
			expiration: toCanonicalDatetime(firstKey.expiration),
			now: nowCanonicalDatetime(),
		};

		try {
			// Phase 12.2 split-batch fix: split the six INSERTs into three
			// sequential exec() calls so that Admin is committed before
			// Officer (Officer.AdminValid CHECK requires Admin to exist).
			// Defensive against future quereus versions that may evaluate
			// CHECKs eagerly per-INSERT rather than deferring to batch end.
			//
			// 1. User + UserKey + Authority + Admin (no cross-table forward deps)
			// 2. Officer (depends on Admin existing)
			// 3. Network (depends on Authority existing, committed in batch 1)

			await ctx.db.exec(
				`
				insert into User (
					Id,
					Name,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:userId, :userName, :userImageRef);

				-- 999.1 R-02/D-11 (999.1-08 audit): genuinely-first-key bootstrap for the network's
				-- founding user (context.UserKey = null) — satisfies UserKey.SignatureValid's
				-- bootstrap OR-branch (count(*) = 1 and context.UserKey is null) without a
				-- fabricated signature (Pitfall 3). IsSignatureValid stays true/inert: the schema
				-- CHECK no longer consumes it for UserKey, kept only for binding compatibility.
				insert into UserKey (
					UserId,
					Type,
					PubKey,
					Expiration
				)
				with context UserKey = null, Signature = null, Tid = ${tid}, now = :now, IsSignatureValid = true
				values (:userId, :keyType, :keyValue, :expiration);

				insert into Authority (
					Id,
					Name,
					DomainName,
					ImageRef
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :primaryAuthorityName, :primaryAuthorityDomainName, :primaryAuthorityImageRef);

				insert into Admin (
					AuthorityId,
					EffectiveAt,
					ThresholdPolicies
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :adminEffectiveAt, :thresholdPolicies);
				`,
				params,
			);

			await ctx.db.exec(
				`
				insert into Officer (
					AuthorityId,
					AdminEffectiveAt,
					UserId,
					Title,
					Scopes
				)
				with context SigningNonce = null, InviteSlotCid = null, InviteSignature = null, Tid = ${tid}
				values (:primaryAuthorityId, :adminEffectiveAt, :userId, :title, :scopes);
				`,
				params,
			);

			await ctx.db.exec(
				`
				insert into Network (
					Id,
					Hash,
					PrimaryAuthorityId,
					Name,
					ImageRef,
					Relays,
					TimestampAuthorities,
					NumberRequiredTSAs,
					ElectionType
				)
				with context SigningNonce = null, Tid = ${tid}
				values (
					:networkId,
					:networkHash,
					:primaryAuthorityId,
					:networkName,
					:networkImageRef,
					:relays,
					:timestampAuthorities,
					:numberRequiredTSAs,
					:electionType
				);
				`,
				params,
			);
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}

		// Cache the freshly-built EngineContext so subsequent open() calls return
		// a NetworkEngine bound to the same Database (single live handle, D-06).
		this.contexts.set(networkHash, ctx);

		// Update recent networks list
		const networkRef: NetworkReference = {
			hash: networkHash,
			imageUrl: networkInit.imageUrl,
			relays: networkInit.relays,
			name: networkInit.name,
			primaryAuthorityDomainName: networkInit.primaryAuthority.domainName,
		};
		const recentNetworks: NetworkReference[] =
			(await this.localStorage.getItem('recentNetworks')) ?? [];
		// WR-04: await so the recents write is durable before create() returns
		// (and before the persistence proof / AppProvider reads recentNetworks).
		await this.localStorage.setItem('recentNetworks', [
			...recentNetworks,
			networkRef,
		]);

		return this.open(networkRef, user, true);
	}

	/**
	 * D-35/62-16: export the network's founding bundle. Device A reads its own
	 * six founding rows verbatim, builds a signed, verified envelope, and
	 * returns it. Rejects with a `FoundingBundleExportError` (never a partial
	 * bundle) — see the named codes on `FoundingBundleExportErrorCode`.
	 */
	/**
	 * The six founding rows of an open network, selected by the founding
	 * officer's user id and key — the one read `exportFoundingBundle` and
	 * `getFoundingAnchor` share, with the same refusals.
	 */
	private async readFoundingRows(
		networkHash: string,
		founder: { readonly userId: string; readonly signerKey: string },
	): Promise<{ rows: FoundingBundleRows; genesis: GenesisRowKeys }> {
		const ctx = this.contexts.get(networkHash);
		if (!ctx) throw new FoundingBundleExportError('network-not-open');

		const networkRow = await ctx.db
			.prepare(
				'select Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType from Network',
			)
			.get({});
		if (!networkRow || networkRow.Hash !== networkHash) {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		const primaryAuthorityId = networkRow.PrimaryAuthorityId as string;

		const adminEffectiveAtRows: Array<{ EffectiveAt: unknown }> = [];
		for await (const row of ctx.db.eval(
			'select EffectiveAt from Admin where AuthorityId = :authorityId',
			{ authorityId: primaryAuthorityId },
		)) {
			adminEffectiveAtRows.push(row as { EffectiveAt: unknown });
		}
		// D-38: signed revisions carry no stored Tid, so they can never be
		// replayed with their original Tid — export refuses once the primary
		// authority's Admin has been revised (`admin-revised`).
		if (adminEffectiveAtRows.length > 1) {
			throw new FoundingBundleExportError('admin-revised');
		}
		if (adminEffectiveAtRows.length === 0) {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		const adminEffectiveAt = String(adminEffectiveAtRows[0]!.EffectiveAt);

		let rows: FoundingBundleRows;
		try {
			rows = await readGenesisRows(ctx.db, {
				userId: founder.userId,
				signerKey: founder.signerKey,
				authorityId: primaryAuthorityId,
				adminEffectiveAt,
			});
		} catch {
			throw new FoundingBundleExportError('genesis-unreadable');
		}

		if (rows.User.length === 0 || rows.Officer.length === 0) {
			throw new FoundingBundleExportError('not-founding-officer');
		}
		if (rows.Authority.length === 0 || rows.Admin.length === 0 || rows.Network.length === 0) {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		if (rows.UserKey.length === 0) {
			throw new FoundingBundleExportError('signer-key-invalid');
		}
		return {
			rows,
			genesis: { userId: founder.userId, signerKey: founder.signerKey, authorityId: primaryAuthorityId, adminEffectiveAt },
		};
	}

	/**
	 * Spike 100: the founding anchor a network join code carries — the same
	 * rows and digest `exportFoundingBundle` would bundle, but unsigned and
	 * without the rows themselves (the voter reads its own replicated copy).
	 */
	async getFoundingAnchor(networkHash: string, founder: FoundingAnchorFounder): Promise<FoundingAnchor> {
		const { rows, genesis } = await this.readFoundingRows(networkHash, founder);
		return this.anchorFromRows(rows, genesis);
	}

	/**
	 * R-C (D-22): the join anchor any officer's device can build, also after
	 * an Admin revision. It derives the founding generation from the
	 * replicated rows (see `resolveJoinGenesis`) instead of taking the
	 * founder's keys, and never refuses with `admin-revised` — that D-38
	 * refusal belongs to `getFoundingAnchor` / `exportFoundingBundle` only.
	 * Read-only: point lookups plus the shared genesis-row reader.
	 */
	async getJoinAnchor(networkHash: string): Promise<FoundingAnchor> {
		const ctx = this.contexts.get(networkHash);
		if (!ctx) throw new FoundingBundleExportError('network-not-open');

		const genesis = await this.resolveJoinGenesis(ctx, networkHash);

		let rows: FoundingBundleRows;
		try {
			rows = await readGenesisRows(ctx.db, genesis);
		} catch {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		if (rows.User.length === 0 || rows.Officer.length === 0) {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		if (rows.Authority.length === 0 || rows.Admin.length === 0 || rows.Network.length === 0) {
			throw new FoundingBundleExportError('genesis-unreadable');
		}
		if (rows.UserKey.length === 0) {
			throw new FoundingBundleExportError('signer-key-invalid');
		}
		return this.anchorFromRows(rows, genesis);
	}

	/**
	 * The founding generation's keys, from the replicated rows alone. The rule
	 * (the browser's founding check mirrors it): the primary authority's Admin
	 * row with the EARLIEST EffectiveAt; that generation's only Officer row;
	 * that user's UserKey with the earliest Expiration, ties by PubKey
	 * ascending. Two-key equality and single-key point predicates only (no IN
	 * list), so the Quereus AND+IN zero-row trap cannot apply.
	 */
	private async resolveJoinGenesis(ctx: EngineContext, networkHash: string): Promise<GenesisRowKeys> {
		const unreadable = () => new FoundingBundleExportError('genesis-unreadable');
		const instant = (value: unknown): number =>
			fromCanonicalDatetime(typeof value === 'number' ? value : String(value));

		let networkRow: Record<string, unknown> | undefined;
		try {
			networkRow = (await ctx.db
				.prepare(
					'select Id, Hash, PrimaryAuthorityId, Name, ImageRef, Relays, TimestampAuthorities, NumberRequiredTSAs, ElectionType from Network',
				)
				.get({})) as Record<string, unknown> | undefined;
		} catch {
			throw unreadable();
		}
		if (!networkRow || networkRow.Hash !== networkHash) throw unreadable();
		const authorityId = String(networkRow.PrimaryAuthorityId);

		const adminRows: Array<{ EffectiveAt: unknown }> = [];
		const officerRows: Array<{ UserId: unknown }> = [];
		const keyRows: Array<{ PubKey: unknown; Expiration: unknown }> = [];
		try {
			for await (const row of ctx.db.eval(
				'select EffectiveAt from Admin where AuthorityId = :authorityId',
				{ authorityId },
			)) {
				adminRows.push(row as { EffectiveAt: unknown });
			}
		} catch {
			throw unreadable();
		}
		if (adminRows.length === 0) throw unreadable();
		let founding = adminRows[0]!;
		let foundingAt = instant(founding.EffectiveAt);
		for (const row of adminRows) {
			const at = instant(row.EffectiveAt);
			if (!Number.isFinite(at)) throw unreadable();
			if (at < foundingAt) {
				founding = row;
				foundingAt = at;
			}
		}
		// Bind the chosen row's own stored text so the point lookups match it.
		const adminEffectiveAt = String(founding.EffectiveAt);

		try {
			for await (const row of ctx.db.eval(
				'select UserId from Officer where AuthorityId = :authorityId and AdminEffectiveAt = :adminEffectiveAt',
				{ authorityId, adminEffectiveAt },
			)) {
				officerRows.push(row as { UserId: unknown });
			}
		} catch {
			throw unreadable();
		}
		// create() writes exactly one founding officer.
		if (officerRows.length !== 1) throw unreadable();
		const userId = String(officerRows[0]!.UserId);

		try {
			for await (const row of ctx.db.eval(
				'select PubKey, Expiration from UserKey where UserId = :userId',
				{ userId },
			)) {
				keyRows.push(row as { PubKey: unknown; Expiration: unknown });
			}
		} catch {
			throw unreadable();
		}
		if (keyRows.length === 0) throw new FoundingBundleExportError('signer-key-invalid');
		const ranked = keyRows.map((row) => ({ pubKey: String(row.PubKey), expiresAt: instant(row.Expiration) }));
		if (ranked.some((row) => !Number.isFinite(row.expiresAt))) {
			throw new FoundingBundleExportError('signer-key-invalid');
		}
		ranked.sort((a, b) =>
			a.expiresAt !== b.expiresAt
				? a.expiresAt - b.expiresAt
				: a.pubKey < b.pubKey
					? -1
					: a.pubKey > b.pubKey
						? 1
						: 0,
		);
		return { userId, signerKey: ranked[0]!.pubKey, authorityId, adminEffectiveAt };
	}

	/** The anchor for a set of founding rows: what a join code embeds. */
	private anchorFromRows(rows: FoundingBundleRows, genesis: GenesisRowKeys): FoundingAnchor {
		const digest = computeContentDigest(rows as unknown as SnapshotTables);
		const descriptor = deriveFoundingDescriptor(rows);
		return {
			networkHash: descriptor.networkHash,
			name: descriptor.name,
			genesis,
			digest,
			fingerprint: foundingBundleFingerprint(digest),
		};
	}

	async exportFoundingBundle(
		networkHash: string,
		exporter: FoundingBundleExporter,
	): Promise<FoundingBundleExport> {
		const { rows } = await this.readFoundingRows(networkHash, exporter);
		const expiration = String(rows.UserKey[0]!.Expiration);
		if (!(expiration > nowCanonicalDatetime())) {
			throw new FoundingBundleExportError('signer-key-invalid');
		}

		const exportedAt = nowCanonicalDatetime();
		const schemaHash = computeSchemaHash();
		const manifest = buildManifest(rows as unknown as SnapshotTables) as unknown as FoundingBundleExport['bundle']['manifest'];
		const digest = computeContentDigest(rows as unknown as SnapshotTables);
		const descriptor = deriveFoundingDescriptor(rows);

		const signingDigest = foundingBundleSigningDigest({
			networkHash: descriptor.networkHash,
			schemaHash,
			exportedAt,
			exporterUserId: exporter.userId,
			signerKey: exporter.signerKey,
			digest,
		});

		let signature: Awaited<ReturnType<FoundingBundleExporter['sign']>>;
		try {
			signature = await exporter.sign(signingDigest.bytes);
		} catch (err) {
			// The biometric prompt and the device signer's desync check run inside sign(), so a
			// typed code (CANCELED, LOCKOUT, KEY_INVALIDATED_REASSOCIATE, ...) must reach the caller (UAT 62 test 22).
			if (typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string') {
				throw err;
			}
			const wrapped = new FoundingBundleExportError('signature-self-check');
			(wrapped as { cause?: unknown }).cause = err;
			throw wrapped;
		}
		if (signature.signerUserId !== exporter.userId || signature.signerKey !== exporter.signerKey) {
			throw new FoundingBundleExportError('signature-self-check');
		}

		const bundle: FoundingBundleExport['bundle'] = {
			format: FOUNDING_BUNDLE_FORMAT,
			formatVersion: FOUNDING_BUNDLE_FORMAT_VERSION,
			descriptor,
			schemaHash,
			exportedAt,
			manifest,
			digest,
			rows,
			exporter: {
				userId: signature.signerUserId,
				signerKey: signature.signerKey,
				signature: signature.signature,
			},
		};

		// Fail closed on a mis-encoding app signer: the bundle must verify
		// against its own declared contents before it is ever handed out.
		const selfCheck = verifyFoundingBundle(bundle);
		if (!selfCheck.ok) {
			throw new FoundingBundleExportError('signature-self-check', selfCheck.detail);
		}

		const text = serializeFoundingBundle(bundle);
		const fileName = `votetorrent-network-${descriptor.networkHash.slice(0, 12)}.json`;
		return { bundle, text, fileName, fingerprint: foundingBundleFingerprint(bundle.digest) };
	}

	/**
	 * D-35/D-38/D-39/62-16: import a founding bundle produced by
	 * `exportFoundingBundle` on a second device. NEVER throws for a bundle or
	 * target problem — every failure is returned, categorized by
	 * `FOUNDING_FAILURE_CATEGORY`. Verification (parse + verifyFoundingBundle)
	 * and the already-joined check both run BEFORE any `DbFactory` call
	 * (fail-closed, Phase 50 D-12/D-13 order); a scratch in-memory dry run then
	 * proves the replay passes every tier-1 CHECK before the target database is
	 * opened.
	 */
	async importFoundingBundle(
		bundleText: string,
		user: User | undefined,
		options?: FoundingBundleImportOptions,
	): Promise<FoundingBundleImportResult> {
		// 62-102 (initial/G2 WR-03): an import must carry an out-of-band anchor.
		// Decided before any parse or DbFactory call; there is no bypass option.
		const hasAnchor = (v: string | undefined): boolean => typeof v === 'string' && v.length > 0;
		if (
			!hasAnchor(options?.expectedFingerprint) &&
			!hasAnchor(options?.expectedDigest) &&
			!hasAnchor(options?.expectedNetworkHash)
		) {
			return {
				ok: false,
				reason: 'anchor-required',
				category: FOUNDING_FAILURE_CATEGORY['anchor-required'],
				detail: 'founding bundle: an out-of-band anchor (the exporter\'s fingerprint) is required to import',
			};
		}

		const parsed = parseFoundingBundle(bundleText);
		if (!parsed.ok) {
			return { ok: false, reason: parsed.reason, category: FOUNDING_FAILURE_CATEGORY[parsed.reason], detail: parsed.detail };
		}

		const verified = verifyFoundingBundle(parsed.bundle, {
			expectedNetworkHash: options?.expectedNetworkHash,
			expectedDigest: options?.expectedDigest,
			expectedFingerprint: options?.expectedFingerprint,
		});
		if (!verified.ok) {
			return {
				ok: false,
				reason: verified.reason,
				category: FOUNDING_FAILURE_CATEGORY[verified.reason],
				detail: verified.detail,
			};
		}

		const bundle = parsed.bundle;
		const hash = bundle.descriptor.networkHash;

		// Already-joined check — before any DbFactory call.
		const recentBefore: NetworkReference[] = (await this.localStorage.getItem('recentNetworks')) ?? [];
		const existingRef = recentBefore.find((r) => r.hash === hash);
		if (this.contexts.has(hash) || existingRef) {
			const networkRef: NetworkReference = existingRef ?? {
				hash,
				imageUrl: bundle.descriptor.imageUrl,
				relays: [...bundle.descriptor.relays],
				name: bundle.descriptor.name,
				primaryAuthorityDomainName: bundle.descriptor.primaryAuthorityDomainName,
			};
			return { ok: false, reason: 'already-joined', category: 'already-joined', networkRef };
		}

		const genesisKeys = {
			userId: String(bundle.rows.User[0]!.Id),
			signerKey: String(bundle.rows.UserKey[0]!.PubKey),
			authorityId: String(bundle.rows.Authority[0]!.Id),
			adminEffectiveAt: String(bundle.rows.Admin[0]!.EffectiveAt),
		};

		// Scratch in-memory dry run — proves the replay passes every tier-1
		// CHECK BEFORE the target database (DbFactory) is ever opened. Not
		// wrapped in BEGIN/COMMIT: create()'s own three execs are not one
		// transaction either, and the batched deferred-CHECK trap applies the
		// same way here (see genesis-rows.ts's replayGenesisRows doc comment).
		const scratch = new Database();
		try {
			await prepareDb(scratch);
			await replayGenesisRows(scratch, bundle.rows, nowCanonicalDatetime());
			const scratchRows = await readGenesisRows(scratch, genesisKeys);
			const scratchDigest = computeContentDigest(scratchRows as unknown as SnapshotTables);
			if (scratchDigest !== bundle.digest) {
				return {
					ok: false,
					reason: 'replay-rejected',
					category: FOUNDING_FAILURE_CATEGORY['replay-rejected'],
					detail: 'founding bundle: scratch replay digest does not match the bundle digest',
				};
			}
		} catch (err) {
			return {
				ok: false,
				reason: 'replay-rejected',
				category: FOUNDING_FAILURE_CATEGORY['replay-rejected'],
				detail: `founding bundle: scratch replay refused (${extractConstraintName(err)})`,
			};
		} finally {
			const closable = scratch as unknown as { close?: () => Promise<void> };
			if (typeof closable.close === 'function') {
				try {
					await closable.close();
				} catch {
					// best-effort — the scratch handle is discarded either way.
				}
			}
		}

		// Target: the CREATE path, reached only after verification and the dry
		// run, so no empty database is ever fabricated for an invalid bundle.
		let ctx: EngineContext;
		try {
			ctx = await this.createContext(user, hash);
		} catch {
			return {
				ok: false,
				reason: 'target-open-failed',
				category: FOUNDING_FAILURE_CATEGORY['target-open-failed'],
				detail: 'founding bundle: target database open failed',
			};
		}

		// 62-102 (initial/G2 WR-04): every non-success exit after the target
		// opened evicts any cached context, so a retry is never refused as
		// already-joined, and closes the database ONLY when this engine owns it.
		// WR-R1-07: a strand-backed handle (the App schema applied by cadre-core's
		// StrandDatabase before the factory returned it) belongs to the strand
		// host, which keeps the strand registered and may still be syncing into
		// it; closing it would leave a registered strand with a dead Database and
		// fail every retry with target-open-failed until the app restarts. Such a
		// handle is left open for the host to reuse on the retry.
		const borrowedFromStrandHost = ((): boolean => {
			try {
				return ctx.db.declaredSchemaManager.hasDeclaredSchema('App');
			} catch {
				return false;
			}
		})();
		const failClosed = async (
			reason: 'target-open-failed' | 'target-replay-failed' | 'target-conflict',
			detail: string,
		): Promise<FoundingBundleImportResult> => {
			this.contexts.delete(hash);
			const closable = ctx.db as unknown as { close?: () => Promise<void> };
			if (!borrowedFromStrandHost && typeof closable.close === 'function') {
				try {
					await closable.close();
				} catch {
					// best-effort — the handle is discarded either way.
				}
			}
			return { ok: false, reason, category: FOUNDING_FAILURE_CATEGORY[reason], detail };
		};

		let targetRows: FoundingBundleRows;
		try {
			targetRows = await readGenesisRows(ctx.db, genesisKeys);
		} catch {
			return failClosed('target-open-failed', 'founding bundle: target database read failed');
		}

		const presentCount = FOUNDING_BUNDLE_TABLE_ORDER.reduce(
			(n, table) => n + (targetRows[table].length > 0 ? 1 : 0),
			0,
		);

		let outcome: 'replayed' | 'already-present';
		if (presentCount === FOUNDING_BUNDLE_TABLE_ORDER.length) {
			const targetDigest = computeContentDigest(targetRows as unknown as SnapshotTables);
			if (targetDigest !== bundle.digest) {
				return failClosed('target-conflict', 'founding bundle: target already holds a different network (different)');
			}
			outcome = 'already-present';
		} else if (presentCount === 0) {
			try {
				await replayGenesisRows(ctx.db, bundle.rows, nowCanonicalDatetime());
			} catch {
				return failClosed('target-replay-failed', 'founding bundle: target replay refused');
			}
			try {
				const readBack = await readGenesisRows(ctx.db, genesisKeys);
				const readBackDigest = computeContentDigest(readBack as unknown as SnapshotTables);
				if (readBackDigest !== bundle.digest) {
					return failClosed('target-replay-failed', 'founding bundle: replayed rows do not match the bundle digest');
				}
			} catch {
				return failClosed('target-replay-failed', 'founding bundle: replayed rows could not be read back');
			}
			outcome = 'replayed';
		} else {
			// A failure in batch 2 or 3 of a PRIOR replay attempt can leave
			// batch-1 rows — the dry run above makes that environmental only
			// (proven safe before this attempt), but a partial target from a
			// concurrent sync is a real, retryable state.
			return failClosed(
				'target-conflict',
				'founding bundle: target holds a partial founding generation (partial — sync in progress, retry later)',
			);
		}

		const networkRef: NetworkReference = {
			hash,
			imageUrl: bundle.descriptor.imageUrl,
			relays: [...bundle.descriptor.relays],
			name: bundle.descriptor.name,
			primaryAuthorityDomainName: bundle.descriptor.primaryAuthorityDomainName,
		};

		// open() finds the context cached (D-06) and, with storeAsRecent, is the
		// single writer of recentNetworks — nothing durable is written before it
		// resolves. A rejection evicts and closes so the retry starts clean.
		this.contexts.set(hash, ctx);
		let network: INetworkEngine;
		try {
			network = await this.open(networkRef, user, true, options?.getPeerCount);
		} catch {
			return failClosed('target-open-failed', 'founding bundle: target network could not be opened');
		}
		return {
			ok: true,
			outcome,
			networkRef,
			network,
			fingerprint: foundingBundleFingerprint(bundle.digest),
		};
	}

	/**
	 * Spike 100: a voter, already admitted to the authority's cadre, joins the
	 * network by opening its strand and accepting it only when the REPLICATED
	 * founding rows hash to the join code's digest. Unlike importFoundingBundle
	 * it never replays genesis rows: a voter writing founding rows into a shared
	 * strand would race the authority's own (and a peerless voter would found a
	 * second copy). Never throws; `no-peers` and `not-synced` are retryable.
	 */
	async joinFromStrand(
		anchor: NetworkJoinAnchor,
		user: User | undefined,
		options: JoinFromStrandOptions,
	): Promise<JoinFromStrandResult> {
		const hash = anchor.networkHash;
		let fingerprint: string;
		try {
			fingerprint = foundingBundleFingerprint(anchor.digest);
		} catch {
			return { ok: false, reason: 'digest-mismatch', retryable: false, detail: 'join: the code\'s digest is not a founding digest' };
		}

		// Already joined (or created/imported here): recentNetworks is written only by a
		// successful open(), so an entry means there is nothing left to do.
		const recent: NetworkReference[] = (await this.localStorage.getItem('recentNetworks')) ?? [];
		const existingRef = recent.find((r) => r.hash === hash);
		if (existingRef) {
			return { ok: true, outcome: 'already-joined', networkRef: existingRef, fingerprint };
		}

		// Before ANY DbFactory call: the strand factory founds the strand when no peer is
		// connected, which would give this phone a second, empty copy of the network.
		if (!(options.getPeerCount() > 0)) {
			return { ok: false, reason: 'no-peers', retryable: true, detail: 'join: no peer of the authority\'s network is connected yet' };
		}

		// UAT 65 F1: ONE deadline for the whole call. The strand factory is the longest await here: a
		// joiner's strand open waits for its first sync (cadre-core's gate, 360 s, and the app then
		// keeps waiting), so an unbounded await made the caller's budget meaningless. The open is
		// left running (a retry finds the same launch), only this call stops waiting on it.
		const deadline = Date.now() + (options.timeoutMs ?? 60_000);
		let ctx: EngineContext;
		try {
			const opened = await settleBy(this.createContext(user, hash), deadline);
			if (opened === TIMED_OUT) {
				return { ok: false, reason: 'not-synced', retryable: true, detail: 'join: the network\'s strand has not finished its first sync' };
			}
			ctx = opened;
		} catch {
			return { ok: false, reason: 'target-open-failed', retryable: true, detail: 'join: the network\'s database could not be opened' };
		}
		// Same release rule as importFoundingBundle's failClosed: a strand-backed handle
		// belongs to the strand host (which keeps syncing into it for the retry), so only
		// a handle this engine owns is closed.
		const borrowedFromStrandHost = ((): boolean => {
			try {
				return ctx.db.declaredSchemaManager.hasDeclaredSchema('App');
			} catch {
				return false;
			}
		})();
		const decline = async (
			reason: 'not-synced' | 'digest-mismatch' | 'target-open-failed',
			retryable: boolean,
			detail: string,
		): Promise<JoinFromStrandResult> => {
			this.contexts.delete(hash);
			const closable = ctx.db as unknown as { close?: () => Promise<void> };
			if (!borrowedFromStrandHost && typeof closable.close === 'function') {
				try {
					await closable.close();
				} catch {
					// best-effort — the handle is discarded either way.
				}
			}
			return { ok: false, reason, retryable, detail };
		};

		// Wait for all six founding rows to replicate. Point lookups only (readGenesisRows),
		// so polling a strand that is still syncing never scans.
		const pollMs = options.pollMs ?? 500;
		let rows: FoundingBundleRows | undefined;
		for (;;) {
			try {
				// UAT 65 F1: a point read on a strand whose cohort is unreachable can stay pending; the
				// deadline is checked against the read itself, not only between reads.
				const read = await settleBy(readGenesisRows(ctx.db, anchor.genesis), deadline);
				if (read === TIMED_OUT) {
					return decline('not-synced', true, 'join: the network\'s founding rows have not arrived yet');
				}
				if (FOUNDING_BUNDLE_TABLE_ORDER.every((table) => read[table].length > 0)) {
					rows = read;
					break;
				}
			} catch {
				// A strand still applying its schema can refuse a read; keep waiting.
			}
			if (Date.now() >= deadline) {
				return decline('not-synced', true, 'join: the network\'s founding rows have not arrived yet');
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}

		// The anchor: the replicated founding rows must be exactly the ones the code names.
		options.onVerifying?.();
		if (computeContentDigest(rows as unknown as SnapshotTables) !== anchor.digest) {
			return decline('digest-mismatch', false, 'join: this network\'s founding rows do not match the join code');
		}
		let descriptor: ReturnType<typeof deriveFoundingDescriptor>;
		try {
			descriptor = deriveFoundingDescriptor(rows);
		} catch {
			return decline('digest-mismatch', false, 'join: this network\'s founding rows are not readable');
		}
		if (descriptor.networkHash !== hash) {
			return decline('digest-mismatch', false, 'join: the founding rows name a different network');
		}

		const networkRef: NetworkReference = {
			hash,
			imageUrl: descriptor.imageUrl,
			relays: [...descriptor.relays],
			name: descriptor.name,
			primaryAuthorityDomainName: descriptor.primaryAuthorityDomainName,
		};
		// open() finds the context cached and, with storeAsRecent, is the single writer of
		// recentNetworks — nothing durable is written before it resolves.
		this.contexts.set(hash, ctx);
		try {
			await this.open(networkRef, user, true, options.getStrandPeerCount);
		} catch {
			return decline('target-open-failed', true, 'join: the network could not be opened');
		}
		return { ok: true, outcome: 'joined', networkRef, fingerprint };
	}

	/**
	 * 62-102: validity check without anchors and without any database. Returns
	 * ONLY the network name on success, deliberately never the digest or the
	 * fingerprint (the importing officer must type the exporter's value).
	 * Never throws.
	 */
	async inspectFoundingBundle(bundleText: string): Promise<FoundingBundleInspection> {
		try {
			const parsed = parseFoundingBundle(bundleText);
			if (!parsed.ok) {
				return { ok: false, reason: parsed.reason, category: FOUNDING_FAILURE_CATEGORY[parsed.reason], detail: parsed.detail };
			}
			const verified = verifyFoundingBundle(parsed.bundle);
			if (!verified.ok) {
				return { ok: false, reason: verified.reason, category: FOUNDING_FAILURE_CATEGORY[verified.reason], detail: verified.detail };
			}
			return { ok: true, networkName: parsed.bundle.descriptor.name };
		} catch {
			return {
				ok: false,
				reason: 'malformed',
				category: FOUNDING_FAILURE_CATEGORY.malformed,
				detail: 'founding bundle: could not be inspected',
			};
		}
	}

	async getRecentNetworks(): Promise<NetworkReference[]> {
		return (await this.localStorage.getItem('recentNetworks')) ?? [];
	}

	async open(
		ref: NetworkReference,
		user: User | undefined,
		storeAsRecent: boolean = true,
		/**
		 * ENG-05: optional live peer-count callback forwarded into the NetworkEngine
		 * so getStatistics can report connected peers. Plain (() => number) — D-03:
		 * no @serfab/@optimystic import enters packages/vote-engine; the app layer
		 * supplies the closure.
		 */
		getPeerCount?: () => number,
	): Promise<INetworkEngine> {
		// D-06: cache-first — single live handle per store.
		const cached = this.contexts.get(ref.hash);
		if (cached) {
			// WR-03: keep a single source of truth for ctx.user. Previously the
			// per-call ctx (with the freshly-supplied user) was returned to the
			// NetworkEngine but was NOT written back into this.contexts, so
			// siblings reading via getEstablishedContext() saw the ORIGINAL cached
			// ctx whose user could differ from what this open() call established.
			// Write the per-call ctx back so the NetworkEngine and all siblings
			// observe one consistent ctx.user for this network.
			const ctx: EngineContext = { ...cached, user };
			this.contexts.set(ref.hash, ctx);
			const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx, getPeerCount);
			if (storeAsRecent) {
				const recentNetworks: NetworkReference[] =
					(await this.localStorage.getItem('recentNetworks')) ?? [];
				if (recentNetworks.find((network) => network.hash === ref.hash)) {
					// WR-04: await to remove the read-before-write race on recentNetworks.
					await this.localStorage.setItem('recentNetworks', [
						ref,
						...recentNetworks.filter((network) => network.hash !== ref.hash),
					]);
				} else {
					await this.localStorage.setItem('recentNetworks', [ref, ...recentNetworks]);
				}
			}
			return qNetworkEngine;
		}

		// D-05: cache miss — re-attach ONLY if an initialized store already exists.
		// open() MUST NOT route through createContext() (that path runs DDL and would
		// silently fabricate a fresh empty DB for an unknown hash). Call the factory
		// DIRECTLY, register plugins (no DDL), then gate on the schema-version marker.
		// D-13: hard fail — do NOT fall back to new Database() on a factory open error.
		let db: Database;
		try {
			db = await this.dbFactory(ref.hash);
		} catch (error) {
			throw new Error(
				'Network not opened in this session — use create() first: ' + error,
			);
		}

		// Always-run: register plugins and custom functions (per-Database-instance, not persisted).
		await registerDbPlugins(db);

		// Cross-backend-safe re-attach guard (14-04 — narrows D-05/D-07 with on-device evidence).
		// See patches/optimystic-quereus-plugin-composite-pk.md (second finding).
		//
		// hasDeclaredSchema('main') is false on ANY fresh handle (new process restart OR new
		// in-memory Database()). Running initDB on an already-declared handle triggers the
		// Quereus schema-differ to emit ALTER COLUMN DROP NOT NULL on a PK column, which then
		// throws "Cannot DROP NOT NULL on PRIMARY KEY column 'DependsOn'" — breaking the
		// in-memory suite. So initDB must ONLY run when the handle lacks the declaration.
		//
		// Correctness matrix:
		//   fresh in-memory (never declared)        → initDB runs (creates tables)  → D-05 gate throws (no marker)
		//   in-memory already prepared same session → initDB SKIPPED (already declared) → gate passes → re-attach OK
		//   persistent fresh handle (restart)       → initDB runs (binds LevelDB vtab catalog) → gate passes if initialized
		//   persistent genuinely uninitialized      → initDB runs (creates vtab bindings) → D-05 gate throws (no marker)
		//
		// STRAND RE-ATTACH FIX: the matrix above is written for the rnDbFactory/in-memory
		// backend, where the schema is declared under `main`. On the cadre-core STRAND backend
		// StrandDatabase.executeSchema() applies the schema under `App`, so hasDeclaredSchema('main')
		// is false on EVERY strand re-attach — including a perfectly healthy one — and initDB would
		// declare a SECOND `main` schema over the same tree://default/{table} collections. The
		// Quereus differ then diffs that fresh `main` declaration against tables that already carry
		// their constraints and re-emits every named constraint, failing on the first one:
		//   QuereusError: Failed to execute DDL: ALTER TABLE Network ADD constraint CantDelete
		//                 check on delete (false)
		//   Cannot add constraint 'CantDelete' to table 'Network': a constraint with that name already exists
		// which surfaced as "Failed to load network" on every app restart (Try Again re-ran the same
		// DDL, so only Start Fresh escaped it — losing the operator's session each launch).
		//
		// createContext() (the CREATE path) already gates on `App` for exactly this reason and its
		// comment flags the pitfall verbatim: "use 'App' not 'main'; 'main' would never match on the
		// strand path and the bug persists". open() was missing the same gate. Check `App` FIRST.
		//
		// Unqualified TABLE reads still resolve on the strand path (Quereus searches the schema path
		// `App, main`), so isSchemaInitialized's marker lookup below works without initDB. Only VIEWS
		// need the `main` re-declaration, which declareViewsInMain() below already handles.
		const isStrandDb = db.declaredSchemaManager.hasDeclaredSchema('App');
		if (isStrandDb) {
			// Strand re-attach: schema already applied under `App`. Do NOT run initDB.
			// Do NOT touch TidHighWater either: the strand store's TidHighWater is read lazily by the
			// first allocateTid. A joiner that imported a founding bundle never holds that header block,
			// and reading it here made every cold start depend on a block only reachable through the
			// cohort (UAT 62 test 19: BlockUnavailableError cohort-unreachable at open()).
			// markSchemaInitialized is deliberately NOT called here: planting the marker is the
			// CREATE path's job, so a genuinely uninitialized strand store still fails the D-05
			// gate below rather than being silently promoted to "initialized".
		} else if (!db.declaredSchemaManager.hasDeclaredSchema('main')) {
			await initDB(db);           // declare schema main {...} + apply: creates vtab bindings, binds LevelDB data.
			// initDB also declares the SchemaInit catalog (NO row) — 14-03 on-device fix: a fresh Quereus
			// handle does not auto-restore the catalog from LevelDB, so isSchemaInitialized's marker lookup
			// would otherwise hit an undeclared table → false → wrongly throw on a correctly-persisted store.
			await ensureTidSequence(db); // idempotent INSERT OR IGNORE — safe to re-run
		}

		// D-05/D-08: if the store has no schema-init flag, it is uninitialized — THROW.
		// initDB binds the catalog but does NOT write a SchemaInit flag (that is create()'s
		// job via markSchemaInitialized). So a truly uninitialized store still throws here.
		const initialized = await isSchemaInitialized(db);
		if (!initialized) {
			throw new Error(
				'Network not opened in this session — use create() first',
			);
		}

		// Re-attach (store exists + initialized): cache the single live handle (D-06).
		// 999.1 D-02/D-07: no separate seed step — the shared allocator reads
		// TidHighWater lazily on the first allocateTid(ctx.db, 'networks') call.

		// STRAND-VIEWS fix (re-attach path): on the strand path cadre-core applies the
		// schema under `App`, so views live in App and unqualified view references fail
		// (Quereus resolves views only against the current schema `main`, not the path).
		// Re-declare views in `main` (idempotent) so engine reads resolve after re-attach.
		// No-op safety: on the in-memory/rnDbFactory path the views already live in `main`
		// (initDB declared schema main), so `create view if not exists` does nothing.
		if (isStrandDb) {
			await declareViewsInMain(db);
		}

		const ctx: EngineContext = { db, user };
		this.contexts.set(ref.hash, ctx);
		const qNetworkEngine = new NetworkEngine(ref, this.localStorage, ctx, getPeerCount);
		if (storeAsRecent) {
			const recentNetworks: NetworkReference[] =
				(await this.localStorage.getItem('recentNetworks')) ?? [];
			if (recentNetworks.find((network) => network.hash === ref.hash)) {
				await this.localStorage.setItem('recentNetworks', [
					ref,
					...recentNetworks.filter((network) => network.hash !== ref.hash),
				]);
			} else {
				await this.localStorage.setItem('recentNetworks', [ref, ...recentNetworks]);
			}
		}
		return qNetworkEngine;
	}

	buildCreate(): INetworksCreateBuilder {
		return new NetworksCreateBuilder(this);
	}

	/**
	 * D-10: single minimal accessor for the EngineFactory to read the established
	 * context after open() or create(). Does NOT expose ctx.db to screens — only
	 * the factory holds the returned reference.
	 *
	 * Returns undefined if no context has been established for the given hash
	 * (caller must call open() or create() first).
	 */
	getEstablishedContext(networkHash: string): EngineContext | undefined {
		return this.contexts.get(networkHash);
	}

	// D-01: factory-backed createContext — this is the CREATE path. DDL runs here
	// on fresh stores (isSchemaInitialized gate). open() MUST NOT call this method.
	private async createContext(user: User | undefined, hash: string): Promise<EngineContext> {
		const db = await this.dbFactory(hash);           // D-01: factory, not new Database()
		await registerDbPlugins(db);                     // D-07: always-run (plugins/functions)

		// REL-01 strand-aware gate: detect whether the Database already had the App schema
		// applied by StrandDatabase.initialize() (cadre-core strand path).
		//
		// 'App' → strand path: StrandDatabase.executeSchema() ran `declare schema App { <DDL> }
		//         apply schema App;` before handing the handle to this factory. Running initDB
		//         here would declare a SECOND `main` schema over the same tree://default/{table}
		//         LevelDB collections, causing dual-Table ownership and stalling every subsequent
		//         INSERT (release-build infinite spinner / hang).
		//         FIX: skip initDB entirely; run only the idempotent marker helpers.
		//
		// 'main' / absent → rnDbFactory path (dev / in-memory): no prior schema declaration.
		//         Fall through to the existing isSchemaInitialized/initDB gate verbatim.
		//
		// Mirrors the open() guard at line ~334 which uses hasDeclaredSchema('main')
		// for the re-attach check — same pattern, different schema name (Pitfall 1: use
		// 'App' not 'main'; 'main' would never match on the strand path and the bug persists).
		const isStrandDb = db.declaredSchemaManager.hasDeclaredSchema('App');

		if (isStrandDb) {
			// Strand path: App schema already applied — skip initDB (no second main declaration).
			// Plant only the idempotent SchemaInit marker so isSchemaInitialized works. It uses
			// INSERT OR IGNORE — fully idempotent, so a second createContext() on an already-initialized
			// strand store (CR-01 fix) does not throw a PK-uniqueness violation.
			// No ensureTidSequence here: it peeks TidHighWater, a header block a bundle-importing joiner
			// never holds (UAT 62 test 19); allocateTid creates/reads it lazily on the first real write.
			await markSchemaInitialized(db);             // D-08: plant the SchemaInit flag (idempotent)
			// STRAND-VIEWS fix: cadre-core applies the schema under `App`, so all views
			// live in App. Quereus resolves UNQUALIFIED views only against the current
			// schema (`main`), not the schema path — so `select ... from CurrentAdmin`
			// throws "not found in schema path: App, main" even though App.CurrentAdmin
			// exists. Re-declare every view in `main` (idempotent) so unqualified engine
			// queries (authority/signing/user/elections engines) resolve on the strand.
			await declareViewsInMain(db);                // STRAND-VIEWS: views in main for unqualified reads
		} else {
			// rnDbFactory path (dev / in-memory): existing logic verbatim (D-08/D-07/D-12).
			const initialized = await isSchemaInitialized(db); // D-08: sentinel check
			if (!initialized) {
				await initDB(db);                        // D-07: DDL only on fresh store
				await ensureTidSequence(db);             // D-12: create TidSequence table
				await markSchemaInitialized(db);         // D-08: plant the SchemaInit flag
			}
		}

		// 999.1 D-02/D-07: no separate seed step — the shared allocator reads
		// TidHighWater lazily on the first allocateTid(ctx.db, 'networks') call.
		const ctx: EngineContext = { db, user };
		return ctx;
	}
}

const TIMED_OUT: unique symbol = Symbol('networks-engine.timed-out');

/** `promise`'s value, or TIMED_OUT at `deadlineMs` (epoch ms). A rejection after the race is absorbed. */
function settleBy<T>(promise: Promise<T>, deadlineMs: number): Promise<T | typeof TIMED_OUT> {
	promise.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadlineMs - Date.now()));
	});
	return Promise.race([promise, expiry]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Network/Authority.ImageRef as written at create. Without a cid this is the historical bare JSON
 * string (byte-identical to every network created before media pinning, so founding bundles and
 * descriptors are unchanged); with one it is `{ url, cid }`. Readers accept both via `toImageRef`.
 */
function storedImageRefJson(url: string | undefined, cid: string | undefined): string | null {
	if (!url) return null;
	return cid ? JSON.stringify({ url, cid }) : JSON.stringify(url);
}
