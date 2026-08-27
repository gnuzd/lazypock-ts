// ── Record & Collection types ───────────────────────────

/**
 * Base shape every record returned from any collection satisfies.
 * Generated record interfaces extend this.
 */
export interface BaseRecordFields {
	id: string;
	collectionId: string;
	collectionName: string;
	created: string;
	updated: string;
}

/** Shape of a record returned from any collection. */
export interface ApiRecord extends BaseRecordFields {
	[key: string]: unknown;
}

/**
 * Structural marker for concrete record shapes (generated or hand-written).
 * Used to differentiate a typed collection service from the untyped default.
 */
export type RecordShape = Record<string, unknown>;

/** System fields every record carries — not user-provided on create. */
export type SystemFields =
	| "id"
	| "collectionId"
	| "collectionName"
	| "created"
	| "updated";

/**
 * Data accepted by `create()`: any subset of `T`'s fields, but
 * never the system fields. Unknown/extra keys are rejected at compile
 * time via excess-property checking (object literals).
 */
export type CreateData<T> = Partial<Omit<T, SystemFields>>;

/**
 * Data accepted by `update()`: any subset of `T`'s fields.
 * Unknown/extra keys are rejected at compile time.
 */
export type UpdateData<T> = Partial<Omit<T, SystemFields>>;

/** Paginated list response matching PocketBase format. */
export interface ListResult<T = ApiRecord> {
	items: T[];
	page: number;
	perPage: number;
	totalItems: number;
	totalPages: number;
}

/** HTTP method supported by the client. */
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RequestOptions {
	/** Search/filter params */
	params?: Record<string, string>;
	/** Raw request headers to merge */
	headers?: Record<string, string>;
	/** Abort signal */
	signal?: AbortSignal;
	/** Custom fetch implementation (for RN or test mocking) */
	fetch?: typeof globalThis.fetch;
	/**
	 * Request identifier used by the auto-cancellation mechanism.
	 *
	 * Pending requests sharing the same key cancel each other — only the
	 * last one is executed (PocketBase `requestKey` semantics).
	 *
	 * - `string` — use this exact key instead of the default `METHOD + path`.
	 * - `null` — disable auto-cancellation for this request (never auto-cancelled).
	 *
	 * @default `${method} ${path}`
	 */
	requestKey?: string | null;
	/**
	 * Disable auto-cancellation for this request.
	 * Alias of `requestKey: null` (PocketBase `$autoCancel: false` compat).
	 */
	autoCancel?: boolean;
	/**
	 * Custom request key used for auto-cancellation.
	 * Alias of `requestKey` (PocketBase `$cancelKey` compat).
	 */
	cancelKey?: string;
	/**
	 * Coalesce concurrent identical requests (same `requestKey`) onto a single
	 * in-flight promise instead of aborting the earlier one.
	 *
	 * When enabled, a request arriving while another with the same key is still
	 * pending awaits the same result — no duplicate network request, and the
	 * caller of the first request never sees an abort rejection.
	 *
	 * @default false (auto-cancellation aborts the earlier duplicate)
	 */
	singleFlight?: boolean;
}

export class ApiError extends Error {
	readonly data: unknown;
	readonly status: number;
	/**
	 * `true` when this error was caused by an aborted/cancelled request
	 * (auto-cancelled duplicate, or manually via `cancelRequest()` /
	 * `cancelAllRequests()` / an external AbortSignal).
	 */
	readonly isAbort: boolean;

	constructor(message: string, data: unknown, status: number, isAbort = false) {
		super(message);
		this.name = "ApiError";
		this.data = data;
		this.status = status;
		this.isAbort = isAbort;
	}
}

// ── Schema-driven query typing ─────────────────────────
// Template-literal helpers that turn a concrete record shape `T` (e.g. a
// codegen-generated interface) into validated/suggestable query strings:
//   - select("title", "published")          → field names checked
//   - getList(1, 20, { sort: "-created" })   → "created" suggested
//   - getList(1, 20, { filter: "title ~ 'x'" }) → field + operator suggested
//   - getList(1, 20, { expand: "author" })   → field suggested (schema-checked at runtime)
// When `T` is the untyped {@link ApiRecord}, every helper degrades to `string`.
//
// Validation strategy: TypeScript rejects *recursive template-literal types*
// (TS2456), so an arbitrary-length comma-separated list can't be expressed
// as a recursive pattern like `Field | \`${Field},${Field},...\``. Instead
// each option carries a generic `E`/`S`/`F` inferred from the caller's
// literal, and a *guard* `X & (X extends ValidX<T, X> ? X : never)` validates
// every token by splitting the literal on commas / clauses with a
// shrinking-string recursion (the same shape that makes `StringToUnion`
// legal). The guard is an intersection with the naked `X` so inference still
// sees the literal; parse failures yield `never`, which is rejected by the
// literal-vs-never checks below (`never` satisfies `extends ""`, so the
// checks compare the *literal* against the parse result instead).

