import { expect } from 'aegir/chai';
import {
	SIDSchema,
	TimestampSchema,
	HexStringSchema,
	URLSchema,
	SafeStringSchema,
	DomainNameSchema,
	UserKeySchema,
	UserSchema,
	AuthoritySchema,
	MultiAddrSchema,
	NetworkRevisionSchema,
	validate,
	safeValidate,
	sanitizeString,
	isValidSID,
	isValidTimestamp,
	isValidHex,
} from '../src/validation/index.js';

describe('Validation Schemas', () => {
	describe('SIDSchema', () => {
		it('should accept valid SIDs', () => {
			const validSIDs = [
				'user-a3f5e8b2c1d4f6e9',
				'auth-1234567890abcdef',
				'election-deadbeefcafebabe1234567890abcdef',
			];

			for (const sid of validSIDs) {
				expect(() => SIDSchema.parse(sid)).to.not.throw();
			}
		});

		it('should reject invalid SIDs', () => {
			const invalidSIDs = [
				'invalid',
				'user',
				'user-',
				'-a3f5e8b2',
				'user-xyz', // Not hex
				'user-a3f', // Too short
				'USER-a3f5e8b2c1d4f6e9', // Uppercase prefix
			];

			for (const sid of invalidSIDs) {
				expect(() => SIDSchema.parse(sid)).to.throw();
			}
		});
	});

	describe('TimestampSchema', () => {
		it('should accept valid timestamps', () => {
			const now = Math.floor(Date.now() / 1000);
			const validTimestamps = [
				now,
				now - 86400, // Yesterday
				now + 86400, // Tomorrow
				1704067200, // 2024-01-01
			];

			for (const ts of validTimestamps) {
				expect(() => TimestampSchema.parse(ts)).to.not.throw();
			}
		});

		it('should reject invalid timestamps', () => {
			const invalidTimestamps = [
				-1,
				0,
				100, // Too old
				9999999999999, // Far future
			];

			for (const ts of invalidTimestamps) {
				expect(() => TimestampSchema.parse(ts)).to.throw();
			}
		});

		it('should reject non-integer timestamps', () => {
			expect(() => TimestampSchema.parse(1234.567)).to.throw();
		});
	});

	describe('HexStringSchema', () => {
		it('should accept valid hex strings', () => {
			const validHex = ['deadbeef', 'DEADBEEF', '0123456789abcdef', 'a1b2c3'];

			for (const hex of validHex) {
				expect(() => HexStringSchema.parse(hex)).to.not.throw();
			}
		});

		it('should reject invalid hex strings', () => {
			const invalidHex = [
				'xyz',
				'g123',
				'123', // Odd length
				'12 34',
				'',
			];

			for (const hex of invalidHex) {
				expect(() => HexStringSchema.parse(hex)).to.throw();
			}
		});
	});

	describe('URLSchema', () => {
		it('should accept valid URLs', () => {
			const validURLs = [
				'https://example.com',
				'http://localhost:8080',
				'https://example.com/path/to/resource',
				'ipfs://QmHash',
			];

			for (const url of validURLs) {
				expect(() => URLSchema.parse(url)).to.not.throw();
			}
		});

		it('should reject invalid protocols', () => {
			const invalidURLs = [
				'ftp://example.com',
				'javascript:alert(1)',
				'data:text/html,<script>alert(1)</script>',
				'file:///etc/passwd',
			];

			for (const url of invalidURLs) {
				expect(() => URLSchema.parse(url)).to.throw();
			}
		});

		it('should reject malformed URLs', () => {
			const malformed = ['not a url', 'htp://broken', '//example.com'];

			for (const url of malformed) {
				expect(() => URLSchema.parse(url)).to.throw();
			}
		});
	});

	describe('SafeStringSchema', () => {
		it('should accept safe strings', () => {
			const safeStrings = [
				'Hello World',
				'User Name 123',
				'Email: user@example.com',
				'Valid-name_with.symbols',
			];

			for (const str of safeStrings) {
				expect(() => SafeStringSchema.parse(str)).to.not.throw();
			}
		});

		it('should reject XSS attempts', () => {
			const xssAttempts = [
				'<script>alert(1)</script>',
				'javascript:alert(1)',
				'<img src=x onerror=alert(1)>',
				'onclick=alert(1)',
				'${malicious}',
				'`template`',
			];

			for (const xss of xssAttempts) {
				expect(() => SafeStringSchema.parse(xss)).to.throw();
			}
		});

		it('should enforce length limits', () => {
			expect(() => SafeStringSchema.parse('')).to.throw();
			expect(() => SafeStringSchema.parse('a'.repeat(1001))).to.throw();
		});
	});

	describe('DomainNameSchema', () => {
		it('should accept valid domain names', () => {
			const validDomains = [
				'example.com',
				'sub.example.com',
				'deep.sub.example.com',
				'example-site.co.uk',
			];

			for (const domain of validDomains) {
				expect(() => DomainNameSchema.parse(domain)).to.not.throw();
			}
		});

		it('should reject invalid domain names', () => {
			const invalidDomains = [
				'invalid',
				'-example.com',
				'example-.com',
				'ex ample.com',
				'example.c',
			];

			for (const domain of invalidDomains) {
				expect(() => DomainNameSchema.parse(domain)).to.throw();
			}
		});
	});

	describe('UserKeySchema', () => {
		it('should accept valid user keys', () => {
			const validKey = {
				key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
				type: 'M' as const,
				expiration: Math.floor(Date.now() / 1000) + 86400,
			};

			expect(() => UserKeySchema.parse(validKey)).to.not.throw();
		});

		it('should reject invalid key types', () => {
			const invalidKey = {
				key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
				type: 'INVALID',
				expiration: Math.floor(Date.now() / 1000) + 86400,
			};

			expect(() => UserKeySchema.parse(invalidKey)).to.throw();
		});

		it('should reject keys that are too short', () => {
			const invalidKey = {
				key: 'tooshort',
				type: 'M' as const,
				expiration: Math.floor(Date.now() / 1000) + 86400,
			};

			expect(() => UserKeySchema.parse(invalidKey)).to.throw();
		});
	});

	describe('UserSchema', () => {
		it('should accept valid user objects', () => {
			const validUser = {
				sid: 'user-a1b2c3d4e5f6a7b8',
				name: 'Alice Wonderland',
				image: {
					url: 'https://example.com/alice.jpg',
				},
				activeKeys: [
					{
						key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
						type: 'M' as const,
						expiration: Math.floor(Date.now() / 1000) + 86400,
					},
				],
			};

			expect(() => UserSchema.parse(validUser)).to.not.throw();
		});

		it('should reject users with XSS in name', () => {
			const invalidUser = {
				sid: 'user-a1b2c3d4e5f6a7b8',
				name: '<script>alert(1)</script>',
				image: {
					url: 'https://example.com/alice.jpg',
				},
				activeKeys: [
					{
						key: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
						type: 'M' as const,
						expiration: Math.floor(Date.now() / 1000) + 86400,
					},
				],
			};

			expect(() => UserSchema.parse(invalidUser)).to.throw();
		});

		it('should require at least one active key', () => {
			const invalidUser = {
				sid: 'user-a1b2c3d4e5f6a7b8',
				name: 'Alice Wonderland',
				image: {
					url: 'https://example.com/alice.jpg',
				},
				activeKeys: [],
			};

			expect(() => UserSchema.parse(invalidUser)).to.throw();
		});
	});

	describe('AuthoritySchema', () => {
		it('should accept valid authority objects', () => {
			const validAuthority = {
				sid: 'auth-a1b2c3d4e5f6a7b8',
				name: 'Salt Lake County',
				domainName: 'slco.org',
				imageRef: {
					url: 'https://example.com/slco.jpg',
				},
				signature: {
					signature: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6',
					signerKey:
						'04a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
				},
			};

			expect(() => AuthoritySchema.parse(validAuthority)).to.not.throw();
		});
	});

	describe('MultiAddrSchema', () => {
		it('should accept valid multiaddrs', () => {
			const validAddrs = [
				'/ip4/127.0.0.1/tcp/8080/p2p/QmExample',
				'/ip6/::1/tcp/9090/p2p/12D3KooWExample',
			];

			for (const addr of validAddrs) {
				expect(() => MultiAddrSchema.parse(addr)).to.not.throw();
			}
		});

		it('should reject invalid multiaddrs', () => {
			const invalidAddrs = [
				'invalid',
				'/ip4/127.0.0.1',
				'http://example.com',
			];

			for (const addr of invalidAddrs) {
				expect(() => MultiAddrSchema.parse(addr)).to.throw();
			}
		});
	});

	describe('Helper Functions', () => {
		describe('validate', () => {
			it('should validate and return typed data', () => {
				const data = 'user-a1b2c3d4e5f6a7b8';
				const result = validate(SIDSchema, data);
				expect(result).to.equal(data);
			});

			it('should throw on invalid data', () => {
				expect(() => validate(SIDSchema, 'invalid')).to.throw();
			});
		});

		describe('safeValidate', () => {
			it('should return success for valid data', () => {
				const data = 'user-a1b2c3d4e5f6a7b8';
				const result = safeValidate(SIDSchema, data);
				expect(result.success).to.be.true;
				if (result.success) {
					expect(result.data).to.equal(data);
				}
			});

			it('should return error for invalid data', () => {
				const result = safeValidate(SIDSchema, 'invalid');
				expect(result.success).to.be.false;
				if (!result.success) {
					expect(result.error).to.exist;
				}
			});
		});

		describe('sanitizeString', () => {
			it('should sanitize valid strings', () => {
				const clean = sanitizeString('Hello World');
				expect(clean).to.equal('Hello World');
			});

			it('should reject XSS attempts', () => {
				expect(() => sanitizeString('<script>alert(1)</script>')).to.throw();
			});

			it('should enforce length limits', () => {
				expect(() => sanitizeString('test', 3)).to.throw();
			});
		});

		describe('isValidSID', () => {
			it('should return true for valid SIDs', () => {
				expect(isValidSID('user-a1b2c3d4e5f6a7b8')).to.be.true;
			});

			it('should return false for invalid SIDs', () => {
				expect(isValidSID('invalid')).to.be.false;
			});
		});

		describe('isValidTimestamp', () => {
			it('should return true for valid timestamps', () => {
				const now = Math.floor(Date.now() / 1000);
				expect(isValidTimestamp(now)).to.be.true;
			});

			it('should return false for invalid timestamps', () => {
				expect(isValidTimestamp(-1)).to.be.false;
				expect(isValidTimestamp('not a number')).to.be.false;
			});
		});

		describe('isValidHex', () => {
			it('should return true for valid hex', () => {
				expect(isValidHex('deadbeef')).to.be.true;
			});

			it('should return false for invalid hex', () => {
				expect(isValidHex('xyz')).to.be.false;
			});
		});
	});

	describe('Injection Prevention', () => {
		it('should prevent SQL injection attempts', () => {
			const sqlInjection = "'; DROP TABLE users; --";
			// SafeString will allow this as it doesn't contain XSS patterns
			// But the schema prevents it from being used in unsafe contexts
			expect(() => SIDSchema.parse(sqlInjection)).to.throw();
		});

		it('should prevent NoSQL injection attempts', () => {
			const noSqlInjection = '{"$ne": null}';
			expect(() => SIDSchema.parse(noSqlInjection)).to.throw();
		});

		it('should prevent command injection attempts', () => {
			const cmdInjection = '; rm -rf /';
			expect(() => DomainNameSchema.parse(cmdInjection)).to.throw();
		});

		it('should prevent path traversal attempts', () => {
			const pathTraversal = '../../etc/passwd';
			expect(() => DomainNameSchema.parse(pathTraversal)).to.throw();
		});
	});
});
