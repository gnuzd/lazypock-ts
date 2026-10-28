// ── Collection Service ──────────────────────────────────
// Typed CRUD for a single collection (like PocketBase's pb.collection(name))

import type { HttpClient } from "./http";
import { rememberAuthResponse, type AuthStore, type AuthModel } from "./auth";
import {
	ApiError,
	type ApiRecord,
	type ListResult,
	type RequestOptions,
	type CreateData,
	type UpdateData,
	type ListOptions,
	type ReadOptions,
	type FilterInput,
	type FieldKey,
	type FilterableKey,
	type ExpandObj,
} from "./types";
import type { RealtimeService } from "./realtime";
import { FilterBuilder, type FilterExpr } from "./filter";
import {
	applyExpandNarrowing,
	expandParam,
	prepareReadQuery,
	visibleFields as schemaVisibleFields,
	type QueryContext,
	type SchemaResolver,
} from "./query";
import type { CollectionSchema } from "./schema";
import {
	authorizeWithOAuth2Popup,
	oauth2RedirectOrigin,
	DEFAULT_OAUTH2_TIMEOUT_MS,
	type AuthMethodsList,
	type OAuth2Options,
	type OAuth2AuthCodeOptions,
	type RecordAuth,
} from "./oauth2";

// Re-exported so `CollectionService`'s constructor/schema plumbing keeps its
// original import path even though the query helpers now live in `./query`.
export type { SchemaResolver } from "./query";

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
 * Deterministic JSON stringify for building a stable cache/dedup key.
 * Strips request-transport keys (`requestKey`, `singleFlight`, `fetch`,
 * `signal`) so functionally-identical calls share one key.
 */
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

export function stableStringify(value: unknown): string {
	const seen = new Set<object>();
	const sort = (v: unknown): StableRequestValue => {
		if (Array.isArray(v)) return v.map(sort);
		if (v && typeof v === "object") {
			if (seen.has(v as object)) return "[Circular]";
			seen.add(v as object);
			const out: Record<string, StableRequestValue> = {};
			for (const k of Object.keys(v as object).sort()) {
				if (k === "requestKey" || k === "singleFlight" || k === "fetch" || k === "signal") {
					continue;
				}
				out[k] = sort((v as Record<string, unknown>)[k]);
			}
			return out;
		}
		// SAFETY: non-object values are JSON scalars (or undefined, which
		// JSON.stringify omits from objects) — all representable here.
		return v as StableRequestValue;
	};
	try {
		return JSON.stringify(sort(value));
	} catch {
		return String(value);
	}
}

/**
 * A realtime record-change event delivered to subscription callbacks.
 * Mirrors PocketBase's RealtimeService result shape (`action` + `record`).
 */
export interface RealtimeMessage {
	action: "create" | "update" | "delete";
	record: Record<string, unknown>;
	topic?: string;
}

/** Subscription callback for a collection's realtime events. */
export type RealtimeCallback = (e: RealtimeMessage) => void;

/**
 * Options for {@link CollectionService.subscribe} (PocketBase-compatible).
 *
 * `expand` and any extra keys are forwarded to the server channel join
 * payload (available to `onRealtimeSubscribeRequest` hooks). `headers` is
 * accepted for PocketBase signature compatibility but has no effect over
 * WebSocket — it is not forwarded.
 */
export interface RealtimeSubscribeOptions {
	/** Fields to expand on the subscribed records (server join payload). */
	expand?: string;
	/** Accepted for PocketBase parity; not sent over the WebSocket. */
	headers?: Record<string, string>;
	/** Any extra keys are forwarded verbatim to the server join payload. */
	[key: string]: unknown;
}

/** Raw event passed by the low-level realtime service. */
interface RealtimeEventLike {
	event: string;
	topic: string;
	payload?: Record<string, unknown>;
}

/** Map a raw event/action to a normalised create/update/delete action. */
function normalizeAction(
	event: string,
	rawAction?: unknown,
): RealtimeMessage["action"] {
	if (typeof rawAction === "string") {
		const a = rawAction.toLowerCase();
		if (a === "create" || a === "update" || a === "delete") {
			return a;
		}
	}
	if (event === "record_change") return "update";
	if (event === "create" || event === "record_create") return "create";
	if (event === "delete" || event === "record_delete") return "delete";
	return "update";
}


