// ── Read-query normalisation ───────────────────────────
// The translation layer between what a caller writes and what the server
// understands for read requests: `select()` projections, the schema-driven
// default projection, and `expand` tokens (plain relation, nested relation,
// or "only these fields of the expanded record").
//
// Why this lives in its own module: it is pure — no HTTP, no client state —
// but it encodes the *differences* between PocketBase and the LazyPock server
// (strict projection, expand-after-projection, client-side narrowing). Every
// expand/fields defect so far has been one of those differences discovered
// here, so this is the part that changes most often. Keeping it out of
// CollectionService means it can be tested directly instead of through a
// mocked fetch, and the reasoning stays attached to the code that needs it.
//
// See docs/queries.md ("Expanding relations", "Projecting fields").

import type { CollectionSchema, SchemaField } from "./schema";

/** Everything these helpers need to know about the collection in play. */
export interface QueryContext {
	/** Collection name, used only for warning messages. */
	collectionName: string;
	/** Optional schema for this collection (from client `types.schemas`). */
	schema?: CollectionSchema;
	/** Resolves relation targets across collections (client-level schemas). */
	resolveCollection?: SchemaResolver;
}

/**
 * Resolves a collection schema by name or id. Supplied by
 * {@link LazypockClient} so a service can follow relation fields into their
 * target collection — needed to tell a nested relation (`owner.manager`)
 * apart from a field selection (`owner.name`).
 */
export type SchemaResolver = (
	nameOrId: string,
) => CollectionSchema | undefined;

/** Normalised form of a caller's `expand` string. */
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

/** A plain JSON object (an expanded record). */
type ExpandRecord = Record<string, unknown>;

/** Keep only the given keys of a plain object (used for expand narrowing). */
function pickFields(value: unknown, fields: string[]): ExpandRecord {
	if (!value || typeof value !== "object") return {};
	const src = value as ExpandRecord;
	const out: ExpandRecord = {};
	for (const f of fields) {
		if (f in src) out[f] = src[f];
	}
	return out;
}

/**
 * Fields to send with reads:
 * 1. explicit `options.fields` (caller wins)
 * 2. `select()` preset
 * 3. schema default — all visible (non-hidden) fields plus the implicit
 *    system keys (`id`, `created`, `updated`, `collectionId`, `collectionName`)
 */
export function effectiveFields(
	ctx: QueryContext,
	fieldsPreset: string | undefined,
	optionsFields?: string,
): string | undefined {
	if (optionsFields !== undefined) return optionsFields;
	if (fieldsPreset !== undefined) {
		if (fieldsPreset === "*") {
			return visibleFields(ctx.schema);
		}
		return fieldsPreset;
	}
	return visibleFields(ctx.schema);
}

/**
 * All non-hidden, non-password, non-autodate field names from the schema,
 * prefixed with the implicit system keys that are part of every record
 * (`id`, `created`, `updated`, `collectionId`, `collectionName`).
 *
 * The system keys never appear in the schema (they are implied for every
 * collection) but MUST be listed explicitly when projecting — the server
 * applies strict projection, so unrequested fields are dropped. Without
 * them, `getList`/`getOne` responses lose `id` (and `created`/`updated`),
 * breaking selection, edits, and relation references.
 *
 * `undefined` when no schema fields are available (server decides — its
 * default returns every non-password field, including the system keys).
 */
export function visibleFields(
	schema: CollectionSchema | undefined,
): string | undefined {
	if (!schema?.fields) return undefined;
	const visible = schema.fields
		.filter(
			(f) =>
				!f.hidden &&
				f.type !== "password" &&
				f.type !== "autodate",
		)
		.map((f) => f.name);
	if (visible.length === 0) return undefined;
	// Dedupe in case a schema ever names a field after a system key.
	return [
		...new Set([
			"id",
			"created",
			"updated",
			"collectionId",
			"collectionName",
			...visible,
		]),
	].join(",");
}

/**
 * Resolve the leading relation chain of an expand token against the
 * (optionally schema-aware) collection graph.
 *
 * Walks `segments` from this collection: each segment that is a relation
 * advances to its target collection. Stops at the first non-relation
 * segment or when the target schema is unknown.
 *
 * @returns `depth` — how many leading segments are relations; and
 * `canInspect` — whether the schema at `depth` is known (so the next
 * segment can be classified as a field selection vs a nested relation).
 */
