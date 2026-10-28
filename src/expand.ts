// ── Expand normalisation ────────────────────────────────
// PocketBase only expands *relations*: a dotted token like `author.user` walks
// into the related record. Callers often use a dotted token to mean "only these
// fields of the expanded record" (`owner.name,owner.email`), which PocketBase
// silently drops. Telling the two apart needs the collection graph, so this
// module takes a small context and stays free of any HTTP concerns.

import type { CollectionSchema, SchemaField } from "./schema";
import type { NormalizedExpand } from "./projection";

/**
 * Resolves a collection schema by name or id. Supplied by
 * {@link LazypockClient} so a service can follow relation fields into their
 * target collection — needed to tell a nested relation (`owner.manager`)
 * apart from a field selection (`owner.name`).
 */
export type SchemaResolver = (
	nameOrId: string,
) => CollectionSchema | undefined;

/** What the expand logic needs to know about the collection it runs for. */
export interface ExpandContext {
	/** Collection name, used for warning messages. */
	collectionName: string;
	/** This collection's schema, when known. */
	schema?: CollectionSchema;
	/** Follows a relation field to its target collection's schema. */
	resolveCollection: SchemaResolver;
}

/** A plain JSON object (an expanded record). */
export type ExpandRecord = Record<string, unknown>;

/** Keep only the given keys of a plain object (used for expand narrowing). */
export function pickFields(value: unknown, fields: string[]): ExpandRecord {
	if (!value || typeof value !== "object") return {};
	const src = value as ExpandRecord;
	const out: ExpandRecord = {};
	for (const f of fields) {
		if (f in src) out[f] = src[f];
	}
	return out;
}

/** Follow a relation field to its target collection, if resolvable. */
function resolveTargetCollection(
	field: SchemaField,
	ctx: ExpandContext,
): CollectionSchema | undefined {
	const key =
		field.options?.collection ??
		field.options?.collectionId ??
		field.collectionId ??
		undefined;
	if (!key) return undefined;
	return ctx.resolveCollection(String(key));
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
	segments: string[],
	ctx: ExpandContext,
): { depth: number; canInspect: boolean } {
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
		const target = resolveTargetCollection(field, ctx);
		if (!target?.fields) {
			return { depth: i + 1, canInspect: false };
		}
		currentFields = target.fields;
	}
	return { depth: segments.length, canInspect: true };
}

/** Warn once when an expand field is not a relation (schema known). */
function warnNonRelation(name: string, ctx: ExpandContext): void {
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
	expand: string | undefined,
	ctx: ExpandContext,
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
				warnNonRelation(base, ctx);
			}
			parsed.push({ token, base, segments, kind: "plain", depth: 0 });
			continue;
		}
		if (!relations) {
			// No schema at all — deferred to the grouping pass below.
			parsed.push({ token, base, segments, kind: "unknown", depth: 1 });
			continue;
		}
		const { depth, canInspect } = resolveRelationChain(segments, ctx);
		if (depth === 0) {
			warnNonRelation(base, ctx);
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