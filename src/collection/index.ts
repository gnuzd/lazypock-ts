// ── Collection Service ──────────────────────────────────
// Typed CRUD for a single collection (like PocketBase's pb.collection(name)).
//
// This is the public facade. The pieces it composes live alongside it:
//   - expand.ts        — pure expand/field-selection normalisation
//   - projection.ts    — which fields a read asks for
//   - paginate.ts      — getFullList page walking + dedup key
//   - collection/auth.ts, collection/realtime.ts — the non-CRUD routes
//
// Keep this class thin: it holds the per-collection state (schema, select()
// preset) and delegates everything else.

import type { HttpClient } from "../http";
import type { AuthStore } from "../auth";
import {
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
} from "../types";
import type { RealtimeService } from "../realtime";
import { FilterBuilder, type FilterExpr } from "../filter";
import type { CollectionSchema } from "../schema";
import {
	effectiveFields as resolveEffectiveFields,
	visibleFields as listVisibleFields,
	SYSTEM_FIELDS,
} from "../projection";
import {
	applyExpandNarrowing,
	type ExpandContext,
	type SchemaResolver,
} from "../expand";
import { fullListKey, paginateAll, splitListOptions } from "../paginate";
import { buildListQuery, buildReadQuery, type QueryContext } from "./query";
import { collectionPath, encodeId, recordsPath } from "./paths";
import type { SessionContext } from "./session";
import type { AuthMethodsList, OAuth2Options, OAuth2AuthCodeOptions, RecordAuth } from "../oauth2";
import {
	authRefresh,
	authWithOAuth2,
	authWithOAuth2Code,
	authWithPassword,
	confirmEmailChange,
	confirmPasswordReset,
	confirmVerification,
	listAuthMethods,
	requestEmailChange,
	requestPasswordReset,
	requestVerification,
} from "./auth";
import {
	subscribeToCollection,
	unsubscribeFromCollection,
	type RealtimeCallback,
	type RealtimeSubscribeOptions,
} from "./realtime";