function resolveRelationChain(
	ctx: QueryContext,
	segments: string[],
): {
	depth: number;
	canInspect: boolean;
} {
	let currentFields = ctx.schema?.fields;
	if (!currentFields) return { depth: 0, canInspect: false };
	for (let i = 0; i < segments.length; i++) {
		const field = currentFields.find((f) => f.name === segments[i]);
		if (!field || field.type !== "relation") {
			return { depth: i, canInspect: true };
		}
		if (i === segments.length - 1) {
			return { depth: segments.length, canInspect: true };
		}
		const target = resolveTargetCollection(ctx, field);
		if (!target?.fields) {
			return { depth: i + 1, canInspect: false };
		}
		currentFields = target.fields;
	}
	return { depth: segments.length, canInspect: true };
}

/** Follow a relation field to its target collection, if resolvable. */
function resolveTargetCollection(
	ctx: QueryContext,
	field: SchemaField,
): CollectionSchema | undefined {
	const key =
		field.options?.collection ??
		field.options?.collectionId ??
		field.collectionId ??
		undefined;
	if (!key || !ctx.resolveCollection) return undefined;
	return ctx.resolveCollection(String(key));
}

/** Warn once when an expand field is not a relation (schema known). */
function warnNonRelation(ctx: QueryContext, name: string): void {
	console.warn(
		`[lazypock] expand("${name}"): field is not a relation on collection "${ctx.collectionName}"`,
	);
}

/**
 * Validate and normalise a caller's `expand` string.
 *
 * PocketBase only expands *relations*: a dotted token like `author.user`
 * walks into the related record. Callers often use a dotted token to mean
 * "only these fields of the expanded record" (`owner.name,owner.email`),
 * which PocketBase silently drops. When the trailing segment is not a
 * relation — resolved from the schema graph — the token is rewritten as a
 * field selection:
 *
 * ```
 * expand: 'owner.name,owner.email'
 * → expand=owner&fields=<base>,expand.owner.name,expand.owner.email
 * ```
 *
 * Tokens whose whole path is relations keep their existing nested-expand
 * behaviour. Without a schema the two are indistinguishable, so a lone
 * dotted token stays a nested expand (with a warning) while two or more
 * dotted tokens sharing the same relation are treated as field selection.
 */
export function normalizeExpand(
	ctx: QueryContext,
	expand: string | undefined,
): NormalizedExpand {
	const narrow = new Map<string, string[]>();
	if (!expand) return { fieldSelectors: [], narrow };
	const tokens = expand
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	if (tokens.length === 0) return { fieldSelectors: [], narrow };

	const relations = ctx.schema?.fields
		? new Set(
				ctx.schema.fields
					.filter((f) => f.type === "relation")
					.map((f) => f.name),
			)
		: undefined;

	interface ParsedToken {
		token: string;
		base: string;
		segments: string[];
		kind: "plain" | "nested" | "narrow" | "unknown";
		/** For `narrow`: number of leading relation segments. */
		depth: number;
	}

	const parsed: ParsedToken[] = [];
	for (const token of tokens) {
		const segments = token.split(".").filter(Boolean);
		const base = segments[0] ?? token;
		if (segments.length <= 1) {
			if (relations && !relations.has(base)) {
				warnNonRelation(ctx, base);
			}
			parsed.push({ token, base, segments, kind: "plain", depth: 0 });
			continue;
		}
		if (!relations) {
			// No schema at all — deferred to the grouping pass below.
			parsed.push({ token, base, segments, kind: "unknown", depth: 1 });
			continue;
		}
		const { depth, canInspect } = resolveRelationChain(ctx, segments);
		if (depth === 0) {
			warnNonRelation(ctx, base);
			parsed.push({ token, base, segments, kind: "plain", depth: 0 });
		} else if (depth === segments.length) {
			parsed.push({ token, base, segments, kind: "nested", depth });
		} else if (canInspect) {
			parsed.push({ token, base, segments, kind: "narrow", depth });
		} else {
			parsed.push({ token, base, segments, kind: "unknown", depth });
		}
	}

	// Disambiguate unknown tokens per relation: two+ distinct sub-paths is
	// clearly a field selection; a lone dotted token keeps nested-expand.
	const byBase = new Map<string, ParsedToken[]>();
	for (const t of parsed) {
		const arr = byBase.get(t.base);
		if (arr) arr.push(t);
		else byBase.set(t.base, [t]);
	}
	for (const [base, group] of byBase) {
		const unknowns = group.filter((t) => t.kind === "unknown");
		if (unknowns.length === 0) continue;
		const distinct = new Set(unknowns.map((t) => t.token));
		const hasNarrow = group.some((t) => t.kind === "narrow");
		if (!hasNarrow && distinct.size < 2) {
			for (const t of unknowns) {
				t.kind = "nested";
				console.warn(
					`[lazypock] expand("${t.token}"): treated as a nested relation. ` +
						`Pass types.schemas (or use fields=) to select fields of "${base}".`,
				);
			}
		} else {
			for (const t of unknowns) t.kind = "narrow";
		}
	}

	const expandParams: string[] = [];
	const expandSeen = new Set<string>();
	const fieldSelectors: string[] = [];
	const selectorSeen = new Set<string>();
	const pushParam = (p: string) => {
		if (!expandSeen.has(p)) {
			expandSeen.add(p);
			expandParams.push(p);
		}
	};
	const pushSelector = (s: string) => {
		if (!selectorSeen.has(s)) {
			selectorSeen.add(s);
			fieldSelectors.push(s);
		}
	};

	for (const t of parsed) {
		if (t.kind === "plain") {
			pushParam(t.token);
			pushSelector(`expand.${t.token}`);
		} else if (t.kind === "nested") {
			// Send every relation prefix (`a`, `a.b`, `a.b.c`). PocketBase
			// resolves the full chain; servers that only expand one level
			// (LazyPock) still resolve the leading relation instead of
			// silently expanding nothing.
			for (let i = 1; i <= t.segments.length; i++) {
				pushParam(t.segments.slice(0, i).join("."));
			}
			pushSelector(`expand.${t.segments[0]}`);
		} else {
			const depth = Math.max(1, t.depth);
			const relationPath = t.segments.slice(0, depth).join(".");
			pushParam(relationPath);
			pushSelector(`expand.${t.segments.slice(0, depth + 1).join(".")}`);
			// Single-level field selection (`author.name`) is also applied
			// client-side (see `applyExpandNarrowing`) so it works on servers
			// that always return the full expanded record.
			if (t.segments.length === depth + 1) {
				const base = t.segments[0];
				const leaf = t.segments[depth];
				const leaves = narrow.get(base) ?? [];
				if (!leaves.includes(leaf)) leaves.push(leaf);
				narrow.set(base, leaves);
			}
		}
	}

	return {
		expand: expandParams.length > 0 ? expandParams.join(",") : undefined,
		fieldSelectors,
		narrow,
	};
}

