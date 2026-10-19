// ── HTTP Client ─────────────────────────────────────────
// Only relies on globalThis.fetch — works in browser, React Native, and Node 18+

import { ApiError, type Method, type RequestOptions } from "./types";
import type { AuthModel, AuthStore } from "./auth";

/** The auth collection the server serves superusers on, and the refresh path used
 * when a session belongs to no collection (a superuser login). */
const SUPERUSERS = "_superusers";

/**
 * Low-level HTTP client wrapping `fetch` with automatic auth token injection.
 * Only relies on `globalThis.fetch` — works in browser, React Native, and Node 18+.
 */
/** Detect whether an unknown thrown value is an abort/`AbortError`-style error. */
function isAbortError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "AbortError" || err.message === "Aborted")
	);
}

export class HttpClient {
	private _baseUrl: string;
	private authStore: AuthStore;
	private defaultFetch: typeof globalThis.fetch;

	// Per-client connection id (browser tab / device). Sent as the
	// `X-Connection-Id` header on every request so the server can exclude
	// the *originating* connection from its own realtime broadcasts.
	private connectionId?: string;

	/**
	 * Abort controllers for in-flight requests, keyed by their cancellation key
	 * (default `METHOD path`). A new request with the same key aborts the
	 * previous one — PocketBase-style auto-cancellation of duplicated requests.
	 */
	private cancelControllers: Record<string, AbortController> = {};

	/**
	 * In-flight request promises, keyed by cancellation key. When auto-cancellation
	 * would abort a pending duplicate, the newer request instead awaits the same
	 * promise — single-flight coalescing (no duplicate network request, no
	 * spurious abort rejection for the caller).
	 */
	private inflight: Record<string, Promise<unknown>> = {};

	/** Global toggle for the auto-cancellation behaviour (default: on). */
	private enableAutoCancellation = true;

	/**
	 * @param baseUrl The API base URL (e.g. `http://localhost:4000/api`). Trailing slash stripped.
	 * @param authStore The auth store providing the token for Authorization headers.
	 * @param connectionId Optional per-client connection id, sent as the
	 * `X-Connection-Id` header on every request (realtime origin-exclusion).
	 */
	constructor(baseUrl: string, authStore: AuthStore, connectionId?: string) {
		this._baseUrl = baseUrl.replace(/\/+$/, "");
		this.authStore = authStore;
		this.connectionId = connectionId;
		this.defaultFetch = globalThis.fetch.bind(globalThis);
	}

	/** The API base URL (trailing slash stripped). Used for OAuth2 origin checks. */
	get baseUrl(): string {
		return this._baseUrl;
	}

	/** A refresh already in flight, so concurrent requests rotate once, not N times. */
	private refreshInFlight: Promise<boolean> | null = null;

	/**
	 * Exchange the stored refresh token for a new access token.
	 *
	 * The server's `auth-refresh` wants the **refresh** token — in the body, or as the
	 * bearer — not the access token this used to send, which is why every refresh
	 * attempt 401'd and cleared the session. The collection is the one the session
	 * belongs to, or `_superusers` when the store has none (a superuser login).
	 *
	 * A network failure keeps the session (the next request can retry); only a refusal
	 * by the server ends it.
	 */
	private async refreshAuth(): Promise<{ token: string; record: Record<string, unknown> } | null> {
		const refreshToken = this.authStore.refreshToken;
		if (!refreshToken) return null;
		if (this.refreshInFlight) {
			const refreshed = await this.refreshInFlight;
			return refreshed ? this.currentAuthResponse() : null;
		}

		this.refreshInFlight = this.performRefresh(refreshToken);
		try {
			const refreshed = await this.refreshInFlight;
			return refreshed ? this.currentAuthResponse() : null;
		} finally {
			this.refreshInFlight = null;
		}
	}

	/** The store's current session, in the shape the old refresh returned. */
	private currentAuthResponse(): {
		token: string;
		record: Record<string, unknown>;
	} {
		return {
			token: this.authStore.token,
			record: (this.authStore.model ?? {}) as unknown as Record<string, unknown>,
		};
	}

