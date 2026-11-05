import {useEffect, useState} from 'react';

export interface InfoReadState<T> {
	data?: T;
	loading: boolean;
	failed: boolean;
}

/**
 * Runs `load` whenever it changes to a non-null loader (a dialog opened, or opened for a different
 * item) and drops the result of any read that a newer one has superseded or that resolves after
 * the dialog closed. `load` must be memoized by the caller — a new function identity is a new read.
 */
export function useInfoRead<T>(load: (() => Promise<T>) | null): InfoReadState<T> {
	const [state, setState] = useState<InfoReadState<T>>({loading: false, failed: false});

	useEffect(() => {
		if (!load) {
			setState({loading: false, failed: false});
			return;
		}
		let current = true;
		setState({loading: true, failed: false});
		load().then(
			data => {
				if (current) setState({data, loading: false, failed: false});
			},
			() => {
				if (current) setState({loading: false, failed: true});
			},
		);
		return () => {
			current = false;
		};
	}, [load]);

	return state;
}