/**
 * String keys of a record shape (excludes methods/symbols).
 * Falls back to `string` when `T` has no known keys (e.g. `unknown`), so
 * untyped services accept any field name.
 */
export type FieldKey<T> = Extract<keyof T, string> extends never
	? string
	: Extract<keyof T, string>;

/** Valid filter operators, matching the backend FilterCompiler. */
export type FilterOp =
	| "="
	| "!="
	| "~"
	| "!~"
	| ">"
	| ">="
	| "<"
	| "<=";

/** Optional whitespace around a filter operator (`project=x` and `project = x` both compile). */
type FilterWs = "" | " ";

/** Trim one-or-more leading/trailing spaces off a string literal. */
type Trim<S extends string> = S extends ` ${infer R}`
	? Trim<R>
	: S extends `${infer L} `
		? Trim<L>
		: S;

/** `never` when the string contains a single-quote. */
type NoQuote<S extends string> = S extends `${string}'${string}` ? never : S;

/** `never` when the string contains a double-quote. */
type NoDQuote<S extends string> = S extends `${string}"${string}` ? never : S;

/** Single decimal digits — used to consume numeric values char-by-char. */
type Digits = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/**
 * Consume a leading number (digits plus an optional decimal part) and
 * return the remainder. `\`${number}\`` is NOT used in template positions:
 * it matches a single digit, leaving `"0"` behind for `"10"`.
 */
type ConsumeNum<S extends string> = S extends `${infer C}${infer R}`
	? C extends Digits
		? ConsumeNum<R>
		: C extends "."
			? R extends `${Digits}${string}`
				? ConsumeNum<R>
				: S
			: S
	: S;

/**
 * Consume chars up to (not including) the first banned char and return the
 * remainder. Bounds dot-paths so a path can't swallow a following clause.
 */
type ConsumeUntil<S extends string, Ban extends string> = S extends `${infer C}${infer R}`
	? C extends Ban
		? S
		: ConsumeUntil<R, Ban>
	: S;

/** Chars that terminate a relation dot-path. */
type PathBan = " " | "&" | "|" | "(" | ")" | "'" | "\"";

// ── expand ─────────────────────────────────────────────

/**
 * A single expandable token: a top-level key, or a dot-path into a relation
 * (`author.user.profile`). Only the first segment is validated — nested
 * segments reference fields of the *target* collection, which `T` doesn't
 * describe.
 */
type ExpandField<T> = `${FieldKey<T>}${"" | `.${string}`}`;

/**
 * Validate every comma-separated expand token; returns the original literal
 * `O` when all tokens are valid, `never` otherwise. Spaces around commas are
 * tolerated (the runtime trims tokens too).
 */
type ValidExpand<T, E extends string, O extends string = E> =
	string extends FieldKey<T>
		? O
		: E extends `${infer Head},${infer Tail}`
			? Trim<Head> extends ExpandField<T>
				? ValidExpand<T, Trim<Tail>, O>
				: never
			: Trim<E> extends ExpandField<T>
				? O
				: never;

/**
 * Type-checked expand string: comma-separated relation field names,
 * including nested dot-paths (e.g. `"author"`, `"author,category"`,
 * `"author.user.profile"`). **Every** comma-separated token is validated —
 * `expand: "author, nope"` is a compile error, not just the first token.
 * Non-relation fields are warned about at runtime when a schema is
 * available.
 */
export type ExpandString<T, E extends string = never> = E & (E extends ValidExpand<T, E, E> ? E : never);

// ── sort ───────────────────────────────────────────────

/** A single `[+|-]field` sort token. */
type SortField<T> = `${"" | "-" | "+"}${FieldKey<T>}`;

/**
 * Validate every comma-separated sort token; returns the original literal
 * `O` when all tokens are valid, `never` otherwise.
 */
type ValidSort<T, E extends string, O extends string = E> =
	string extends FieldKey<T>
		? O
		: E extends `${infer Head},${infer Tail}`
			? Trim<Head> extends SortField<T>
				? ValidSort<T, Trim<Tail>, O>
				: never
			: Trim<E> extends SortField<T>
				? O
				: never;

