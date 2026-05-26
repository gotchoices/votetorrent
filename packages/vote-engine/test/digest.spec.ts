import { createHash } from 'crypto';
import { Database } from '@quereus/quereus';
import { expect } from 'chai';
import { digest } from '../src/database/digest';
import { prepareDb } from '../src/database/initialize';

describe('digest helper', () => {
	it('returns a base64url string (URL-safe chars only, 43 chars for SHA-256)', () => {
		const result = digest('hello');
		expect(result).to.match(/^[A-Za-z0-9_-]{43}$/);
	});

	it('joins multiple args with pipe delimiter', () => {
		// digest('hello', 'world') hashes 'hello|world'
		// digest('helloworld') hashes 'helloworld'
		// These must differ
		expect(digest('hello', 'world')).to.not.equal(digest('helloworld'));

		// Verify against manual computation
		const expected = createHash('sha256').update('hello|world').digest('base64url');
		expect(digest('hello', 'world')).to.equal(expected);
	});

	it('maps null and undefined to empty string', () => {
		// digest(null, 'a', undefined) should equal digest('', 'a', '')
		expect(digest(null, 'a', undefined)).to.equal(digest('', 'a', ''));
	});

	it('converts numbers via String()', () => {
		// digest(42) should equal digest('42')
		expect(digest(42)).to.equal(digest('42'));

		// Verify it is NOT some IEEE 754 binary representation
		const stringBased = createHash('sha256').update('42').digest('base64url');
		expect(digest(42)).to.equal(stringBased);
	});

	it('single arg produces sha256 of that arg with no delimiter', () => {
		const expected = createHash('sha256').update('test').digest('base64url');
		expect(digest('test')).to.equal(expected);
	});

	it('empty args list produces sha256 of empty string', () => {
		const expected = createHash('sha256').update('').digest('base64url');
		expect(digest()).to.equal(expected);
	});
});

describe('JS digest vs SQL Digest equivalence', () => {
	let db: Database;

	before(async () => {
		db = new Database();
		await prepareDb(db);
	});

	const vectors: { label: string; args: (string | number | null)[]; sql: string; binds: Record<string, unknown> }[] = [
		{
			label: "two strings ('hello', 'world')",
			args: ['hello', 'world'],
			sql: `select Digest(:a, :b) as v`,
			binds: { a: 'hello', b: 'world' },
		},
		{
			label: "single string ('test')",
			args: ['test'],
			sql: `select Digest(:a) as v`,
			binds: { a: 'test' },
		},
		{
			label: 'null handling (null, a)',
			args: [null, 'a'],
			sql: `select Digest(null, :a) as v`,
			binds: { a: 'a' },
		},
		{
			label: "number and string (42, 'x')",
			args: [42, 'x'],
			sql: `select Digest(:a, :b) as v`,
			binds: { a: 42, b: 'x' },
		},
		{
			label: "empty string ('')",
			args: [''],
			sql: `select Digest(:a) as v`,
			binds: { a: '' },
		},
	];

	for (const vec of vectors) {
		it(`produces identical output for ${vec.label}`, async () => {
			const jsResult = digest(...vec.args);
			const row = await db.prepare(vec.sql).get(vec.binds);
			const sqlResult = row!['v'] as string;
			expect(jsResult).to.equal(sqlResult);
		});
	}
});
