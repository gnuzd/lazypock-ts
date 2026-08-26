// ── Collection Service ──────────────────────────────────
// Typed CRUD for a single collection (like PocketBase's pb.collection(name))

import type { HttpClient } from "./http";
import type { AuthStore, AuthModel } from "./auth";
import type {
	ApiRecord,
	ListResult,
	RequestOptions,
	CreateData,
	UpdateData,
	ListOptions,
	ReadOptions,
	FilterString,
	FieldKey,
} from "./types";
import type { RealtimeService } from "./realtime";
import type { CollectionSchema } from "./schema";

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
 */
export class CollectionService<T = ApiRecord, TData = never, TFields = T> {
	private http: HttpClient;
	private collectionName: string;
	private authStore?: AuthStore;
	private realtime?: RealtimeService;
	/** Optional schema for this collection (from client `types.schemas`). */
	private schema?: CollectionSchema;
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
	) {
		this.http = http;
		this.collectionName = collectionName;
		this.authStore = authStore;
		this.realtime = realtime;
		this.schema = schema;
	}

	private encodeId(id: string): string {
		return encodeURIComponent(id);
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
	): CollectionService<T, TData, TFields> {
		const preset = fields.length === 0 ? "*" : fields.join(",");
		const derived = new CollectionService<T, TData, TFields>(
			this.http,
			this.collectionName,
			this.authStore,
			this.realtime,
			this.schema,
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
	 * Fields to send with reads:
	 * 1. explicit `options.fields` (caller wins)
	 * 2. `select()` preset
	 * 3. schema default — all visible (non-hidden) fields plus the implicit
	 *    system keys (`id`, `created`, `updated`, `collectionId`, `collectionName`)
	 */
	private effectiveFields(optionsFields?: string): string | undefined {
		if (optionsFields !== undefined) return optionsFields;
		if (this.fieldsPreset !== undefined) {
			if (this.fieldsPreset === "*") {
				return this.visibleFields();
			}
			return this.fieldsPreset;
		}
		return this.visibleFields();
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
	visibleFields(): string | undefined {
		if (!this.schema?.fields) return undefined;
		const visible = this.schema.fields
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

	/** Warn once when an expand field is not a relation (schema known). */
	private validateExpand(expand: string | undefined): void {
		if (!expand || !this.schema?.fields) return;
		const relations = new Set(
			this.schema.fields
				.filter((f) => f.type === "relation")
				.map((f) => f.name),
		);
		for (const f of expand.split(",")) {
			const name = f.trim();
			if (name && !relations.has(name)) {
				console.warn(
					`[lazypock] expand("${name}"): field is not a relation on collection "${this.collectionName}"`,
				);
			}
		}
	}

	/**
	 * Fetch a paginated list of records (PocketBase `getList`).
	 *
	 * @param page Page number (default 1).
	 * @param perPage Records per page (default 30).
	 * @param options Query params (`filter`, `sort`, `expand`, `fields`) + request options.
	 */
	getList<T2 = T>(
		page = 1,
		perPage = 30,
		options?: ListOptions<TFields> & RequestOptions,
	): Promise<ListResult<T2> | null> {
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
		// Resolve the effective `fields` projection (select() preset or schema
		// default) unless the caller passed an explicit `fields`.
		const fields = this.effectiveFields(queryParams.fields as string | undefined);
		if (fields !== undefined && queryParams.fields === undefined) {
			queryParams.fields = fields;
		}
		if (typeof queryParams.expand === "string") {
			this.validateExpand(queryParams.expand);
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
		return this.http.get<ListResult<T2>>(
			"/" + this.encodeId(this.collectionName) + "?" + qs,
			{
				requestKey,
				autoCancel,
				cancelKey,
				fetch,
				headers,
				signal,
				singleFlight,
				params,
			} as RequestOptions,
		);
	}

	/**
	 * Fetch all records at once (auto-paginates). Mirrors PocketBase's
	 * `pb.collection(name).getFullList()`.
	 *
	 * @param options Query params (`sort`, `filter`, `batch`, etc.) + request options.
	 */
	async getFullList<T2 = T>(
		options?: ListOptions<TFields> & RequestOptions,
	): Promise<Array<T2>> {
		const { batch = 1000, ...rest } = options ?? {};

		// Build a stable request key for the whole full-list fetch (NOT per page,
		// which would break dedup). Concurrent identical getFullList() calls share
		// this key via single-flight, so they don't fire duplicate requests. Pages
		// still advance correctly: each page's URL differs (page=N in the query),
		// so the underlying default key is unique per page — no cross-page cancel.
		const effectiveKey =
			typeof rest.requestKey === "string"
				? rest.requestKey
				: `getFullList:${this.collectionName}:${stableStringify(rest)}`;

		const items: T2[] = [];
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
			items.push(...(res.items as T2[]));
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
	async getFirstListItem<T2 = T>(
		filter: FilterString<TFields>,
		options?: ListOptions<TFields> & RequestOptions,
	): Promise<T2 | null> {
		const res = await this.getList<T2>(1, 1, {
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
	getOne(
		id: string,
		options?: ReadOptions<TFields> & RequestOptions,
	): Promise<T | null> {
		const fields = this.effectiveFields(options?.fields);
		if (typeof options?.expand === "string") {
			this.validateExpand(options.expand);
		}
		const qs = new URLSearchParams();
		if (fields !== undefined) qs.set("fields", fields);
		if (typeof options?.expand === "string") qs.set("expand", options.expand);
		const qsStr = qs.toString();
		return this.http.get<T>(
			"/" +
				this.encodeId(this.collectionName) +
				"/" +
				this.encodeId(id) +
				(qsStr ? "?" + qsStr : ""),
			options,
		);
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
			"/" + this.encodeId(this.collectionName),
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
			"/" + this.encodeId(this.collectionName) + "/" + this.encodeId(id),
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
			"/" + this.encodeId(this.collectionName) + "/" + this.encodeId(id),
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
	withSchema(schema: CollectionSchema): CollectionService<T, TData, TFields> {
		const derived = new CollectionService<T, TData, TFields>(
			this.http,
			this.collectionName,
			this.authStore,
			this.realtime,
			schema,
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
			"/" + this.encodeId(this.collectionName) + "/auth-with-password",
			{ identity, password },
			options,
		);
		if (data && this.authStore) {
			this.authStore.setCollectionName(this.collectionName);
			// SAFETY: the server's auth response record is a superset of
			// AuthModel; the auth store consumes it generically.
			this.authStore.set(data.token, data.record as unknown as AuthModel);
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
			"/" + this.encodeId(this.collectionName) + "/auth-refresh",
			undefined,
			options,
		);
		if (data && this.authStore) {
			this.authStore.setCollectionName(this.collectionName);
			// SAFETY: the server's auth response record is a superset of
			// AuthModel; the auth store consumes it generically.
			this.authStore.set(data.token, data.record as unknown as AuthModel);
		}
		return data;
	}

	/**
	 * Get available auth methods for this collection.
	 */
	// ── end Realtime ──

	async authMethods(
		options?: RequestOptions,
	): Promise<Record<string, unknown> | null> {
		return this.http.get<Record<string, unknown>>(
			"/" + this.encodeId(this.collectionName) + "/auth-methods",
			options,
		);
	}
}
