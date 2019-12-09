import { useEffect, useRef, useState, useCallback, useLayoutEffect, EffectCallback } from "react";
import { noop } from "../utils";
import { CodeStreamState } from "../store";
import { useSelector } from "react-redux";
import { getUsernames } from "../store/users/reducer";
import { markdownify } from "../Stream/Markdowner";

type Fn = () => void;

export function useDidMount(callback: EffectCallback) {
	useEffect(callback, []);
}

/*
	This hook runs the provided callback only when the component has been mounted and provided dependencies change.
	The callback IS NOT invoked when the component is initially mounted.
*/
export function useUpdates(callback: Fn, dependencies: any[] = []) {
	const isMountedRef = useRef(false);
	useDidMount(() => {
		isMountedRef.current = true;
	});
	useEffect(isMountedRef.current ? callback : noop, dependencies);
}

export function useInterval(callback: Fn, delay = 1000) {
	const savedCallback = useRef<Fn>(callback);

	// Remember the latest callback.
	useEffect(() => {
		savedCallback.current = callback;
	}, [callback]);

	// Set up the interval.
	useEffect(() => {
		function tick() {
			savedCallback.current!();
		}
		let id = setInterval(tick, delay);
		return () => clearInterval(id);
	}, [delay]);
}

export function useTimeout(callback: Fn, delay: number) {
	useEffect(() => {
		let id = setTimeout(function() {
			callback();
		}, delay);

		return () => clearTimeout(id);
	}, [callback, delay]);
}

export function useRetryingCallback(fn: () => Promise<any>) {
	const canRun = useRef(true);
	useInterval(async () => {
		if (!canRun.current) {
			return;
		}
		try {
			canRun.current = false;
			await fn();
		} catch (error) {}
		canRun.current = true;
	}, 5000);
}

type RectResult = {
	bottom: number;
	height: number;
	left: number;
	right: number;
	top: number;
	width: number;
};

function getRect<T extends HTMLElement>(element?: T): RectResult {
	let rect: RectResult = {
		bottom: 0,
		height: 0,
		left: 0,
		right: 0,
		top: 0,
		width: 0
	};
	if (element) rect = element.getBoundingClientRect();
	return rect;
}

export function useRect<T extends HTMLElement>(
	ref: React.RefObject<T>,
	dependencies: any[] = []
): RectResult {
	const [rect, setRect] = useState<RectResult>(
		ref && ref.current ? getRect(ref.current) : getRect()
	);

	const handleResize = useCallback(() => {
		if (!ref.current) return;
		setRect(getRect(ref.current)); // Update client rect
	}, [ref]);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;

		handleResize();

		// @ts-ignore
		if (typeof ResizeObserver === "function") {
			// @ts-ignore
			let resizeObserver = new ResizeObserver(() => handleResize());
			resizeObserver.observe(element);
			return () => {
				if (!resizeObserver) return;
				resizeObserver.disconnect();
				resizeObserver = null;
			};
		} else {
			window.addEventListener("resize", handleResize); // Browser support, remove freely
			return () => window.removeEventListener("resize", handleResize);
		}
	}, dependencies);

	return rect;
}

export function useIntersectionObserver(
	callback: IntersectionObserverCallback,
	options: Pick<IntersectionObserverInit, "threshold" | "rootMargin"> = {}
) {
	const callbackRef = useRef(callback);
	useEffect(() => {
		callbackRef.current = callback;
	});
	const observerRef = useRef<IntersectionObserver>();
	const rootRef = useRef<HTMLElement>(null);
	const targetRef = useCallback(element => {
		if (element == undefined) {
			// clean up
			if (observerRef.current != undefined) {
				observerRef.current.disconnect();
				observerRef.current = undefined;
			}
			return;
		}

		// can't observe yet
		if (!rootRef.current) return;

		const observer = new IntersectionObserver(
			function(...args: Parameters<IntersectionObserverCallback>) {
				callbackRef.current.call(undefined, ...args);
			},
			{
				...options,
				root: rootRef.current
			}
		);
		observer.observe(element);

		observerRef.current = observer;
	}, []);

	useEffect(() => {
		return () => {
			observerRef.current && observerRef.current.disconnect();
		};
	}, []);

	return { targetRef, rootRef: rootRef as any };
}

export function useMarkdownifyToHtml() {
	const derivedState = useSelector((state: CodeStreamState) => {
		const currentUser = state.users[state.session.userId!];
		return { currentUserName: currentUser.username, usernames: getUsernames(state) };
	});

	return useCallback(
		(text: string) => {
			let html: string;
			if (text == null || text === "") {
				html = "";
			} else {
				const me = derivedState.currentUserName;
				html = markdownify(text).replace(/@(\w+)/g, (match: string, name: string) => {
					if (
						derivedState.usernames.some(
							n => name.localeCompare(n, undefined, { sensitivity: "accent" }) === 0
						)
					) {
						return `<span class="at-mention${
							me.localeCompare(name, undefined, { sensitivity: "accent" }) === 0 ? " me" : ""
						}">${match}</span>`;
					}

					return match;
				});
			}

			return html;
		},
		[derivedState.usernames]
	);
}
