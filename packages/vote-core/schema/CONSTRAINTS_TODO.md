# Database Constraints TODO

This document tracks the missing database constraints identified in the VoteTorrent schema.

## Summary

The following constraints are marked as TODO in the schema and need to be implemented:

1. **JSON Validation Constraints** - Validate JSON structure and content
2. **Hash Validation Constraint** - Validate H16(Sid) hash
3. **Image Reference Validation** - Validate ImageRef JSON structure

## Detailed Constraint Requirements

### 1. Network Table Constraints

#### HashValid Constraint (Line 22)
```sql
-- TODO: constraint HashValid check on insert (Hash = H16(Sid))
```

**Status**: ⚠️ **Blocked** - Requires H16() function implementation

**Description**: Validates that the Hash field is the first 16 characters of the SHA-256 hash of the Sid.

**Dependencies**:
- Needs H16() SQL function to compute first 16 chars of hash
- Similar to Digest() but truncated

**Proposed Implementation**:
```sql
-- Add to custom-functions.ts
export const h16Func = createScalarFunction(
	{
		name: 'H16',
		numArgs: 1,
		deterministic: true,
	},
	(value: SqlValue): SqlValue => {
		if (value === null || value === undefined) return null;
		const hash = hashMessage(String(value));
		return hash.substring(0, 16); // First 16 hex chars
	}
);

-- In schema
constraint HashValid check on insert (Hash = H16(Sid))
```

#### ImageRefValid Constraint (Lines 26, 64)
```sql
-- TODO: constraint ImageRefValid check (ImageRef is a valid image reference JSON)
```

**Status**: ✅ **Ready to Implement**

**Description**: Validates that ImageRef is valid JSON with optional 'url' and/or 'cid' string fields.

**TypeScript Type**:
```typescript
export type ImageRef = {
  url?: string;
  cid?: string;
}
```

**Proposed Implementation**:
```sql
constraint ImageRefValid check (
	ImageRef is null
	or (
		json_valid(ImageRef)
		and json_type(ImageRef) = 'object'
		and (json_extract(ImageRef, '$.url') is null or json_type(json_extract(ImageRef, '$.url')) = 'text')
		and (json_extract(ImageRef, '$.cid') is null or json_type(json_extract(ImageRef, '$.cid')) = 'text')
		-- Ensure no extra keys
		and json_array_length(json_each(ImageRef).key) <= 2
	)
)
```

#### RelaysValid Constraint (Lines 14, 27)
```sql
-- TODO: constraint RelaysValid check (Relays is a valid array of strings)
```

**Status**: ✅ **Ready to Implement**

**Description**: Validates that Relays is a JSON array of strings (multiaddresses).

**TypeScript Type**:
```typescript
type Relays = string[]; // Array of multiaddress strings
```

**Proposed Implementation**:
```sql
constraint RelaysValid check (
	json_valid(Relays)
	and json_type(Relays) = 'array'
	and not exists (
		select 1 from json_each(Relays)
		where json_each.type != 'text'
	)
)
```

#### TimestampAuthoritiesValid Constraint (Lines 15, 28)
```sql
-- TODO: constraint TimestampAuthoritiesValid check (TimestampAuthorities is a valid array of { url: string })
```

**Status**: ✅ **Ready to Implement**

**Description**: Validates that TimestampAuthorities is a JSON array of objects with 'url' string field.

**TypeScript Type**:
```typescript
type TimestampAuthority = { url: string };
type TimestampAuthorities = TimestampAuthority[];
```

**Proposed Implementation**:
```sql
constraint TimestampAuthoritiesValid check (
	json_valid(TimestampAuthorities)
	and json_type(TimestampAuthorities) = 'array'
	and not exists (
		select 1 from json_each(TimestampAuthorities) tsa
		where json_type(tsa.value) != 'object'
		   or json_type(json_extract(tsa.value, '$.url')) != 'text'
		   or json_extract(tsa.value, '$.url') is null
	)
)
```

### 2. Admin Table Constraints

#### ThresholdPoliciesValid Constraint (Lines 87, 246)
```sql
-- TODO: constraint ThresholdPoliciesValid check (valid json array of { scope: string, threshold: integer })
```

**Status**: ✅ **Ready to Implement**

**Description**: Validates that ThresholdPolicies is a JSON array of objects with 'scope' (string) and 'threshold' (integer) fields.

**TypeScript Type**:
```typescript
type ThresholdPolicy = {
  scope: Scope;
  threshold: number;
};
type ThresholdPolicies = ThresholdPolicy[];
```

**Proposed Implementation**:
```sql
constraint ThresholdPoliciesValid check (
	json_valid(ThresholdPolicies)
	and json_type(ThresholdPolicies) = 'array'
	and not exists (
		select 1 from json_each(ThresholdPolicies) tp
		where json_type(tp.value) != 'object'
		   or json_type(json_extract(tp.value, '$.scope')) != 'text'
		   or json_type(json_extract(tp.value, '$.threshold')) != 'integer'
		   or json_extract(tp.value, '$.scope') is null
		   or json_extract(tp.value, '$.threshold') is null
		   or json_extract(tp.value, '$.threshold') < 1
		   -- Validate scope is valid
		   or json_extract(tp.value, '$.scope') not in (select Code from Scope)
	)
)
```

## Implementation Plan

### Phase 1: Implement JSON Validation Constraints (Ready Now)

These can be implemented immediately using standard SQL JSON functions:

1. ✅ ImageRefValid - Validate ImageRef JSON structure
2. ✅ RelaysValid - Validate Relays array of strings
3. ✅ TimestampAuthoritiesValid - Validate TSA array structure
4. ✅ ThresholdPoliciesValid - Validate threshold policies structure

**Action Items**:
- [ ] Update votetorrent.qsql with JSON validation constraints
- [ ] Test constraints with sample data
- [ ] Document constraint behavior

### Phase 2: Implement H16() Function (Requires Code Changes)

This requires adding a new custom function to vote-engine:

1. ⚠️ HashValid - Requires H16() function

**Action Items**:
- [ ] Add H16() function to custom-functions.ts
- [ ] Register H16() with Quereus database
- [ ] Add tests for H16() function
- [ ] Update votetorrent.qsql with HashValid constraint

## Testing Strategy

Each constraint should be tested with:

1. **Valid Data** - Constraint passes
2. **Invalid JSON** - Constraint fails
3. **Invalid Structure** - Constraint fails (wrong types, missing fields)
4. **Invalid Values** - Constraint fails (invalid scope, negative threshold, etc.)
5. **NULL Values** - Constraint handles NULL appropriately
6. **Edge Cases** - Empty arrays, empty objects, etc.

## Notes

- All constraints use Quereus/SQLite JSON functions
- Constraints are checked on INSERT and UPDATE unless otherwise specified
- NULL values should be handled explicitly (typically allowed unless field is NOT NULL)
- Performance impact should be minimal as JSON validation is done in-memory

## References

- [SQLite JSON Functions](https://www.sqlite.org/json1.html)
- [Quereus Documentation](https://github.com/datawisdomai/quereus)
- VoteTorrent Schema: `packages/vote-core/schema/votetorrent.qsql`
- Custom Functions: `packages/vote-engine/src/database/custom-functions.ts`