/**
 * Keep only the requested leaf fields on `record.expand.<relation>`.
 *
 * Mirrors PocketBase's server-side `fields=expand.<rel>.<field>` projection
 * for servers that don't support it (the LazyPock server), so field
 * selection behaves the same against both. A no-op when the server already
 * narrowed the record. Multi-relations are narrowed element-wise.
 */
export function applyExpandNarrowing<T>(
	record: T,
	narrow: Map<string, string[]>,
): T {
	if (narrow.size === 0) return record;
	const rec = record as Record<string, unknown>;
	const expand = rec.expand as Record<string, unknown> | undefined;
	if (!expand || typeof expand !== "object") return record;

	const next: Record<string, unknown> = { ...expand };
	for (const [relation, leaves] of narrow) {
		const value = next[relation];
		if (value === undefined || value === null) continue;
		next[relation] = Array.isArray(value)
			? value.map((el) => pickFields(el, leaves))
			: pickFields(value, leaves);
	}
	return { ...rec, expand: next } as T;
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

/**
 * Everything a read request needs derived from the caller's query options,
 * computed once so `getList`/`getOne` cannot drift apart.
 */
export interface PreparedReadQuery {
	/** Rewritten `expand` param, or `undefined` when the caller sent none. */
	expand?: string;
	/** Effective `fields` projection (expand-preserving), or `undefined` to send none. */
	fields?: string;
	/** Relation → leaf fields to keep on the expanded record (client-side). */
	narrow: Map<string, string[]>;
}

/** Coerce an `expand` option (string, array shorthand, or nothing) to a string. */
export function expandParam(value: unknown): string | undefined {
	if (Array.isArray(value)) return value.join(",");
	return typeof value === "string" ? value : undefined;
}

/**
 * Resolve the `expand`/`fields` half of a read query.
 *
 * @param raw the caller's `expand` (string or array) and `fields`
 * @param fieldsPreset the service's `select()` preset, if any
 */
export function prepareReadQuery(
	ctx: QueryContext,
	raw: { expand?: unknown; fields?: unknown },
	fieldsPreset: string | undefined,
): PreparedReadQuery {
	const expandInfo = normalizeExpand(ctx, expandParam(raw.expand));
	const fields = mergeExpandFields(
		effectiveFields(ctx, fieldsPreset, raw.fields as string | undefined),
		expandInfo,
	);
	return { expand: expandInfo.expand, fields, narrow: expandInfo.narrow };
}
