// ── Query building ──────────────────────────────────────
// Turns a caller's option bag into the query string both servers understand:
// array shorthands joined, filter callbacks resolved, `expand` normalised, and
// the field projection merged so expanded data survives strict projection.

import type { ExpandContext } from "../expand";
import { normalizeExpand } from "../expand";
import { mergeExpandFields } from "../projection";

/** The service state query building needs. */
export interface QueryContext {
	/** Schema-aware expand normalisation. */
	expand: ExpandContext;
	/** Resolves `options.fields` / `select()` / schema default. */
	effectiveFields(optionsFields?: string): string | undefined;
	/** Resolves a `filter` callback into a string / FilterExpr. */
	resolveFilter(filter: unknown): unknown;
}

/** A built request query. */
export interface BuiltQuery {
	/** The serialised query string (no leading `?`). */
	qs: string;
	/**
	 * Top-level relation → leaf fields to apply client-side, for servers that
	 * return the full expanded record regardless of `fields`.
	 */
	narrow: Map<string, string[]>;
}

/**
 * Build the query string for a list request.
 *
 * Mutates `queryParams` in place (it is always a fresh rest object) and drops
 * keys whose value is `undefined` only implicitly, via `String()` — matching
 * the historical serialisation exactly.
 */
export function buildListQuery(
	ctx: QueryContext,
	page: number,
	perPage: number,
	queryParams: Record<string, unknown>,
): BuiltQuery {
	// Array shorthands (`sort: ["-title"]`, `expand: ["author"]`) join to
	// the comma-separated form the server expects.
	if (Array.isArray(queryParams.sort)) {
		queryParams.sort = queryParams.sort.join(",");
	}
	if (Array.isArray(queryParams.expand)) {
		queryParams.expand = queryParams.expand.join(",");
	}
	// Resolve a `filter` callback (receives the typed `where` helper) into
	// a concrete string / FilterExpr before serialization.
	if (typeof queryParams.filter === "function") {
		queryParams.filter = ctx.resolveFilter(queryParams.filter);
	}
	// Normalise `expand`: dotted tokens that select fields of a relation are
	// rewritten to PocketBase's `expand` + `fields=expand.<rel>.<field>`
	// form (raw `expand=owner.name` is silently ignored by the server).
	const expandInfo = normalizeExpand(
		typeof queryParams.expand === "string" ? queryParams.expand : undefined,
		ctx.expand,
	);
	if (expandInfo.expand !== undefined) {
		queryParams.expand = expandInfo.expand;
	}
	// Resolve the effective `fields` projection (select() preset or schema
	// default) and keep the expanded data alive under strict projection.
	const fields = mergeExpandFields(
		ctx.effectiveFields(queryParams.fields as string | undefined),
		expandInfo,
	);
	if (fields !== undefined) {
		queryParams.fields = fields;
	}
	const qs = new URLSearchParams(
		Object.fromEntries(
			Object.entries({
				page: String(page),
				perPage: String(perPage),
				...queryParams,
			}).map(([k, v]) => [k, String(v)]),
		),
	).toString();
	return { qs, narrow: expandInfo.narrow };
}

/** Build the query string for a single-record read. */
export function buildReadQuery(
	ctx: QueryContext,
	options?: { expand?: string | readonly string[]; fields?: string },
): BuiltQuery {
	const rawExpand = Array.isArray(options?.expand)
		? options.expand.join(",")
		: typeof options?.expand === "string"
			? options.expand
			: undefined;
	const expandInfo = normalizeExpand(rawExpand, ctx.expand);
	const fields = mergeExpandFields(
		ctx.effectiveFields(options?.fields),
		expandInfo,
	);
	const qs = new URLSearchParams();
	if (fields !== undefined) qs.set("fields", fields);
	if (rawExpand !== undefined) qs.set("expand", expandInfo.expand ?? rawExpand);
	return { qs: qs.toString(), narrow: expandInfo.narrow };
}