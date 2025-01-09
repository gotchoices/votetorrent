export function count1s(o: number[]) {
    // TODO: potentially use ipopcnt wasm instruction: https://webassembly.github.io/spec/core/exec/numerics.html#xref-exec-numerics-op-ipopcnt-mathrm-ipopcnt-n-i
    function count1s32(n: number) {
        n = n - ((n >> 1) & 0x55555555);
        n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
        n = (n + (n >> 4)) & 0x0f0f0f0f;
        n = n + (n >> 8);
        n = n + (n >> 16);
        return n & 0x3f;
    }
    return o.reduce((p, c) => p + count1s32(c), 0);
}

export function first0(o: number[]) {
    for (let i = 0; i < o.length; ++i) {
        const leadingOnes = Math.clz32(~o[i]);
        if (leadingOnes < 32) {
            return i * 32 + leadingOnes;
        }
    }
    return -1;  // none found
}

export function isOccupied(o: number[], i: number) {
		return (o[Math.trunc(i / 32)] & (1 << 31 - (i % 32))) !== 0;
}

export function setOccupancy(o: number[], i: number) {
	const index = Math.trunc(i / 32);
	o[index] |= 1 << 31 - (i % 32);
}

export function setFirstNOccupied(o: number[], n: number) {
    for (let i = 0; i < o.length; ++i) {
        if (n >= (i + 1) * 32) {
            o[i] |= 0xFFFFFFFF;
        } else if (n > i * 32) {
            const m = 32 - (n % 32);
            o[i] |= (-1 >>> m) << m;
        }
    }
    return -1;  // none found
}

export function clearedOccupancy(o: number[], i: number): [index: number, newValue: number] {
    const index = Math.trunc(i / 32);
    return [index, o[index] & ~(1 << 31 - (i % 32))] as const;
}

export function clearOccupancy(o: number[], i: number) {
    const index = Math.trunc(i / 32);
    o[index] &= ~(1 << 31 - (i % 32));
}
