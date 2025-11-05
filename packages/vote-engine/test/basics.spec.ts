import { Database } from '@quereus/quereus';
import { expect } from 'chai';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath, resolve } from 'url';

describe('Basics', () => {
	it('should exercise the basics of creating, accessing, and modifying a database', async () => {
		const db = new Database();

		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const schemaPath = resolve(__dirname, 'test/test-schema.qsql');

		// try {
		await db.exec(readFileSync(schemaPath, 'utf8'));
		// } catch (error) {
		// 	console.error('Error loading schema:', error);
		// }

		// 		await db.exec(`asdfasdfasdf
		// `);

		await db.exec(
			`
			insert into Test (Id, ShouldBeNumberLargerThanZero, Type)
			values (:id, :shouldBeNumberLargerThanZero, :type);
		`,
			{
				id: '1234567890',
				shouldBeNumberLargerThanZero: 1,
				type: 'test',
			}
		);

		const result = await db
			.prepare(
				`select Id, ShouldBeNumberLargerThanZero, ShouldBeNull, Type, ShouldHaveDefault from Test;`
			)
			.get();

		expect(result).to.not.be.null;
		expect(result!['Id'] as string).to.equal('1234567890');
		expect(result!['ShouldBeNumberLargerThanZero'] as number).to.equal(1);
		expect(result!['ShouldBeNull'] as string | null).to.be.null;
		expect(result!['Type'] as string).to.equal('test');
		expect(result!['ShouldHaveDefault'] as string).to.equal('default');

		await db.exec(`
			update Test set ShouldBeNumberLargerThanZero = 2 where Id = '1234567890';
		`);

		const result2 = await db
			.prepare(`select Id, ShouldBeNumberLargerThanZero from Test;`)
			.get();

		expect(result2).to.not.be.null;
		expect(result2!['Id'] as string).to.equal('1234567890');
		expect(result2!['ShouldBeNumberLargerThanZero'] as number).to.equal(2);
	});
});
