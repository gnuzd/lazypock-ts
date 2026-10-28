// ── Query-param helpers ─────────────────────────────────
// Shared by every service that builds list requests: the server's page-size
// ceiling, and the deterministic serialisation used as a cache/dedup key.

/**
 * Largest `perPage` the server accepts (`MAX_PER_PAGE` in lazypock's pagination).
 * `getFullList()` pages at this size by default and never asks for more: a larger
 * `perPage` is rejected with a 400 rather than clamped.
 */
export const MAX_PER_PAGE = 500;

/** Keep a requested page size within what the server accepts (1..MAX_PER_PAGE). */
export function clampBatch(batch: number): number {
	if (!Number.isFinite(batch)) return MAX_PER_PAGE;
	return Math.min(Math.max(1, Math.floor(batch)), MAX_PER_PAGE);
}

/**
 * A recursively-normalized request value: object keys sorted and
 * request-transport keys stripped, so functionally-identical calls share
 * one stable serialization key.
 */
type StableRequestValue =
	| string
	| number
	| boolean
	| null
	| StableRequestValue[]
	| { [key: string]: StableRequestValue };

/**
 * Request-transport options. They don't change what the server returns, so
 * they are excluded from the dedup key — but only at the top level: a record
 * field that happens to be called `signal` is payload, not transport.
 */
const TRANSPORT_KEYS = new Set(["requestKey", "singleFlight", "fetch", "signal"]);

/**
 * Deterministic JSON stringify for building a stable cache/dedup key.
 * Object keys are sorted (so key order never changes the key) and the
 * top-level transport options are stripped.
 *
 * Cycles are reported as `"[Circular]"`; the visited set is a *path* stack so a
 * value referenced twice in a non-cyclic graph keeps its real content. Treating
 * a shared reference as a cycle would collapse structurally different option
 * bags onto one key, and single-flight would then hand a caller the wrong
 * response.
 */
export function stableStringify(value: unknown): string {
	const path = new Set<object>();
	const sort = (v: unknown, topLevel: boolean): StableRequestValue => {
		if (Array.isArray(v)) return v.map((el) => sort(el, false));
		if (v && typeof v === "object") {
			const obj = v as Record<string, unknown>;
			if (path.has(obj)) return "[Circular]";
			path.add(obj);
			const out: Record<string, StableRequestValue> = {};
			for (const k of Object.keys(obj).sort()) {
				if (topLevel && TRANSPORT_KEYS.has(k)) continue;
				out[k] = sort(obj[k], false);
			}
			path.delete(obj);
			return out;
		}
		// SAFETY: non-object values are JSON scalars (or undefined, which
		// JSON.stringify omits from objects) — all representable here.
		return v as StableRequestValue;
	};
	try {
		return JSON.stringify(sort(value, true));
	} catch {
		return String(value);
	}
}