export type { RealtimeCallback, RealtimeMessage, RealtimeSubscribeOptions } from "./realtime";
export type { SchemaResolver } from "../expand";

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

	/**
	 * A copy of this service with the given overrides applied.
	 *
	 * Every field is listed exactly once, so a new service-level field can't be
	 * silently dropped by `select()` or `withSchema()`.
	 */
	private derive(patch: {
		schema?: CollectionSchema;
		fieldsPreset?: string;
	} = {}): CollectionService<T, TData, TFields, TExpand> {
		const derived = new CollectionService<T, TData, TFields, TExpand>(
			this.http,
			this.collectionName,
			this.authStore,
			this.realtime,
			patch.schema ?? this.schema,
			this.schemaResolver,
		);
		derived.fieldsPreset = patch.fieldsPreset ?? this.fieldsPreset;
		return derived;
	}

	/** The records endpoint for this collection. */
	private recordsPath(): string {
		return recordsPath(this.collectionName);
	}

	/** The collection's own endpoint, which is where its auth routes live. */
	private collectionPath(): string {
		return collectionPath(this.collectionName);
	}

	private encodeId(id: string): string {
		return encodeId(id);
	}

	/** What the auth routes need: transport, collection name, session store. */
	private sessionContext(): SessionContext {
		return {
			http: this.http,
			collectionName: this.collectionName,
			authStore: this.authStore,
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
	 * // All visible fields (implicit system keys id/created/updated/... are
	 * // kept; hidden fields are excluded via the projection)
	 * const all = await client.collection("posts").select("*").getList();
	 * // GET /api/posts?fields=id,created,updated,collectionId,collectionName,title,published,... (schema known)
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
		const derived = this.derive({ fieldsPreset: preset });
		if (this.schema && preset !== "*") {
			// System keys are implicit: they never appear in a schema, so
			// treating them as unknown would warn on `select("id")`.
			const known = new Set<string>([
				...SYSTEM_FIELDS,
				...(this.schema.fields?.map((f) => f.name) ?? []),
			]);
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
		return resolveEffectiveFields(this.schema, this.fieldsPreset, optionsFields);
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
		return listVisibleFields(this.schema);
	}

	/** Service state that query building needs. */
	private queryContext(): QueryContext {
		return {
			expand: this.expandContext(),
			effectiveFields: (optionsFields) => this.effectiveFields(optionsFields),
			resolveFilter: (filter) =>
				this.resolveFilter(filter as FilterInput<TFields>),
		};
	}

	/** Context for the schema-aware expand helpers. */
	private expandContext(): ExpandContext {
		return {
			collectionName: this.collectionName,
			schema: this.schema,
			resolveCollection: (key) => this.schemaResolver?.(key),
		};
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
	 * // → filter=(title ~ 'x' && published = true)
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
		const { requestKey, autoCancel, cancelKey, fetch, headers, signal, singleFlight, params, ...queryParams } =
			options ?? {};
		const { qs, narrow } = buildListQuery(
			this.queryContext(),
			page,
			perPage,
			queryParams as Record<string, unknown>,
		);
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
		if (result && narrow.size > 0) {
			result.items = result.items.map((item) =>
				applyExpandNarrowing(item, narrow),
			);
		}
		return result;
	}

	/**
	 * Fetch all records at once (auto-paginates; `batch` defaults to and is
	 * capped at 500, the server max `perPage`). Mirrors PocketBase's
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
		const { query, transport, batch } = splitListOptions(
			options as Record<string, unknown> & RequestOptions,
		);

		// Resolve a `filter` callback before computing the dedup key so the key
		// reflects the actual filter expression (a function is not serializable).
		if (typeof query.filter === "function") {
			query.filter = this.resolveFilter(query.filter as FilterInput<TFields>);
		}

		const effectiveKey = fullListKey(
			this.collectionName,
			query,
			transport.requestKey,
		);

		return paginateAll<T2 & { expand?: ExpandObj<E, TExpand> }>(batch, (page) =>
			this.getList<T2, E, S, F>(page, batch, {
				...query,
				...transport,
				requestKey: effectiveKey,
				singleFlight: true,
			} as ListOptions<TFields, E, S, F> & RequestOptions),
		);
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
		const { qs, narrow } = buildReadQuery(this.queryContext(), options);
		const record = await this.http.get<T & { expand?: ExpandObj<E, TExpand> }>(
			this.recordsPath() + "/" + this.encodeId(id) + (qs ? "?" + qs : ""),
			options,
		);
		if (record && narrow.size > 0) {
			return applyExpandNarrowing(record, narrow);
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
		}>(this.collectionPath(), options);
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
		return this.derive({ schema });
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
		return subscribeToCollection(
			{ realtime: this.realtime, collectionName: this.collectionName },
			topicOrCallback,
			maybeCallback,
			options,
		);
	}

	/**
	 * Unsubscribe from realtime changes (PocketBase-compatible):
	 *   - `unsubscribe()` — remove **all** subscriptions of this collection
	 *   - `unsubscribe('*')` — remove wildcard subscriptions
	 *   - `unsubscribe('RECORD_ID')` — remove that record's subscriptions
	 */
	unsubscribe(recordId?: string): void {
		unsubscribeFromCollection(
			{ realtime: this.realtime, collectionName: this.collectionName },
			recordId,
		);
	}

	// ── Auth Collection Methods ──

	/**
	 * Authenticate with email/password against this auth collection.
	 * Stores the returned token and user model in the auth store.
	 */
	authWithPassword(
		identity: string,
		password: string,
		options?: RequestOptions,
	): Promise<({ token: string; record: ApiRecord } & Record<string, unknown>) | null> {
		return authWithPassword(this.sessionContext(), identity, password, options);
	}

	/**
	 * Refresh the auth token for the currently authenticated user.
	 * Updates the stored token and user model.
	 */
	authRefresh(
		options?: RequestOptions,
	): Promise<({ token: string; record: ApiRecord } & Record<string, unknown>) | null> {
		return authRefresh(this.sessionContext(), options);
	}

	/**
	 * Get available auth methods for this collection (PocketBase `listAuthMethods`).
	 * Returns `password`, `oauth2.providers` (each with `name`, `authURL`,
	 * `state`, `codeVerifier`), and `mfa`.
	 */
	listAuthMethods(options?: RequestOptions): Promise<AuthMethodsList | null> {
		return listAuthMethods(this.sessionContext(), options);
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
	requestPasswordReset(email: string, options?: RequestOptions): Promise<boolean> {
		return requestPasswordReset(this.sessionContext(), email, options);
	}

	/**
	 * Confirm a password reset (PocketBase `confirmPasswordReset`).
	 *
	 * @param passwordResetToken The token emailed by `requestPasswordReset`.
	 * @param password The new password (min 8 chars server-side).
	 * @param passwordConfirm Must equal `password`.
	 */
	confirmPasswordReset(
		passwordResetToken: string,
		password: string,
		passwordConfirm: string,
		options?: RequestOptions,
	): Promise<boolean> {
		return confirmPasswordReset(
			this.sessionContext(),
			passwordResetToken,
			password,
			passwordConfirm,
			options,
		);
	}

	/**
	 * Send a verification email to the given address (PocketBase
	 * `requestVerification`). The backend always answers 204 to avoid
	 * revealing whether the address exists.
	 */
	requestVerification(email: string, options?: RequestOptions): Promise<boolean> {
		return requestVerification(this.sessionContext(), email, options);
	}

	/**
	 * Confirm an email verification (PocketBase `confirmVerification`).
	 * Resolves with the verified auth record.
	 */
	confirmVerification(
		verificationToken: string,
		options?: RequestOptions,
	): Promise<T | null> {
		return confirmVerification<T>(this.sessionContext(), verificationToken, options);
	}

	/**
	 * Send an email-change confirmation email to a new address (PocketBase
	 * `requestEmailChange`). Requires an authenticated auth-collection user.
	 */
	requestEmailChange(newEmail: string, options?: RequestOptions): Promise<boolean> {
		return requestEmailChange(this.sessionContext(), newEmail, options);
	}

	/**
	 * Confirm an email change (PocketBase `confirmEmailChange`). Requires the
	 * currently authenticated user's password. Resolves with the updated auth
	 * record.
	 */
	confirmEmailChange(
		emailChangeToken: string,
		password: string,
		options?: RequestOptions,
	): Promise<T | null> {
		return confirmEmailChange<T>(
			this.sessionContext(),
			emailChangeToken,
			password,
			options,
		);
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
	authWithOAuth2(options: OAuth2Options): Promise<RecordAuth<T>> {
		return authWithOAuth2<T>(this.sessionContext(), options);
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
	authWithOAuth2Code(options: OAuth2AuthCodeOptions): Promise<RecordAuth<T>> {
		return authWithOAuth2Code<T>(this.sessionContext(), options);
	}
}