/**
 * Type-checked sort string: `field`, `-field` (desc), `+field`, or
 * comma-separated combinations (e.g. `"-created,title"`). **Every** token is
 * validated — `sort: "title, nope"` is a compile error.
 */
export type SortString<T, E extends string = never> = E & (E extends ValidSort<T, E, E> ? E : never);

// ── filter ─────────────────────────────────────────────

/**
 * A string value with no quotes, `&&`/`||`, or parens — the "bare" fallback
 * for filter values (numbers, `true`/`false`/`null`, unquoted text).
 * Applied against the *same* literal (`S extends SimpleVal<S>`) so the
 * banned-char checks run on the concrete substring, not on the abstract
 * `string` type.
 */
type SimpleVal<S extends string> =
	& (S extends `${string}'${string}` ? never : S)
	& (S extends `${string}"${string}` ? never : S)
	& (S extends `${string}&&${string}` ? never : S)
	& (S extends `${string}||${string}` ? never : S)
	& (S extends `${string}(${string}` ? never : S)
	& (S extends `${string})${string}` ? never : S);

/**
 * Field-reference value (`title = author` / `title = author.email`): a
 * top-level key, optionally followed by a bounded dot-path. Returns the
 * remainder after the value.
 */
type FFieldRef<T, S extends string> = S extends `${FieldKey<T>}${infer R}`
	? R extends `.${infer Rest}`
		? ConsumeUntil<Rest, PathBan>
		: R
	: never;

/**
 * Consume one filter value (quoted string, number, boolean/null, field
 * reference, or bare text) and return the remainder — the input left for the
 * `&&`/`||`/`)`/end checks upstream.
 */
type FValue<T, S extends string> =
	// single-quoted string ('...' — no unescaped single-quotes allowed)
	| (S extends `'${infer V}'${infer R}` ? (V extends NoQuote<V> ? R : never) : never)
	// double-quoted string
	| (S extends `"${infer V}"${infer R}` ? (V extends NoDQuote<V> ? R : never) : never)
	// true / false / null
	| (S extends `${"true" | "false" | "null"}${infer R}` ? R : never)
	// number (digits + optional decimal part, optional minus)
	| (S extends `-${infer Rest}`
		? Rest extends `${Digits}${string}` ? ConsumeNum<Rest> : never
		: S extends `${Digits}${string}` ? ConsumeNum<S> : never)
	// field reference (`title = author` / `title = author.email`)
	| FFieldRef<T, S>
	// bare text — only when it consumes the entire remainder (values that
	// contain `&&`/`||`/parens belong to the quoted forms above)
	| (S extends SimpleVal<S> ? "" : never);

/**
 * Parse one `field op value` clause — either a plain top-level field or a
 * bounded relation dot-path — and return the remainder. Spaces around the
 * operator are optional (`project=x` / `project = x`).
 */
type FClause<T, S extends string> = S extends `${FieldKey<T>}${infer R}`
	? R extends `${FilterWs}${FilterOp}${FilterWs}${infer R2}`
		? FValue<T, Trim<R2>>
		: R extends `.${infer Rest}`
			? ConsumeUntil<Rest, PathBan> extends infer R2
				? R2 extends `${FilterWs}${FilterOp}${FilterWs}${infer R3}`
					? FValue<T, Trim<R3>>
					: never
				: never
			: never
	: never;

/** A clause or a parenthesised group; parens must balance and close. */
type FAtom<T, S extends string> =
	| FClause<T, S>
	| (S extends `(${infer Inner}`
		? FOr<T, Inner> extends infer R
			? R extends `)${infer Tail}` ? Tail : never
			: never
		: never);

/** Optional `!` negation in front of an atom. */
type FNot<T, S extends string> = S extends `!${infer Tail}` ? FAtom<T, Tail> : FAtom<T, S>;

/**
 * One or more atoms joined by `&&`. Returns `never` on parse failure (a
 * failed atom must not masquerade as an empty remainder — `never extends ""`
 * is true), the empty string on success, or the unconsumed remainder.
 */
type FAnd<T, S extends string> = FNot<T, S> extends infer R
	? [R] extends [never] ? never
	: R extends "" ? ""
	: R extends `${FilterWs}&&${FilterWs}${infer Tail}` ? FAnd<T, Tail>
	: R
	: never;