/**
 * Typed CRUD service for a single dynamic collection.
 * Get an instance via {@link LazypockClient.collection}.
 *
 * @typeParam T — The record shape for this collection. Defaults to {@link ApiRecord}.
 * @typeParam TData — Write-only create/update payload shape (defaults to `never`,
 * which falls back to `T`-derived create data).
 * @typeParam TFields — The key set accepted by `filter`/`sort`/`expand`/`select`.
 * Defaults to `T`. The codegen client binds a *QueryFields type that includes
 * hidden fields — excluded from the read model but still expandable/filterable
 * at runtime — so `expand: "hiddenRelation"` typechecks.
 * @typeParam TExpand — Map of relation field → target record type. Defaults to
 * `Record<string, unknown>`. The codegen client binds a per-collection
 * *ExpandMap, so `record.expand.user` is typed as the target `UsersRecord`
 * instead of `unknown`.
 */
export class CollectionService<
	T = ApiRecord,
	TData = never,
	TFields = T,
	TExpand = Record<string, unknown>,
> {
	private http: HttpClient;
	private collectionName: string;
	private authStore?: AuthStore;
	private realtime?: RealtimeService;
	/** Optional schema for this collection (from client `types.schemas`). */
	private schema?: CollectionSchema;
	/** Resolves relation targets across collections (client-level schemas). */
	private schemaResolver?: SchemaResolver;
	/**
	 * Active field projection from {@link select}. `"*"` (or unset) means
	 * "all visible (non-hidden) fields plus the implicit system keys" —
	 * resolved against the schema when one is available, otherwise left to
	 * the server.
	 */
	private fieldsPreset?: string;

	/** @internal */
	constructor(
		http: HttpClient,
		collectionName: string,
		authStore?: AuthStore,
		realtime?: RealtimeService,
		schema?: CollectionSchema,
		schemaResolver?: SchemaResolver,
	) {
		this.http = http;
		this.collectionName = collectionName;
		this.authStore = authStore;
		this.realtime = realtime;
		this.schema = schema;
		this.schemaResolver = schemaResolver;
	}

	private encodeId(id: string): string {
		return encodeURIComponent(id);
	}

	/**
	 * The records endpoint for this collection.
	 *
	 * Centralised because the server's shape is `/api/collections/<name>/records`,
	 * and a path repeated eighteen times is a path that drifts.
	 */
	private recordsPath(): string {
		return "/collections/" + this.encodeId(this.collectionName) + "/records";
	}

	/** The collection's own endpoint, which is where its auth routes live. */
	private collectionPath(): string {
		return "/collections/" + this.encodeId(this.collectionName);
	}

	/**
	 * What the query helpers in `./query` need to know about this collection.
	 * Built per call so a service's schema/preset assignment stays in one place.
	 */
	private queryContext(): QueryContext {
		return {
			collectionName: this.collectionName,
			schema: this.schema,
			resolveCollection: this.schemaResolver,
		};
	}

	// ── Field projection (`.select`) ──

	/**
	 * Project list/read responses to the given fields (PocketBase `fields`
	 * param). Field names are type-checked when this service is typed
	 * (codegen / `typed<T>()`).
	 *
	 * Returns a derived service — the original is untouched.
	 *
	 * @example
	 * ```ts
	 * const t = await client.collection("posts").select("id", "title").getList();
	 * // GET /api/posts?fields=id,title
	 *
	 * // All visible fields (implicit system keys id/created/updated/… are
	 * // kept; hidden fields are excluded via the projection)
	 * const all = await client.collection("posts").select("*").getList();
	 * // GET /api/posts?fields=id,created,updated,collectionId,collectionName,title,published,… (schema known)
	 * ```
	 *
	 * When no schema is known, the default (no `select()` call) sends no
	 * `fields` param — the server returns every non-password field.
	 * Pass `select("*")` to restore the default after a projection.
	 */
	select<K extends FieldKey<TFields> | "*">(
		...fields: K[]
	): CollectionService<T, TData, TFields, TExpand> {
		const preset = fields.length === 0 ? "*" : fields.join(",");
		const derived = new CollectionService<T, TData, TFields, TExpand>(
			this.http,
			this.collectionName,
			this.authStore,
			this.realtime,
			this.schema,
			this.schemaResolver,
		);
		derived.fieldsPreset = preset;
		if (this.schema && preset !== "*") {
			const known = new Set(this.schema.fields?.map((f) => f.name) ?? []);
			for (const f of fields) {
				if (!known.has(f)) {
					console.warn(
						`[lazypock] select("${f}"): unknown field on collection "${this.collectionName}"`,
					);
				}
			}
		}
		return derived;
	}

	/**
	 * All non-hidden, non-password, non-autodate field names from the schema,
	 * prefixed with the implicit system keys that are part of every record
	 * (`id`, `created`, `updated`, `collectionId`, `collectionName`).
	 *
	 * `undefined` when no schema fields are available (the server decides — its
	 * default returns every non-password field, including the system keys).
	 */
	visibleFields(): string | undefined {
		return schemaVisibleFields(this.schema);
	}

	// ── Typed filter builder ──

	/**
	 * Start a type-checked filter expression. The field name is suggested
	 * from the collection's key set and the value is checked against the
	 * field's type (when the service is typed). Values are escaped safely.
	 *
	 * ```ts
	 * const q = posts.where;
	 * await posts.getList(1, 20, {
	 *   filter: q("title").contains("x").and(q("published").eq(true)),
	 * });
	 * // → filter=(title ~ '%x%' && published = true)
	 *
	 * // PocketBase `?` array operators (multi-select / multi-relation):
	 * posts.getList(1, 20, { filter: q("tags").anyEq("news") });
	 * ```
	 *
	 * Chain `.and()` / `.or()` / `.not()` to compose. A `FilterExpr` can be
	 * passed anywhere a `filter` string is accepted. Relation dot-paths
	 * (`where("author.email")`) are supported by servers that compile
	 * relation dot-path filters, and `where("id").in(ids)` covers list
	 * membership without hand-written OR chains.
	 */
	where<F extends FilterableKey<TFields>>(field: F): FilterBuilder<F> {
		return new FilterBuilder<F>(field);
	}

	/**
	 * Resolve a `filter` callback into a concrete string / {@link FilterExpr}.
	 * The callback receives this collection's typed `where` helper, so
	 * `filter: (w) => w("title").contains("x")` type-checks field names inline.
	 */
	private resolveFilter(
		filter: FilterInput<TFields> | string | undefined,
	): FilterExpr | string | undefined {
		if (typeof filter !== "function") {
			return filter;
		}
		return filter((field) => this.where(field));
	}


	/**
	 * Fetch a paginated list of records (PocketBase `getList`).
	 *
	 * @param page Page number (default 1).
	 * @param perPage Records per page (default 30).
	 * @param options Query params (`filter`, `sort`, `expand`, `fields`) + request options.
	 */
	async getList<
		T2 = T,
		E extends string = never,
		S extends string = never,
		F extends string = never,
	>(
		page = 1,
		perPage = 30,
		options?: ListOptions<TFields, E, S, F> & RequestOptions,
	): Promise<ListResult<T2 & { expand?: ExpandObj<E, TExpand> }> | null> {
		const {
			requestKey,
			autoCancel,
			cancelKey,
			fetch,
			headers,
			signal,
			singleFlight,
			params,
			...queryParams
		} = options ?? {};
		// Array shorthands (`sort: ["-title"]`, `expand: ["author"]`) join to
		// the comma-separated form the server expects.
		if (Array.isArray(queryParams.sort)) {
			(queryParams as Record<string, unknown>).sort = queryParams.sort.join(",");
		}
		if (Array.isArray(queryParams.expand)) {
			(queryParams as Record<string, unknown>).expand =
				queryParams.expand.join(",");
		}
		// Resolve a `filter` callback (receives the typed `where` helper) into
		// a concrete string / FilterExpr before serialization.
		if (typeof queryParams.filter === "function") {
			(queryParams as Record<string, unknown>).filter = this.resolveFilter(
				queryParams.filter,
			);
		}
		// Normalise `expand` + resolve `fields` in one place (shared with
		// `getOne`, so the two cannot drift apart). Dotted tokens that select
		// fields of a relation are rewritten to PocketBase's `expand` +
		// `fields=expand.<rel>.<field>` form (raw `expand=owner.name` is
		// silently ignored by the server).
		const prepared = prepareReadQuery(
			this.queryContext(),
			{ expand: queryParams.expand, fields: queryParams.fields },
			this.fieldsPreset,
		);
		if (prepared.expand !== undefined) {
			(queryParams as Record<string, unknown>).expand = prepared.expand;
		}
		if (prepared.fields !== undefined) {
			queryParams.fields = prepared.fields;
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
		const result = await this.http.get<
			ListResult<T2 & { expand?: ExpandObj<E, TExpand> }>
		>(this.recordsPath() + "?" + qs, {
			requestKey,
			autoCancel,
			cancelKey,
			fetch,
			headers,
			signal,
			singleFlight,
			params,
		} as RequestOptions);
		// Field selection on expanded records is applied here as well (no-op
		// when the server already narrowed, e.g. PocketBase).
		if (result && prepared.narrow.size > 0) {
			result.items = result.items.map((item) =>
				applyExpandNarrowing(item, prepared.narrow),
			);
		}
		return result;
	}

	/**
	 * Fetch all records at once (auto-paginates; `batch` defaults to and is capped at 500, the server max `perPage`). Mirrors PocketBase's
	 * `pb.collection(name).getFullList()`.
	 *
	 * @param options Query params (`sort`, `filter`, `batch`, etc.) + request options.
	 */
	async getFullList<
		T2 = T,
		E extends string = never,
		S extends string = never,
		F extends string = never,
	>(
		options?: ListOptions<TFields, E, S, F> & RequestOptions,
	): Promise<Array<T2 & { expand?: ExpandObj<E, TExpand> }>> {
		const { batch: requestedBatch = MAX_PER_PAGE, ...rest } = options ?? {};
		const batch = clampBatch(requestedBatch as number);

		// Resolve a `filter` callback before computing the dedup key so the key
		// reflects the actual filter expression (a function is not serializable).
		if (typeof rest.filter === "function") {
			(rest as Record<string, unknown>).filter = this.resolveFilter(rest.filter);
		}

		// Build a stable request key for the whole full-list fetch (NOT per page,
		// which would break dedup). Concurrent identical getFullList() calls share
		// this key via single-flight, so they don't fire duplicate requests. Pages
		// still advance correctly: each page's URL differs (page=N in the query),
		// so the underlying default key is unique per page — no cross-page cancel.
		const effectiveKey =
			typeof rest.requestKey === "string"
				? rest.requestKey
				: `getFullList:${this.collectionName}:${stableStringify(rest)}`;

		const items: Array<T2 & { expand?: ExpandObj<E, TExpand> }> = [];
		let page = 1;
		for (;;) {
			const res = await this.getList<T2>(
				page,
				batch as number,
				{
					...rest,
					requestKey: effectiveKey,
					singleFlight: true,
				} as ListOptions<TFields> & RequestOptions,
			);
			if (!res || !res.items || res.items.length === 0) break;
			items.push(...(res.items as Array<T2 & { expand?: ExpandObj<E, TExpand> }>));
			if (page >= (res.totalPages ?? page)) break;
			page += 1;
		}
		return items;
	}

	/**
	 * Fetch the first record matching a filter (PocketBase `getFirstListItem`).
	 *
	 * @param filter Filter expression (e.g. `title = 'x'`).
	 * @param options Optional request options.
	 */
	async getFirstListItem<
		T2 = T,
		F extends string = never,
		E extends string = never,
		S extends string = never,
	>(
		filter: FilterInput<TFields, F>,
		options?: ListOptions<TFields, E, S, F> & RequestOptions,
	): Promise<(T2 & { expand?: ExpandObj<E, TExpand> }) | null> {
		const res = await this.getList<T2, E, S, F>(1, 1, {
			...options,
			filter,
		});
		return res?.items?.[0] ?? null;
	}

	/**
	 * Get a single record by ID.
	 * @param id Record ID.
	 * @param options Optional request options.
	 */
	async getOne<E extends string = never>(
		id: string,
		options?: ReadOptions<TFields, E> & RequestOptions,
	): Promise<(T & { expand?: ExpandObj<E, TExpand> }) | null> {
		const rawExpand = expandParam(options?.expand);
		const prepared = prepareReadQuery(
			this.queryContext(),
			{ expand: rawExpand, fields: options?.fields },
			this.fieldsPreset,
		);
		const qs = new URLSearchParams();
		if (prepared.fields !== undefined) qs.set("fields", prepared.fields);
		if (rawExpand !== undefined) {
			qs.set("expand", prepared.expand ?? rawExpand);
		}
		const qsStr = qs.toString();
		const record = await this.http.get<T & { expand?: ExpandObj<E, TExpand> }>(
			this.recordsPath() + "/" + this.encodeId(id) +
				(qsStr ? "?" + qsStr : ""),
			options,
		);
		if (record && prepared.narrow.size > 0) {
			return applyExpandNarrowing(record, prepared.narrow);
		}
		return record;
	}

	/**
	 * Create a new record.
	 * @param data Record fields. When `T` is a concrete shape (e.g. a generated
	 * record type), excess/unknown fields are rejected at compile time.
	 * @param options Optional request options.
	 */
	create(
		data: [TData] extends [never]
			? T extends ApiRecord
				? Record<string, unknown>
				: CreateData<T>
			: TData,
		options?: RequestOptions,
	): Promise<T | null> {
		return this.http.post<T>(
			this.recordsPath(),
			data,
			options,
		);
	}

	/**
	 * Update a record by ID.
	 * @param id Record ID.
	 * @param data Updated record fields. When `T` is a concrete shape, `data`
	 * must be a partial of `T` — unknown fields are rejected.
	 * @param options Optional request options.
	 */
	update(
		id: string,
		data: [TData] extends [never]
			? T extends ApiRecord
				? Record<string, unknown>
				: UpdateData<T>
			: Partial<TData>,
		options?: RequestOptions,
	): Promise<T | null> {
		return this.http.patch<T>(
			this.recordsPath() + "/" + this.encodeId(id),
			data,
			options,
		);
	}

	/**
	 * Delete a record by ID.
	 * @param id Record ID.
	 * @param options Optional request options.
	 */
	delete(id: string, options?: RequestOptions): Promise<null> {
		return this.http.delete(
			this.recordsPath() + "/" + this.encodeId(id),
			options,
		);
	}
	// ── Expand / Relation Fields ──

	/**
	 * Get a list of expandable (relation) fields for this collection.
	 * Useful for constructing `expand` query parameters.
	 */
	async expandFields(
		options?: RequestOptions,
	): Promise<{ field: string; targetCollection: string }[] | null> {
		const data = await this.http.get<{
			fields?: {
				name: string;
				type: string;
				options?: Record<string, string>;
			}[];
		}>("/collections/" + this.encodeId(this.collectionName), options);
		if (!data?.fields) return null;
		return data.fields
			.filter((f) => f.type === "relation" && f.options?.collection)
			.map((f) => ({
				field: f.name,
				targetCollection: f.options!.collection,
			}));
	}

	/**
	 * Cast this service to a specific record shape.
	 * Use when you have a hand-written or generated interface for the
	 * collection and want compile-time checking of create/update/list.
	 *
	 * @example
	 * ```ts
	 * interface Post {
	 *   id: string;
	 *   title: string;
	 *   published: boolean;
	 * }
	 * const posts = client.collection("posts").typed<Post>();
	 * await posts.create({ title: "Hi", published: true }); // ✓
	 * await posts.create({ nope: 1 }); // ✗ compile error
	 * ```
	 */
	typed<TRecord = ApiRecord>(): CollectionService<TRecord> {
		// SAFETY: the service is collection-agnostic at runtime — TRecord is a
		// compile-time lens only, so this cast is a pure type-level projection.
		return this as unknown as CollectionService<TRecord>;
	}

	/**
	 * Explicitly bind a schema for this service (overrides the client-level
	 * `types.schemas`). Enables schema-aware defaults: hidden fields are
	 * excluded from responses, select/expand are validated.
	 */
	withSchema(schema: CollectionSchema): CollectionService<T, TData, TFields, TExpand> {
		const derived = new CollectionService<T, TData, TFields, TExpand>(
			this.http,
			this.collectionName,
			this.authStore,
			this.realtime,
			schema,
			this.schemaResolver,
		);
		derived.fieldsPreset = this.fieldsPreset;
		return derived;
	}

	// ── Realtime Subscriptions (PocketBase-style) ──

	/**
	 * Subscribe to realtime changes for this collection.
	 * The event's `action` is one of `"create" | "update" | "delete"` and the
	 * callback always receives the **full record** (all fields, regardless of
	 * any `select()` projection on the service).
	 *
	 * Access is governed by the collection's `listRule` (PocketBase semantics):
	 * public collections allow anonymous subscriptions; other collections
	 * require a matching logged-in user or superuser.
	 *
	 * PocketBase-compatible argument forms:
	 *   - `subscribe(cb)` — all records of the collection
	 *   - `subscribe('*', cb)` — all records (explicit wildcard)
	 *   - `subscribe('RECORD_ID', cb)` — a single record
	 *   - `subscribe('*' | 'RECORD_ID', cb, options)` — with join options
	 *
	 * Legacy form (callback first) is still accepted: `subscribe(cb, recordId)`.
	 *
	 * @returns A function that unsubscribes this callback.
	 */
	subscribe(callback: RealtimeCallback): () => void;
	subscribe(
		recordId: string,
		callback: RealtimeCallback,
		options?: RealtimeSubscribeOptions,
	): () => void;
	/** @deprecated Use `subscribe(recordId, callback)` — PocketBase order. */
	subscribe(callback: RealtimeCallback, recordId?: string): () => void;
	subscribe(
		topicOrCallback: string | RealtimeCallback,
		maybeCallback?: RealtimeCallback | string,
		options?: RealtimeSubscribeOptions,
	): () => void {
		if (!this.realtime) {
			console.warn("[lazypock] No realtime service configured.");
			return () => {};
		}

		// Normalise PocketBase-style args; also accept the legacy callback-first
		// form (subscribe(cb, recordId)) for backward compatibility.
		let recordId: string | undefined;
		let callback: RealtimeCallback;
		let joinPayload: Record<string, unknown> | undefined;

		if (typeof topicOrCallback === "function") {
			callback = topicOrCallback;
			if (typeof maybeCallback === "string") recordId = maybeCallback;
		} else {
			callback = maybeCallback as RealtimeCallback;
			recordId = topicOrCallback === "*" ? undefined : topicOrCallback;
			// Forward subscribe options (minus HTTP-only headers) to the server
			// channel join payload.
			const { headers: _ignored, ...rest } = options ?? {};
			if (Object.keys(rest).length > 0) joinPayload = rest;
		}

		const topic =
			"collection:" +
			this.collectionName +
			(recordId ? ":" + recordId : "");
		const handler = (raw: RealtimeEventLike) => {
			const record = (raw.payload?.["record"] ?? {}) as Record<string, unknown>;
			callback({
				action: normalizeAction(raw.event, raw.payload?.["action"]),
				record,
				topic: raw.topic,
			});
		};
		this.realtime.ensureConnected();
		this.realtime.subscribe(topic, handler as never, joinPayload);
		return () => this.realtime?.unsubscribe(topic, handler as never);
	}

	/**
	 * Unsubscribe from realtime changes (PocketBase-compatible):
	 *   - `unsubscribe()` — remove **all** subscriptions of this collection
	 *   - `unsubscribe('*')` — remove wildcard subscriptions
	 *   - `unsubscribe('RECORD_ID')` — remove that record's subscriptions
	 */
	unsubscribe(recordId?: string): void {
		if (recordId === undefined) {
			this.realtime?.unsubscribeByPrefix(
				"collection:" + this.collectionName,
			);
			return;
		}
		const topic =
			"collection:" +
			this.collectionName +
			(recordId === "*" ? "" : ":" + recordId);
		this.realtime?.unsubscribe(topic);
	}

	// ── Auth Collection Methods ──

	/**
	 * Authenticate with email/password against this auth collection.
	 * Stores the returned token and user model in the auth store.
	 */
	async authWithPassword(
		identity: string,
		password: string,
		options?: RequestOptions,
	): Promise<
		({ token: string; record: ApiRecord } & Record<string, unknown>) | null
	> {
		const data = await this.http.post<
			{ token: string; record: ApiRecord } & Record<string, unknown>
		>(
			this.collectionPath() + "/auth-with-password",
			{ identity, password },
			options,
		);
		if (data && this.authStore) {
			this.authStore.setCollectionName(this.collectionName);
			// SAFETY: the server's auth response record is a superset of
			// AuthModel; the auth store consumes it generically.
			rememberAuthResponse(
				this.authStore,
				data,
				data.record as unknown as AuthModel,
			);
		}
		return data;
	}

	/**
	 * Refresh the auth token for the currently authenticated user.
	 * Updates the stored token and user model.
	 */
	async authRefresh(
		options?: RequestOptions,
	): Promise<
		({ token: string; record: ApiRecord } & Record<string, unknown>) | null
	> {
		const data = await this.http.post<
			{ token: string; record: ApiRecord } & Record<string, unknown>
		>(
			this.collectionPath() + "/auth-refresh",
			{ refreshToken: this.authStore?.refreshToken },
			options,
		);
		if (data && this.authStore) {
			this.authStore.setCollectionName(this.collectionName);
			// SAFETY: the server's auth response record is a superset of
			// AuthModel; the auth store consumes it generically.
			rememberAuthResponse(
				this.authStore,
				data,
				data.record as unknown as AuthModel,
			);
		}
		return data;
	}

	/**
	 * Get available auth methods for this collection (PocketBase `listAuthMethods`).
	 * Returns `password`, `oauth2.providers` (each with `name`, `authURL`,
	 * `state`, `codeVerifier`), and `mfa`.
	 */
	async listAuthMethods(
		options?: RequestOptions,
	): Promise<AuthMethodsList | null> {
		return this.http.get<AuthMethodsList>(
			this.collectionPath() + "/auth-methods",
			options,
		);
	}

	/**
	 * Get available auth methods for this collection.
	 * @deprecated Use {@link listAuthMethods} (typed).
	 */
	authMethods(options?: RequestOptions): Promise<AuthMethodsList | null> {
		return this.listAuthMethods(options);
	}

	// ── Email / Verification / Password Reset (PocketBase parity) ──

	/**
	 * Send a password reset email to the given address (PocketBase
	 * `requestPasswordReset`). The backend always answers 204 to avoid
	 * revealing whether the address exists.
	 */
	async requestPasswordReset(
		email: string,
		options?: RequestOptions,
	): Promise<boolean> {
		await this.http.post(
			this.collectionPath() + "/request-password-reset",
			{ email },
			options,
		);
		return true;
	}

	/**
	 * Confirm a password reset (PocketBase `confirmPasswordReset`).
	 *
	 * @param passwordResetToken The token emailed by `requestPasswordReset`.
	 * @param password The new password (min 8 chars server-side).
	 * @param passwordConfirm Must equal `password`.
	 */
	async confirmPasswordReset(
		passwordResetToken: string,
		password: string,
		passwordConfirm: string,
		options?: RequestOptions,
	): Promise<boolean> {
		await this.http.post(
			this.collectionPath() + "/confirm-password-reset",
			{ token: passwordResetToken, password, passwordConfirm },
			options,
		);
		return true;
	}

	/**
	 * Send a verification email to the given address (PocketBase
	 * `requestVerification`). The backend always answers 204 to avoid
	 * revealing whether the address exists.
	 */
	async requestVerification(
		email: string,
		options?: RequestOptions,
	): Promise<boolean> {
		await this.http.post(
			this.collectionPath() + "/request-verification",
			{ email },
			options,
		);
		return true;
	}

	/**
	 * Confirm an email verification (PocketBase `confirmVerification`).
	 * Resolves with the verified auth record.
	 */
	async confirmVerification(
		verificationToken: string,
		options?: RequestOptions,
	): Promise<T | null> {
		const data = await this.http.post<{ record: ApiRecord }>(
			this.collectionPath() + "/confirm-verification",
			{ token: verificationToken },
			options,
		);
		return (data?.record as T | undefined) ?? null;
	}

	/**
	 * Send an email-change confirmation email to a new address (PocketBase
	 * `requestEmailChange`). Requires an authenticated auth-collection user.
	 */
	async requestEmailChange(
		newEmail: string,
		options?: RequestOptions,
	): Promise<boolean> {
		await this.http.post(
			this.collectionPath() + "/request-email-change",
			{ newEmail },
			options,
		);
		return true;
	}

	/**
	 * Confirm an email change (PocketBase `confirmEmailChange`). Requires the
	 * currently authenticated user's password. Resolves with the updated auth
	 * record.
	 */
	async confirmEmailChange(
		emailChangeToken: string,
		password: string,
		options?: RequestOptions,
	): Promise<T | null> {
		const data = await this.http.post<{ record: ApiRecord }>(
			this.collectionPath() + "/confirm-email-change",
			{ token: emailChangeToken, password },
			options,
		);
		return (data?.record as T | undefined) ?? null;
	}

	/**
	 * Sign in with an OAuth2 provider (PocketBase `authWithOAuth2` parity).
	 *
	 * One call handles the whole web flow: fetch the provider's `authURL`, open a
	 * popup (or call `options.urlCallback`), receive the single-use authorization
	 * `code` the backend relays via `postMessage`, exchange it, populate the auth
	 * store, and resolve with `{ token, record, meta }`.
	 *
	 * `options.createData` is forwarded on first sign-up (the exchange goes
	 * through {@link authWithOAuth2Code}), matching PocketBase.
	 *
	 * React Native / non-browser: the popup flow depends on
	 * `window.postMessage`. Use {@link listAuthMethods} + {@link authWithOAuth2Code}
	 * instead.
	 */
	async authWithOAuth2(options: OAuth2Options): Promise<RecordAuth<T>> {
		const {
			provider,
			createData,
			urlCallback,
			popup,
			timeoutMs = DEFAULT_OAUTH2_TIMEOUT_MS,
		} = options;

		const methods = await this.listAuthMethods();
		const providerInfo = methods?.oauth2?.providers?.find(
			(p) => p.name === provider,
		);
		if (!providerInfo) {
			throw new ApiError(
				`OAuth2 provider "${provider}" is not enabled for this collection.`,
				methods ?? {},
				400,
				false,
				"oauth2_unknown_provider",
			);
		}

		// The redirect page relays only the authorization code (never a token).
		// Exchange it through the shared code path so `createData` is forwarded
		// and the auth store is populated in one place.
		const { code } = await authorizeWithOAuth2Popup({
			authURL: providerInfo.authURL,
			expectedOrigin: oauth2RedirectOrigin(this.http.baseUrl),
			urlCallback,
			popup,
			timeoutMs,
		});

		return this.authWithOAuth2Code({
			provider,
			code,
			codeVerifier: providerInfo.codeVerifier,
			createData,
		});
	}

	/**
	 * Exchange an OAuth2 authorization code directly (PocketBase
	 * `authWithOAuth2Code` parity).
	 *
	 * Used by mobile / non-browser flows: fetch {@link listAuthMethods} to get
	 * the provider `authURL` + `codeVerifier`, present the URL yourself,
	 * capture the `code` from your redirect/deep link, then call this to
	 * finish and populate the auth store.
	 */
	async authWithOAuth2Code(
		options: OAuth2AuthCodeOptions,
	): Promise<RecordAuth<T>> {
		const { provider, code, codeVerifier, redirectUrl, createData } = options;

		const data = await this.http.post<RecordAuth<ApiRecord>>(
			this.collectionPath() + "/auth-with-oauth2",
			{
				provider,
				code,
				codeVerifier,
				redirectUrl: redirectUrl ?? this.http.baseUrl + "/oauth2-redirect",
				createData: createData ?? {},
			},
		);

		if (!data) {
			throw new ApiError(
				"OAuth2 code exchange returned no data.",
				{},
				0,
				false,
				"oauth2_exchange_failed",
			);
		}

		if (this.authStore) {
			this.authStore.setCollectionName(this.collectionName);
			// SAFETY: the server's auth response record is a superset of
			// AuthModel; the auth store consumes it generically.
			rememberAuthResponse(
				this.authStore,
				data as unknown as Record<string, unknown>,
				data.record as unknown as AuthModel,
			);
		}
		// SAFETY: `data.record` is the server's auth record for this
		// collection; it satisfies `T` at runtime — `T` is a compile-time
		// lens only.
		return data as unknown as RecordAuth<T>;
	}
}
