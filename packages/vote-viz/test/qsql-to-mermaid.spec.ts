import { expect } from 'aegir/chai';
import { transpileQuereusAstToMermaidEr } from '../src/qsql-to-mermaid.js';
import { ast } from './qsql-to-typeql.spec.js';

describe('qsql-to-mermaid', () => {
	let mermaid: string;

	before(() => {
		mermaid = transpileQuereusAstToMermaidEr(ast);
		// console.log(mermaid);
	});

	describe('structure', () => {
		it('starts with erDiagram', () => {
			expect(mermaid.trimStart()).to.match(/^erDiagram/);
		});

		it('contains an entity block for each table', () => {
			expect(mermaid).to.include('  authority {');
			expect(mermaid).to.include('  network {');
			expect(mermaid).to.include('  admin {');
			expect(mermaid).to.include('  officer {');
			expect(mermaid).to.include('  user_key {');
		});

		it('closes every entity block', () => {
			const opens = (mermaid.match(/\{$/gm) ?? []).length;
			const closes = (mermaid.match(/^\s+\}$/gm) ?? []).length;
			expect(closes).to.equal(opens);
		});
	});

	describe('primary keys', () => {
		it('marks single-column PK with PK annotation', () => {
			expect(mermaid).to.match(/authority \{[\s\S]*?string id PK/);
			expect(mermaid).to.match(/admin_signing \{[\s\S]*?string nonce PK/);
			expect(mermaid).to.match(/invite_slot \{[\s\S]*?string cid PK/);
		});

		it('emits surrogate key with PK for composite or missing primary key', () => {
			expect(mermaid).to.include('    string network_key PK');
			expect(mermaid).to.include('    string admin_key PK');
			expect(mermaid).to.include('    string officer_key PK');
			expect(mermaid).to.include('    string user_key_key PK');
		});
	});

	describe('foreign keys', () => {
		it('marks FK columns with FK annotation', () => {
			expect(mermaid).to.match(/admin \{[\s\S]*?string authority_id FK/);
			expect(mermaid).to.match(/officer \{[\s\S]*?string authority_id FK/);
			expect(mermaid).to.match(/officer \{[\s\S]*?string user_id FK/);
			expect(mermaid).to.match(/user_key \{[\s\S]*?string user_id FK/);
		});
	});

	describe('type mapping', () => {
		it('maps integer columns to int', () => {
			expect(mermaid).to.include('    int number_required_tsas');
		});

		it('maps datetime columns to datetime', () => {
			expect(mermaid).to.match(/admin \{[\s\S]*?datetime effective_at/);
		});

		it('maps boolean columns to boolean', () => {
			expect(mermaid).to.match(/invite_result \{[\s\S]*?boolean is_accepted/);
		});

		it('maps text columns to string', () => {
			expect(mermaid).to.match(/authority \{[\s\S]*?string name/);
		});
	});

	describe('relationships', () => {
		it('emits one-to-many line for admin → authority', () => {
			expect(mermaid).to.include('  admin }o--|| authority : "admin_authority"');
		});

		it('emits one-to-many line for officer → authority', () => {
			expect(mermaid).to.include('  officer }o--|| authority : "officer_authority"');
		});

		it('emits one-to-many line for officer → user', () => {
			expect(mermaid).to.include('  officer }o--|| user : "officer_user"');
		});

		it('emits one-to-many line for user_key → user', () => {
			expect(mermaid).to.include('  user_key }o--|| user : "user_key_user"');
		});
	});
});
