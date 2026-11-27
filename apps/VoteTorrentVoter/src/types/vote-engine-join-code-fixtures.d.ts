// Type surface for `@votetorrent/vote-engine/test/fixtures/join-code-fixtures`.
//
// That specifier is a jest-only moduleNameMapper alias (jest.config.js, mapped by phase 64 plan 01
// to packages/vote-engine/test/fixtures/join-code-fixtures.generated.ts). tsc cannot resolve it
// (TS2307), so this file declares the generated file's exports. Keep it in sync if the fixture
// shape changes.
declare module '@votetorrent/vote-engine/test/fixtures/join-code-fixtures' {
	export type JoinCodeFixtureName =
		| 'v2-1-member'
		| 'v2-2-members'
		| 'v2-6-members'
		| 'v2-non-ascii-name'
		| 'v1-legacy-1-member'
		| 'v1-114-no-prefix'

	export type JoinCodeFixture = {
		readonly text: string
		readonly name: string
		readonly fingerprint: string
		readonly networkHash: string
		readonly members: number
		readonly chars: number
	}

	export const JOIN_CODE_FIXTURES: Readonly<Record<JoinCodeFixtureName, JoinCodeFixture>>
}
