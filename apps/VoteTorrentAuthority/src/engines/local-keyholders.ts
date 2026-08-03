// local-keyholders.ts — TEMPORARY DEV SCAFFOLD. DELETE when the cadre P2P
// keyholder-invite flow lands.
//
// Background: keyholder names entered at election create/revise are not persisted
// by the engine (createElection drops them; the revision read projections stub
// `keyholders: []`). The proper fix is the signed INVITE flow (invitee -> real
// User -> Keyholder row), which is blocked until cadre P2P exists. See
// .planning/debug/keyholders-not-persisted-on-create.md.
//
// Until then, this module stores the entered keyholder NAMES locally (per election
// id) in AsyncStorage so they are visible on the detail / revise screens. It is
// app-only: no schema, no engine, no signing/digest involvement. Per-device only,
// not synced over P2P, lost on reinstall/data-clear.
import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY_PREFIX = 'local-keyholders:'

const keyFor = (electionId: string): string => `${KEY_PREFIX}${electionId}`

/** Persist the keyholder names for an election. Empty list removes the entry. */
export async function saveLocalKeyholders(electionId: string, names: string[]): Promise<void> {
	const key = keyFor(electionId)
	if (!names.length) {
		await AsyncStorage.removeItem(key)
		return
	}
	await AsyncStorage.setItem(key, JSON.stringify(names))
}

/** Read the locally-stored keyholder names for an election. [] on miss/parse error. */
export async function getLocalKeyholders(electionId: string): Promise<string[]> {
	try {
		const raw = await AsyncStorage.getItem(keyFor(electionId))
		if (!raw) return []
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as string[]) : []
	} catch {
		return []
	}
}
