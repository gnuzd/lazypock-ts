// ── Full-list pagination ────────────────────────────────
// `getFullList()` is implemented identically for records and for collections:
// split the option bag, clamp the batch to the server's ceiling, walk pages,
// and share one request key across the walk so concurrent identical fetches
// coalesce instead of duplicating.

import type { ListResult, RequestOptions } from "./types";
import { MAX_PER_PAGE, clampBatch, stableStringify } from "./query-params";

/**
 * Options that control the transport rather than the query. They must never
 * be serialised into the URL, and a caller passing them should not change the
 * shape of the request.
 */
const TRANSPORT_KEYS = new Set([
	"requestKey",
	"autoCancel",
	"cancelKey",
	"singleFlight",
	"fetch",
	"headers",
	"signal",
	"params",
]);

/** A `getFullList` option bag split into its query, transport and batch parts. */
export interface SplitListOptions {
	/** Query params for the request (`filter`, `sort`, `expand`, …). */
	query: Record<string, unknown>;
	/** Transport options, forwarded to each page request. */
	transport: RequestOptions;
	/** Page size, already clamped to the server's maximum. */
	batch: number;
}

/**
 * Split a `getFullList` option bag.
 *
 * `batch` controls the page size and is never sent; query params are
 * everything else that isn't a transport option.
 */
export function splitListOptions(
	options?: (Record<string, unknown> & RequestOptions) | undefined,
): SplitListOptions {
	const {
		batch: requestedBatch = MAX_PER_PAGE,
		...rest
	} = (options ?? {}) as Record<string, unknown> & RequestOptions;

	const query: Record<string, unknown> = {};
	const transport: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rest)) {
		if (TRANSPORT_KEYS.has(key)) transport[key] = value;
		else query[key] = value;
	}
	return {
		query,
		transport: transport as RequestOptions,
		batch: clampBatch(requestedBatch as number),
	};
}

/**
 * The stable request key for a whole full-list fetch.
 *
 * It is deliberately **not** per page — a per-page key would break dedup —
 * and the pages still advance correctly because each page's URL differs
 * (`page=N`), so the underlying default key is unique per page. Concurrent
 * identical `getFullList()` calls share this key via single-flight and
 * therefore fire one set of requests instead of two.
 *
 * @param scope Namespace for the key (the collection name, or `collections`).
 * @param query The query params the key is derived from.
 * @param requestKey A caller-supplied key, which always wins.
 */
export function fullListKey(
	scope: string,
	query: unknown,
	requestKey?: string | null,
): string {
	if (typeof requestKey === "string") return requestKey;
	return `getFullList:${scope}:${stableStringify(query)}`;
}

/**
 * Walk every page, collecting items until an empty page or the last page.
 *
 * Stops on an empty page even when `totalPages` claims more: a server that
 * miscounts must not spin forever.
 */
export async function paginateAll<T>(
	batch: number,
	fetchPage: (page: number, perPage: number) => Promise<ListResult<T> | null>,
): Promise<T[]> {
	const items: T[] = [];
	let page = 1;
	for (;;) {
		const res = await fetchPage(page, batch);
		if (!res || !res.items || res.items.length === 0) break;
		items.push(...res.items);
		if (page >= (res.totalPages ?? page)) break;
		page += 1;
	}
	return items;
}