// ── Field projection ────────────────────────────────────
// Decides which fields a read asks for. Both servers project strictly, so the
// implicit system keys must be requested explicitly and internal fields must
// never be — getting this wrong silently drops `id` from every response.

import type { CollectionSchema } from "./schema";

/**
 * The implicit keys every record carries. They never appear in a collection
 * schema, but MUST be listed explicitly when projecting — the server applies
 * strict projection, so unrequested fields are dropped. Without them,
 * `getList`/`getOne` responses lose `id` (and `created`/`updated`), breaking
 * selection, edits and relation references.
 */
export const SYSTEM_FIELDS = [
	"id",
	"created",
	"updated",
	"collectionId",
	"collectionName",
] as const;

/**
 * Memoised per schema object. `visibleFields()` runs on every read, and the
 * schema is immutable for the lifetime of a service, so the string is built
 * once. A WeakMap keeps derived services (which share the schema object) in
 * the same cache entry without leaking.
 */
const visibleFieldsCache = new WeakMap<CollectionSchema, string | undefined>();

/**
 * All non-hidden, non-password, non-autodate field names from the schema,
 * prefixed with the implicit system keys.
 *
 * `undefined` when no schema fields are available (server decides — its
 * default returns every non-password field, including the system keys).
 */
export function visibleFields(schema: CollectionSchema | undefined): string | undefined {
	if (!schema?.fields) return undefined;
	const cached = visibleFieldsCache.get(schema);
	if (cached !== undefined || visibleFieldsCache.has(schema)) return cached;

	const visible = schema.fields
		.filter(
			(f) => !f.hidden && f.type !== "password" && f.type !== "autodate",
		)
		.map((f) => f.name);
	const result =
		visible.length === 0
			? undefined
			: // Dedupe in case a schema ever names a field after a system key.
				[
					...new Set([...SYSTEM_FIELDS, ...visible]),
				].join(",");

	visibleFieldsCache.set(schema, result);
	return result;
}

/**
 * Fields to send with reads, in precedence order:
 * 1. explicit `options.fields` (caller wins)
 * 2. `select()` preset
 * 3. schema default — all visible (non-hidden) fields plus the system keys
 */
export function effectiveFields(
	schema: CollectionSchema | undefined,
	preset: string | undefined,
	optionsFields?: string,
): string | undefined {
	if (optionsFields !== undefined) return optionsFields;
	if (preset !== undefined) {
		return preset === "*" ? visibleFields(schema) : preset;
	}
	return visibleFields(schema);
}

/** Normalised form of a caller's `expand` string (see `normalizeExpand`). */
export interface NormalizedExpand {
	/** Rewritten `expand` query param (relation paths only). */
	expand?: string;
	/** `fields` entries that keep/narrow the expanded data. */
	fieldSelectors: string[];
	/**
	 * Top-level relation → leaf field names to keep on the expanded record.
	 * Applied client-side so field selection also works on servers that don't
	 * project expanded records (the LazyPock server, unlike PocketBase, always
	 * returns the full related record).
	 */
	narrow: Map<string, string[]>;
}

/**
 * Merge the expand-preserving selectors into the base field projection.
 *
 * Both servers are kept happy at once:
 * - PocketBase drops the whole `expand` payload unless an `expand.<key>`
 *   entry is present in `fields`;
 * - the LazyPock server projects first (strict, top-level only) and then
 *   expands, so the relation *field* itself must be present in `fields`.
 *
 * We therefore add both the relation field (`cate`) and the
 * `expand.<key>` entry. When no projection is active, no `fields` param is
 * sent at all — a value like `*` plus other tokens is not a wildcard on
 * the LazyPock server (it is a strict take, yielding empty records) and
 * the server keeps `expand` by default when `fields` is absent.
 */
export function mergeExpandFields(
	base: string | undefined,
	info: NormalizedExpand,
): string | undefined {
	if (info.fieldSelectors.length === 0) return base;
	if (base === undefined) return undefined;

	const parts = base
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	const seen = new Set(parts);
	const push = (value: string) => {
		if (seen.has(value)) return;
		seen.add(value);
		parts.push(value);
	};
	// A full `expand.<key>` selector already includes any narrower
	// `expand.<key>.<field>` selection — drop the redundant narrow ones.
	const fullKeys = new Set<string>();
	for (const selector of info.fieldSelectors) {
		const seg = selector.split(".");
		if (seg.length === 2) fullKeys.add(seg[1]);
	}
	for (const selector of info.fieldSelectors) {
		const seg = selector.split(".");
		if (seg.length > 2 && fullKeys.has(seg[1])) continue;
		if (seg.length >= 2) push(seg[1]);
		push(selector);
	}
	return parts.join(",");
}