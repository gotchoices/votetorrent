// Helper function to generate deterministic UUIDs for testing
export function generateTrxId(num: number): `${string}-${string}-${string}-${string}-${string}` {
	// For testing, we'll use a fixed UUID and just change the last characters
	// This makes tests more deterministic while still using valid UUIDs
	return `00000000-0000-4000-a000-${num.toString().padStart(12, '0')}` as const;
}
