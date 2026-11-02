/**
 * useStrandChanges — re-run a screen's read when one of `tables` changes on the open network strand.
 *
 * Subscribed only while the screen is focused: an unfocused screen re-reads on focus anyway (its existing
 * useFocusEffect), so a change while it is hidden costs nothing. `onChange` may change every render; the
 * latest one runs. Table names are qualified ('App.Election').
 */
import {useCallback, useRef} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {strandChanges} from '../engines/strand-changes';

export function useStrandChanges(tables: readonly string[], onChange: () => void, label: string): void {
	const latest = useRef(onChange);
	latest.current = onChange;
	const key = tables.join('|');
	useFocusEffect(
		useCallback(
			() => strandChanges.subscribe(key.split('|'), () => latest.current(), {label}),
			[key, label],
		),
	);
}
