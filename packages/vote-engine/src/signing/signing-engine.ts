import {
	ISigningEngine,
	Scope,
	Signature,
	SigningResult,
} from '@votetorrent/vote-core';
import { EngineContext } from '../types';
import { MisuseError, QuereusError } from '@quereus/quereus';

export class SigningEngine implements ISigningEngine {
	constructor(private ctx: EngineContext) {}

	async sign(nonce: string, signature: Signature): Promise<boolean> {
		try {
			// Insert the new OfficerSignature
			await this.ctx.db.exec(
				`insert into OfficerSignature (
					SigningNonce,
					UserId,
					SignerKey,
					Signature
				)
				values (
					:nonce,
					:userId,
					:signerKey,
					:signature
				)`,
				{
					nonce,
					userId: signature.signerUserId,
					key: signature.signerKey,
					signature: signature.signature,
				}
			);

			// Get the scope for the current signing session
			const scopeRes = await this.ctx.db
				.prepare(`select Scope from AdminSigning where Nonce = :nonce`)
				.get({ ':nonce': nonce });
			const scope = scopeRes!['Scope'] as Scope;

			// Get the current number of OfficerSignatures for the given signing nonce
			const signatureCountRes = await this.ctx.db
				.prepare(
					`select count(*) as signatureCount from OfficerSignature where SigningNonce = :nonce`
				)
				.get({ ':nonce': nonce });
			const signatureCount = Number(signatureCountRes?.signatureCount);

			// Get the threshold for this signing session from the Admin table, matching the authority, effective date, and scope
			const thresholdRes = await this.ctx.db
				.prepare(
					`select
						coalesce(
							cast(
								json_extract(
									-- get the first policy object that matches the scope; fallback to 1 if not found
									(
									  select value
									  from json_each(ThresholdPolicies)
									  where json_extract(value, '$.scope') = :scope
									  limit 1
									), '$.threshold'
								) as integer
							), 1
						) as threshold
				from AdminSigning ADS
				join Admin A
					on ADS.AuthorityId = A.AuthorityId
					and ADS.AdminEffectiveAt = A.EffectiveAt
				where ADS.Nonce = :nonce`
				)
				.get({ ':nonce': nonce, ':scope': scope });

			const threshold = Number(thresholdRes?.threshold) || 1;

			if (signatureCount >= threshold) {
				await this.ctx.db.exec(
					`insert into AdminSignature (SigningNonce) values (:nonce)`,
					{ ':nonce': nonce }
				);
				return true;
			} else {
				return false;
			}
		} catch (err) {
			if (err instanceof QuereusError) {
				throw new Error(`Quereus error (code ${err.code}): ${err.message}`);
			} else if (err instanceof MisuseError) {
				throw new Error(`API misuse: ${err.message}`);
			} else {
				throw new Error(`Unknown error: ${err}`);
			}
		}
		return false;
	}

	async startSigningSession(
		authorityId: string,
		digest: string,
		scope: Scope,
		signature: Signature
	): Promise<SigningResult> {
		const nonce = crypto.randomUUID();
		try {
			const adminDB = await this.ctx.db
				.prepare(
					`select 1 from CurrentAdmin join Officer
						on CurrentAdmin.AuthorityId = Officer.AuthorityId
							and CurrentAdmin.EffectiveAt = Officer.AdminEffectiveAt
								where Officer.UserId = :userId and Officer.AuthorityId = :authorityId`
				)
				.get({
					':userId': signature.signerUserId,
					':authorityId': authorityId,
				});
			if (!adminDB) {
				throw new Error('Admin not found');
			}
			await this.ctx.db.exec(
				`insert into AdminSigning (
					Nonce,
					AuthorityId,
					AdminEffectiveAt,
					Scope,
					Digest,
					UserId,
					SignerKey,
					Signature
				)
				values (
					:nonce,
					:authorityId,
					:adminEffectiveAt,
					:scope,
					:digest,
					:userId,
					:signerKey,
					:signature
				)`,
				{
					nonce,
					authorityId: authorityId,
					adminEffectiveAt: adminDB!['EffectiveAt'] as number,
					scope,
					digest,
					userId: signature.signerUserId,
					signerKey: signature.signerKey,
					signature: signature.signature,
				}
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
		const thresholdReached = await this.sign(nonce, signature);
		return { nonce, thresholdReached };
	}
}
