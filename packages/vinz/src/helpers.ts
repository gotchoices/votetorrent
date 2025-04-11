import { sha256 } from 'multiformats/hashes/sha2';
import { utils, CURVE } from '@noble/secp256k1';
import { invert } from '@noble/curves/abstract/modular';

export function bigintToBytes(num: bigint, bytes = 32) {
	const hex = num.toString(16).padStart(bytes * 2, '0');
	if (hex.length > bytes * 2) {
		throw new Error(`bigint ${num} is too large to fit in ${bytes} bytes`);
	}
	const buffer = new Uint8Array(bytes);
	for (let i = 0; i < bytes; i++) {
		buffer[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return buffer;
}

export async function hashBytes(...items: Uint8Array[]): Promise<Uint8Array> {
	const concatenated = new Uint8Array(items.reduce((len, item) => len + item.length, 0));
	let offset = 0;
	items.forEach(item => {
		concatenated.set(item, offset);
		offset += item.length;
	});
	const hashResult = await sha256.digest(concatenated);
	return hashResult.digest;
}

// ----- SECP256k1 & Polynomial Helpers ----- //

export function ensureValidPrivateKey(key: Uint8Array): Uint8Array {
	try {
		utils.normPrivateKeyToScalar(key); // This will throw if the key is invalid
		return key;
	} catch (error) {
		throw new Error('Invalid private key provided: must be a valid 32-byte secp256k1 private key scalar');
	}
}

// Evaluate polynomial P(x) = coeffs[0] + coeffs[1]*x + ... + coeffs[k]*x^k mod n
export function evaluatePolynomial(coeffs: bigint[], x: bigint, n: bigint = CURVE.n): bigint {
	let result = 0n;
	let xPower = 1n;
	for (const coeff of coeffs) {
		result = (result + coeff * xPower) % n;
		xPower = (xPower * x) % n;
	}
	// Ensure the final result is in the range [0, n-1]
	return (result + n) % n;
}

// Lagrange interpolation to find P(0) given points {x_i, y_i}
// Points should be { x: participantId (bigint, non-zero index), y: shareValue (bigint) }
export function lagrangeInterpolateAtZero(points: { x: bigint; y: bigint }[], n: bigint = CURVE.n): bigint {
	let secret = 0n;
	const k = points.length;

	if (k === 0) {
		throw new Error("Cannot interpolate with zero points.");
	}

	for (let i = 0; i < k; i++) {
		const xi = points[i]!.x;
		const yi = points[i]!.y;

		if (xi === 0n) {
			throw new Error("Lagrange interpolation requires non-zero x coordinates (participant IDs).");
		}

		let basis = 1n;
		for (let j = 0; j < k; j++) {
			if (i === j) continue;
			const xj = points[j]!.x;

			if (xj === 0n) {
				throw new Error("Lagrange interpolation requires non-zero x coordinates (participant IDs).");
			}
			if (xi === xj) {
				throw new Error(`Lagrange interpolation failed: duplicate x value ${xi}`);
			}

			// Calculate L_i(0) = product_{j!=i} x_j / (x_j - x_i)
			const numerator = xj;
			const denominator = (xj - xi + n) % n;
			const invDenominator = invert(denominator, n);
			basis = (basis * numerator * invDenominator) % n;
		}
		secret = (secret + yi * basis) % n;
	}
	// Ensure result is positive
	return (secret + n) % n;
}
