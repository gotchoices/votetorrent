import { z } from 'zod';

/**
 * Input Validation Schemas for VoteTorrent
 *
 * This module provides comprehensive validation using Zod to prevent:
 * - Injection attacks (SQL, NoSQL, Command injection)
 * - XSS attacks
 * - Data corruption
 * - Type confusion attacks
 *
 * All user input and external data MUST be validated before use.
 *
 * @remarks
 * This addresses the A03: Injection vulnerability identified in the security audit.
 */

// ============================================================================
// Common Types
// ============================================================================

/**
 * SID (Secure Identifier) validation
 * Format: prefix-hexadecimal
 * Example: "user-a3f5e8b2c1d4f6e9"
 */
export const SIDSchema = z
	.string()
	.regex(
		/^[a-z]+-[0-9a-f]{16,64}$/,
		'SID must be in format: prefix-hexadecimal'
	)
	.refine(
		(sid) => {
			const parts = sid.split('-');
			return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length >= 16;
		},
		{ message: 'Invalid SID format' }
	);

/**
 * Timestamp validation (Unix timestamp in seconds or milliseconds)
 */
export const TimestampSchema = z
	.number()
	.int()
	.positive()
	.refine(
		(ts) => {
			// Accept both seconds (10 digits) and milliseconds (13 digits)
			const now = Date.now();
			const year2000Ms = 946684800000; // Jan 1, 2000 in milliseconds
			const hundredYearsFromNow = now + (100 * 365 * 24 * 60 * 60 * 1000);

			// Convert to milliseconds if it looks like seconds (< 10^12)
			const tsMs = ts < 1e12 ? ts * 1000 : ts;

			// Reject timestamps before year 2000 or more than 100 years in the future
			return tsMs >= year2000Ms && tsMs < hundredYearsFromNow;
		},
		{ message: 'Timestamp must be within reasonable range' }
	);

/**
 * Hexadecimal string validation
 */
export const HexStringSchema = z
	.string()
	.regex(/^[0-9a-f]+$/i, 'Must be valid hexadecimal')
	.refine((hex) => hex.length % 2 === 0, {
		message: 'Hex string must have even length',
	});

/**
 * URL validation with protocol restrictions
 */
export const URLSchema = z
	.string()
	.url()
	.refine(
		(url) => {
			const validProtocols = ['https:', 'http:', 'ipfs:'];
			try {
				const parsed = new URL(url);
				return validProtocols.includes(parsed.protocol);
			} catch {
				return false;
			}
		},
		{ message: 'URL must use https, http, or ipfs protocol' }
	);

/**
 * Safe string validation (prevents XSS and injection)
 */