	private async performRefresh(refreshToken: string): Promise<boolean> {
		const collection = this.refreshCollection();
		try {
			const res = await this.defaultFetch(
				this.baseUrl +
					"/collections/" +
					encodeURIComponent(collection) +
					"/auth-refresh",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refreshToken }),
				},
			);
			if (!res.ok) {
				// Revoked, expired, replayed or from another collection: there is no
				// session left to keep.
				if (res.status === 400 || res.status === 401) {
					this.authStore.clear();
				}
				return false;
			}
			const data = (await res.json()) as Record<string, unknown>;
			if (!data || typeof data.token !== "string") {
				this.authStore.clear();
				return false;
			}
			const record = data["record"];
			const model: AuthModel | null =
				record && typeof record === "object" ? (record as AuthModel) : null;
			this.authStore.setCollectionName(
				collection === SUPERUSERS ? null : collection,
			);
			this.authStore.setSession(data.token, model, {
				refreshToken:
					typeof data.refreshToken === "string" ? data.refreshToken : undefined,
				expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : undefined,
			});
			return true;
		} catch {
			return false;
		}
	}

	/** The auth collection a refresh is addressed to, including superusers. */
	private refreshCollection(): string {
		if (this.authStore.collectionName) return this.authStore.collectionName;
		const model = this.authStore.model as { collectionName?: unknown } | null;
		if (model && typeof model.collectionName === "string" && model.collectionName) {
			return model.collectionName;
		}
		return SUPERUSERS;
	}

	/**
	 * Globally enable or disable auto-cancellation of duplicated pending requests.
	 * Fluent — returns `this` for chaining.
	 */
	autoCancellation(enable: boolean): this {
		this.enableAutoCancellation = !!enable;
		return this;
	}

	/**
	 * Abort a pending request identified by its cancellation key
	 * (default `METHOD path`, e.g. `"GET /api/posts"`). No-op if not pending.
	 */
	cancelRequest(requestKey: string): this {
		const controller = this.cancelControllers[requestKey];
		if (controller) {
			controller.abort();
			delete this.cancelControllers[requestKey];
		}
		return this;
	}

	/** Abort all pending requests. */
	cancelAllRequests(): this {
		for (const key in this.cancelControllers) {
			this.cancelControllers[key].abort();
		}
		this.cancelControllers = {};
		return this;
	}

	/**
	 * Make an HTTP request with automatic auth token injection and optional auto-refresh.
	 *
	 * Auto-cancellation: a request keyed by `options.requestKey` (default
	 * `METHOD path`) aborts any previous pending request with the same key,
	 * so only the last duplicate executes. Set `requestKey: null` or
	 * `autoCancel: false` to opt out per request.
	 *
	 * @param method HTTP method.
	 * @param path URL path (appended to baseUrl).
	 * @param body JSON-serializable body, or FormData for file uploads.
	 * @param options Optional request options.
	 * @returns Parsed JSON response, or null for 204 No Content.
	 * @throws {ApiError} On non-2xx responses or when the request is aborted
	 * (aborted requests throw an `ApiError` with `isAbort === true`).
	 */
	async request<T = unknown>(
		method: Method,
		path: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T | null> {
		// Refresh just before the access token lapses. A superuser session has no
		// collection name, so guarding on it (as this used to) skipped every superuser
		// refresh and signed the Studio out at the 15-minute mark.
		if (this.authStore.isExpired && this.authStore.refreshToken) {
			await this.refreshAuth();
		}

		// Resolve the auto-cancellation key (PocketBase `requestKey` semantics):
		// - options.requestKey null  → disabled for this request
		// - options.requestKey string → use it verbatim
		// - options.autoCancel false → disabled (legacy compat)
		// - options.cancelKey string → use it verbatim (legacy compat)
		// - otherwise → default to `${method} ${path}`
		let requestKey: string | null =
			options?.requestKey === undefined
				? (options?.cancelKey ?? `${method} ${path}`)
				: options.requestKey;
		if (options?.autoCancel === false) requestKey = null;

		// Single-flight coalescing: when the same requestKey is already in-flight
		// and the caller opted in, reuse that promise instead of firing a duplicate
		// request (no abort rejection for either caller).
		if (options?.singleFlight && requestKey !== null) {
			const pending = this.inflight[requestKey];
			if (pending !== undefined) {
				return pending as Promise<T | null>;
			}
		}

		// Wire a fresh AbortController for this request, merging any caller signal.
		// When auto-cancellation is enabled, the previous pending request sharing
		// our key is aborted first (only the last duplicate executes).
		let controller: AbortController | null = null;
		const externalSignal = options?.signal;
		if (requestKey !== null) {
			if (this.enableAutoCancellation) {
				this.cancelRequest(requestKey);
			}
			controller = new AbortController();
			this.cancelControllers[requestKey] = controller;
			if (externalSignal?.aborted) {
				controller.abort();
			} else if (externalSignal) {
				externalSignal.addEventListener("abort", () => controller?.abort(), {
					once: true,
				});
			}
		}
		const signal = controller?.signal ?? externalSignal;

		// Register the in-flight promise so later single-flight callers reuse it.
		// The promise is created from an inner async fn that performs the request
		// and clears itself from the inflight map on settle.
		const perform = async (): Promise<T | null> => {
			try {
				return await this.doRequest(
					method,
					path,
					body,
					options,
					signal,
					requestKey,
					controller,
				);
			} finally {
				if (requestKey !== null) {
					if (this.inflight[requestKey] === promise) {
						delete this.inflight[requestKey];
					}
				}
			}
		};
		const promise = perform();
		if (requestKey !== null) {
			this.inflight[requestKey] = promise;
		}
		return promise;
	}

	/**
	 * Execute the actual HTTP request (fetch + parse). Called by {@link request}
	 * as the inner in-flight unit so single-flight callers can reuse the promise.
	 */
	private async doRequest<T = unknown>(
		method: Method,
		path: string,
		body: unknown,
		options: RequestOptions | undefined,
		signal: AbortSignal | null | undefined,
		requestKey: string | null,
		controller: AbortController | null,
	): Promise<T | null> {
		let url = this.baseUrl + path;
		if (options?.params) {
			const qs = new URLSearchParams(options.params).toString();
			if (qs) {
				url += (path.includes("?") ? "&" : "?") + qs;
			}
		}
		const headers: Record<string, string> = {
			...options?.headers,
		};

		// Don't set Content-Type for FormData (browser sets multipart boundary)
		if (!(body instanceof FormData)) {
			headers["Content-Type"] = "application/json";
		}

		if (this.authStore.token) {
			headers["Authorization"] = "Bearer " + this.authStore.token;
		}

		// Advertise the connection id unless the caller already set it
		// explicitly (a custom wrapper's id wins — it must match the id it
		// put on the socket URL).
		if (
			this.connectionId &&
			!headers["X-Connection-Id"] &&
			!headers["x-connection-id"]
		) {
			headers["X-Connection-Id"] = this.connectionId;
		}

		const init: RequestInit = {
			method,
			headers,
			signal,
		};

		if (body != null && method !== "GET" && method !== "DELETE") {
			if (body instanceof FormData) {
				init.body = body;
			} else {
				init.body = JSON.stringify(body);
			}
		}

		let res: Response | null = null;
		const fetcher = options?.fetch ?? this.defaultFetch;
		const send = async (): Promise<Response> => fetcher(url, init);
		try {
			res = await send();
		} catch (err) {
			// Aborted (auto-cancelled duplicate, manual cancel, or external signal)
			// → normalized ApiError with isAbort === true, like PocketBase.
			if (isAbortError(err)) {
				throw new ApiError(
					"The request was aborted (most likely auto-cancelled by a newer request with the same requestKey)",
					{},
					0,
					true,
				);
			}
			throw err;
		} finally {
			// The request has settled — no longer pending, so drop the controller
			// unless a newer request already replaced it (same key).
			if (
				requestKey !== null &&
				this.cancelControllers[requestKey] === controller
			) {
				delete this.cancelControllers[requestKey];
			}
		}

		// A refused token does not always mean a dead session: it can be a stale access
		// token the recorded expiry did not predict (clock skew, a reloaded tab, a
		// revocation elsewhere). Refresh once and retry — after that, the 401 is the
		// answer.
		if (res!.status === 401 && this.authStore.refreshToken) {
			// Release the refused response before reusing the connection.
			await res!.text().catch(() => {});
			const refreshed = await this.refreshAuth();
			if (refreshed) {
				headers["Authorization"] = "Bearer " + this.authStore.token;
				try {
					res = await send();
				} catch (err) {
					if (isAbortError(err)) {
						throw new ApiError(
							"The request was aborted (most likely auto-cancelled by a newer request with the same requestKey)",
							{},
							0,
							true,
						);
					}
					throw err;
				}
			}
		}

		if (res!.status === 204) return null;

		// Safely parse JSON — some errored responses may have empty or non-JSON bodies
		let bodyText = "";
		let data: Record<string, unknown> = {};
		try {
			bodyText = await res.text();
			if (bodyText) {
				data = JSON.parse(bodyText) as Record<string, unknown>;
			}
		} catch (err) {
			// An abort that lands while the body is streaming (auto-cancelled
			// duplicate, manual cancel, or external signal) means the whole
			// request was cancelled — surface it as an abort error instead of
			// silently returning an empty object, which callers would treat as
			// a successful-but-empty response (e.g. a list request would clear
			// the current rows).
			if (isAbortError(err)) {
				throw new ApiError(
					"The request was aborted (most likely auto-cancelled by a newer request with the same requestKey)",
					{},
					0,
					true,
				);
			}
			// Not JSON / read failure — keep data as empty object
		}

		if (!res!.ok) {
			throw new ApiError(
				(typeof data.message === "string" ? data.message : res!.statusText) ||
					`Request failed with status ${res!.status}`,
				data,
				res!.status,
			);
		}

		return data as T;
	}

	/**
	 * HTTP GET.
	 * @param path URL path.
	 * @param options Optional request options.
	 */
	get<T = unknown>(path: string, options?: RequestOptions): Promise<T | null> {
		return this.request<T>("GET", path, undefined, options);
	}

	/**
	 * HTTP POST.
	 * @param path URL path.
	 * @param body Optional request body.
	 * @param options Optional request options.
	 */
	post<T = unknown>(
		path: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T | null> {
		return this.request<T>("POST", path, body, options);
	}

	/**
	 * HTTP PATCH.
	 * @param path URL path.
	 * @param body Optional request body.
	 * @param options Optional request options.
	 */
	patch<T = unknown>(
		path: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T | null> {
		return this.request<T>("PATCH", path, body, options);
	}

	/**
	 * HTTP DELETE.
	 * @param path URL path.
	 * @param options Optional request options.
	 */
	delete<T = unknown>(
		path: string,
		options?: RequestOptions,
	): Promise<T | null> {
		return this.request<T>("DELETE", path, undefined, options);
	}
}
