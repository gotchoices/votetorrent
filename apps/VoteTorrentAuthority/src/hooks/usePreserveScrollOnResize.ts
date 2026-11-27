import { useCallback, useEffect, useRef } from "react";
import { useWindowDimensions } from "react-native";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from "react-native";

type ScrollTarget = {
	scrollTo: (opts: { x?: number; y?: number; animated?: boolean }) => void;
	scrollToEnd: (opts?: { animated?: boolean }) => void;
};

export interface PreserveScrollHandlers {
	onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
	onLayout?: (e: LayoutChangeEvent) => void;
	onContentSizeChange?: (w: number, h: number) => void;
}

const BOTTOM_TOLERANCE = 2;
const SETTLE_CAP_MS = 300;

interface Pending {
	wasAtBottom: boolean;
	offset: number;
	gotLayout: boolean;
	gotContent: boolean;
}

/**
 * Keeps a ScrollView's place across a rotation.
 *
 * The trigger is a WINDOW WIDTH change: rotation and split-screen change the width, the soft
 * keyboard never does (on API < 35 the IME resizes only the height; on 35+ it resizes nothing),
 * so keyboard show/hide behaviour is left entirely to the caller's own logic. When the width
 * changes we remember whether the list was at the bottom (or its offset), wait for BOTH the new
 * layout height and the new content height (or a 300 ms cap), then restore once: scrollToEnd if it
 * was at the bottom, else scrollTo the old offset clamped to the new scrollable range.
 *
 * Returns handlers to spread onto the ScrollView (caller handlers are forwarded).
 */
export function usePreserveScrollOnResize(
	scrollRef: { current: ScrollTarget | null },
	handlers: PreserveScrollHandlers = {},
) {
	const { width } = useWindowDimensions();
	const lastWidth = useRef<number | null>(null);
	const offset = useRef(0);
	const layoutH = useRef(0);
	const contentH = useRef(0);
	const pending = useRef<Pending | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	const clearTimer = () => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
	};

	const apply = useCallback(() => {
		const p = pending.current;
		pending.current = null;
		clearTimer();
		if (!p) return;
		const target = scrollRef.current;
		if (!target) return;
		if (p.wasAtBottom) {
			target.scrollToEnd({ animated: false });
		} else {
			const max = Math.max(0, contentH.current - layoutH.current);
			target.scrollTo({ y: Math.min(p.offset, max), animated: false });
		}
	}, [scrollRef]);

	useEffect(() => {
		if (lastWidth.current !== null && lastWidth.current !== width) {
			pending.current = {
				wasAtBottom: offset.current + layoutH.current >= contentH.current - BOTTOM_TOLERANCE,
				offset: offset.current,
				gotLayout: false,
				gotContent: false,
			};
			clearTimer();
			timer.current = setTimeout(apply, SETTLE_CAP_MS);
		}
		lastWidth.current = width;
	}, [width, apply]);

	useEffect(() => clearTimer, []);

	const settle = () => {
		const p = pending.current;
		if (p && p.gotLayout && p.gotContent) apply();
	};

	const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
		offset.current = e.nativeEvent.contentOffset.y;
		handlersRef.current.onScroll?.(e);
	}, []);

	const onLayout = useCallback(
		(e: LayoutChangeEvent) => {
			layoutH.current = e.nativeEvent.layout.height;
			if (pending.current) pending.current.gotLayout = true;
			handlersRef.current.onLayout?.(e);
			settle();
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[apply],
	);

	const onContentSizeChange = useCallback(
		(w: number, h: number) => {
			contentH.current = h;
			if (pending.current) pending.current.gotContent = true;
			handlersRef.current.onContentSizeChange?.(w, h);
			settle();
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[apply],
	);

	return { onScroll, onLayout, onContentSizeChange, scrollEventThrottle: 16 };
}