export const SafeStringSchema = z
	.string()
	.min(1)
	.max(1000)
	.refine(
		(str) => {
			// Reject strings with potential XSS/injection patterns
			const dangerousPatterns = [
				/<script/i,
				/javascript:/i,
				/on\w+\s*=/i, // Event handlers like onclick=
				/\$\{/,       // Template literals
				/`/,          // Backticks
			];
			return !dangerousPatterns.some((pattern) => pattern.test(str));
		},
		{ message: 'String contains potentially dangerous characters' }
	);

/**
 * Domain name validation
 */
export const DomainNameSchema = z
	.string()
	.regex(
		/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i,
		'Must be a valid domain name'
	)
	.max(253);

// ============================================================================
// Image and Media
// ============================================================================

export const ImageRefSchema = z.object({
	cid: z.string().optional(),
	url: URLSchema,
});

export const VideoRefSchema = z.object({
	cid: z.string().optional(),
	url: URLSchema,
});

// ============================================================================
// Signature and Cryptography
// ============================================================================

export const SignatureSchema = z.object({
	signature: HexStringSchema.min(64).max(256),
	signerKey: HexStringSchema.min(66).max(130), // Compressed or uncompressed public key
});

// ============================================================================
// User Models
// ============================================================================

export const UserKeyTypeSchema = z.enum(['M', 'Y']);

export const UserKeySchema = z.object({
	key: HexStringSchema.min(32),
	type: UserKeyTypeSchema,
	expiration: TimestampSchema,
});

export const UserInfoSchema = z.object({
	name: SafeStringSchema.min(1).max(100),
	image: ImageRefSchema,
});

export const UserInitSchema = UserInfoSchema.extend({
	userKey: UserKeySchema,
});

export const UserSchema = z.object({
	sid: SIDSchema,
	name: SafeStringSchema.min(1).max(100),
	image: ImageRefSchema,
	activeKeys: z.array(UserKeySchema).min(1).max(10),
});

export const DefaultUserSchema = z.object({
	name: SafeStringSchema.min(1).max(100),
	image: ImageRefSchema,
});

// ============================================================================
// Authority Models
// ============================================================================

export const AuthoritySchema = z.object({
	sid: SIDSchema,
	name: SafeStringSchema.min(1).max(200),
	domainName: DomainNameSchema,
	imageRef: ImageRefSchema,
	signature: SignatureSchema,
});

// ============================================================================
// Network Models
// ============================================================================

/**
 * Multiaddr validation (libp2p format)
 */
export const MultiAddrSchema = z
	.string()
	.regex(
		/^\/ip[46]\/[\da-f:.]+\/tcp\/\d+\/p2p\/[A-Za-z0-9]+$/,
		'Must be a valid multiaddr'
	);

export const NetworkReferenceSchema = z.object({
	hash: HexStringSchema.min(32).max(128),
});

export const NetworkPoliciesSchema = z.object({
	numberRequiredTSAs: z.number().int().positive().max(10),
	timestampAuthorities: z
		.array(z.object({ url: URLSchema }))
		.min(1)
		.max(10),
	electionType: z.enum(['adhoc', 'official']),
});

export const NetworkRevisionSchema = z.object({
	networkSid: SIDSchema,
	revision: z.number().int().positive().max(1000000),
	timestamp: TimestampSchema,
	name: SafeStringSchema.min(1).max(200),
	imageRef: ImageRefSchema,
	relays: z.array(MultiAddrSchema).min(1).max(20),
	policies: NetworkPoliciesSchema,
	signature: SignatureSchema,
});

// ============================================================================
// Election Models
// ============================================================================

export const ElectionTypeSchema = z.enum(['adhoc', 'official']);

export const ElectionSummarySchema = z.object({
	sid: SIDSchema,
	title: SafeStringSchema.min(1).max(200),
	authorityName: SafeStringSchema.min(1).max(200),
	date: TimestampSchema,
	type: ElectionTypeSchema,
});

// ============================================================================
// Validation Helper Functions
// ============================================================================

/**
 * Validates data against a schema and returns typed result
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated and typed data
 * @throws ZodError if validation fails
 */
export function validate<T>(schema: z.ZodSchema<T>, data: unknown): T {
	return schema.parse(data);
}

/**
 * Safely validates data and returns result with error handling
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Success or error result
 */
export function safeValidate<T>(
	schema: z.ZodSchema<T>,
	data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
	const result = schema.safeParse(data);
	if (result.success) {
		return { success: true, data: result.data };
	}
	return { success: false, error: result.error };
}

/**
 * Validates and sanitizes user input string
 * @param input - User input to sanitize
 * @param maxLength - Maximum allowed length
 * @returns Sanitized string
 */
export function sanitizeString(input: unknown, maxLength: number = 1000): string {
	const schema = SafeStringSchema.max(maxLength);
	return schema.parse(input);
}

/**
 * Validates a SID format
 * @param sid - SID to validate
 * @returns true if valid
 */
export function isValidSID(sid: unknown): sid is string {
	return SIDSchema.safeParse(sid).success;
}

/**
 * Validates a timestamp
 * @param timestamp - Timestamp to validate
 * @returns true if valid
 */
export function isValidTimestamp(timestamp: unknown): timestamp is number {
	return TimestampSchema.safeParse(timestamp).success;
}

/**
 * Validates hex string
 * @param hex - Hex string to validate
 * @returns true if valid
 */
export function isValidHex(hex: unknown): hex is string {
	return HexStringSchema.safeParse(hex).success;
}