/** One or more `&&`-chains joined by `||` — the top-level expression. */
type FOr<T, S extends string> = FAnd<T, S> extends infer R
	? [R] extends [never] ? never
	: R extends "" ? ""
	: R extends `${FilterWs}||${FilterWs}${infer Tail}` ? FOr<T, Tail>
	: R
	: never;

/**
 * Validate a full filter expression: the parser must consume the entire
 * (trimmed) string. Compares the *literal* against the parse result rather
 * than `extends ""` so a `never` parse failure can't satisfy the check.
 */
type ValidFilter<T, F extends string, O extends string = F> =
	string extends FieldKey<T>
		? O
		: "" extends FOr<T, Trim<F>> ? O : never;

/**
 * Type-checked filter expression (PocketBase syntax).
 *
 * ```ts
 * getList(1, 20, { filter: "title ~ 'x' && published = true" })
 * getList(1, 20, { filter: `title=${search}` })      // spaces around the operator optional
 * getList(1, 20, { filter: "(title = 'a' || title = 'b')" })
 * getList(1, 20, { filter: "author.email = 'x'" })    // relation dot-path
 * ```
 *
 * **Every** `field op value` clause is validated — the field name, the
 * operator, and the clause structure (`&&`, `||`, `!`, parens, and nested
 * groups all typecheck). Quoted values may contain `&&`/`||` (e.g.
 * `title ~ 'a && b'`); bare unquoted values are bounded so they can't hide a
 * following clause. When the expression is a plain dynamic `string` (e.g.
 * `filter: \`title=${search}\``), the guard falls back to accepting it
 * verbatim — the server decides at runtime.
 */
export type FilterString<T, F extends string = never> =
	F & (F extends ValidFilter<T, F, F> ? F : string extends F ? F : never);

// ── expanded records ───────────────────────────────────

/**
 * First segment of a single expand token (`"author.user"` → `"author"`) —
 * the key PocketBase uses on the expanded record.
 */
type TopExpandKey<S extends string> = S extends `${infer A}.${string}` ? A : S;

/** Top-level keys of a comma-separated expand literal (`"a,b"` → `"a" | "b"`). */
type ExpandKeys<S extends string> = S extends "" ? never :
	S extends `${infer H},${infer T}` ? TopExpandKey<H> | ExpandKeys<T> : TopExpandKey<S>;

/**
 * The `expand` property attached to records when `expand` is used. Keys are
 * parsed from the caller's expand literal (dot-paths collapse to their first
 * segment), so `record.expand.user` typechecks and the nested record is
 * `unknown` (its shape belongs to the target collection). Falls back to
 * `Record<string, unknown>` when the expand value is dynamic or absent.
 */
export type ExpandObj<E extends string> =
	[E] extends [never] ? Record<string, unknown> :
	[string] extends [E] ? Record<string, unknown> :
	Partial<Record<ExpandKeys<E>, unknown>>;

/**
 * Query options for list/read operations, typed against a record shape `T`.
 *
 * `filter`, `sort`, `expand` and `fields` are recognized; any other key is
 * passed through as a raw query parameter (PocketBase-compatible).
 *
 * The `E`/`S`/`F` generics are inferred from the caller's literals; the
 * {@link CollectionService} methods constrain them with the validated
 * {@link ExpandString} / {@link SortString} / {@link FilterString} guards.
 */
/**
 * `_T` is kept for backward compatibility (`ListOptions<Post>`) but the
 * per-field validation now runs through the `E`/`S`/`F` generics.
 */
export interface ListOptions<_T = ApiRecord, E extends string = never, S extends string = never, F extends string = never> {
	/**
	 * PocketBase filter expression. Field names + operators are type-checked
	 * when `T` is a concrete shape.
	 */
	filter?: FilterString<_T, F>;
	/**
	 * Sort field(s): `field`, `-field` (descending), comma-separated.
	 */
	sort?: SortString<_T, S>;
	/**
	 * Comma-separated relation field names to expand.
	 */
	expand?: ExpandString<_T, E>;
	/**
	 * Explicit field projection (overrides {@link CollectionService.select}).
	 */
	fields?: string;
	/**
	 * Raw query parameters — any other key is passed through verbatim.
	 */
	[key: string]: unknown;
}

/**
 * Options for single-record reads (`getOne`): expand + explicit fields.
 */
export interface ReadOptions<_T = ApiRecord, E extends string = never> {
	/** Comma-separated relation field names to expand. */
	expand?: ExpandString<_T, E>;
	/** Explicit field projection (overrides {@link CollectionService.select}). */
	fields?: string;
}

