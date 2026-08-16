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

/** One `field op value` clause. */
type FilterClause<T> = `${FieldKey<T>} ${FilterOp} ${string}`;

/**
 * Type-checked filter expression (PocketBase syntax).
 *
 * ```ts
 * getList(1, 20, { filter: "title ~ 'x' && published = true" })
 * getList(1, 20, { filter: "(title = 'a' || title = 'b')" })
 * ```
 *
 * The first clause's field name + operator are validated; the rest of the
 * expression (values, `&&`/`||`, parens, `!`) is free-form.
 */
export type FilterString<T> =
	| FilterClause<T>
	| `${FilterClause<T>}${string}`;

/** A single `[+|-]field` sort token. */
type SortField<T> = `${"" | "-" | "+"}${FieldKey<T>}`;

/**
 * Type-checked sort string: `field`, `-field` (desc), `+field`, or
 * comma-separated combinations (e.g. `"-created,title"`).
 */
export type SortString<T> = SortField<T> | `${SortField<T>},${string}`;

/**
 * Type-checked expand string: comma-separated relation field names
 * (e.g. `"author"` or `"author,category"`). Non-relation fields are
 * warned about at runtime when a schema is available.
 */
export type ExpandString<T> = FieldKey<T> | `${FieldKey<T>},${string}`;

/**
 * Query options for list/read operations, typed against a record shape `T`.
 *
 * `filter`, `sort`, `expand` and `fields` are recognized; any other key is
 * passed through as a raw query parameter (PocketBase-compatible).
 */
export interface ListOptions<T = ApiRecord> {
	/**
	 * PocketBase filter expression. Field names + operators are type-checked
	 * when `T` is a concrete shape.
	 */
	filter?: FilterString<T>;
	/**
	 * Sort field(s): `field`, `-field` (descending), comma-separated.
	 */
	sort?: SortString<T>;
	/**
	 * Comma-separated relation field names to expand.
	 */
	expand?: ExpandString<T>;
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
export interface ReadOptions<T = ApiRecord> {
	/** Comma-separated relation field names to expand. */
	expand?: ExpandString<T>;
	/** Explicit field projection (overrides {@link CollectionService.select}). */
	fields?: string;
}

