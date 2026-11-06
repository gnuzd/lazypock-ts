// ── Auth Store ──────────────────────────────────────────
// Pluggable storage adapter: swap for AsyncStorage on RN, localStorage on web, etc.

/**
 * Interface for pluggable persistence backends.
 * Swap for `AsyncStorage` on React Native, `localStorage` on web, etc.
 */
export interface StorageAdapter {
	/** Retrieve a stored value by key. */
	get(key: string): string | null | Promise<string | null>;
	/** Persist a key-value pair. */
	set(key: string, value: string): void | Promise<void>;
	/** Remove a stored value by key. */
	remove(key: string): void | Promise<void>;
}

/**
 * Shape of an authenticated user record (from auth collections).
 *
 * The server returns PocketBase-shaped records, so `collectionName` /
 * `collectionId` are normally present and let the store recover the auth
 * collection from a restored session.
 */
export interface AuthModel {
	id: string;
	collectionName?: string;
	collectionId?: string;
	[key: string]: unknown;
}

/** Callback signature for auth state changes. */
export type AuthListener = (model: AuthModel | null, token: string) => void;

// Fallback only. The server's auth responses carry `expiresIn` (the access token's
// real lifetime, 15 minutes on the Rust server), which is what `setSession` records.
// The old constant assumed a 7-day Phoenix token, so a client that never used
// `expiresIn` never refreshed in time and was signed out mid-session.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthStore {
	private _token = "";
	private _model: AuthModel | null = null;
	private _tokenExpiresAt: number | null = null;
	private _refreshToken = "";
	private _collectionName: string | null = null;
	private listeners = new Set<AuthListener>();
	private storage: StorageAdapter;

	/**
	 * Create an AuthStore with optional custom storage adapter.
	 * @param storage Persistence backend. Defaults to `memoryStorage` (localStorage fallback).
	 */
	constructor(storage?: StorageAdapter) {
		this.storage = storage ?? {
			get: (_key: string) => null,
			set: () => {},
			remove: () => {},
		};
	}

	/** The current JWT token string, or empty string if not authenticated. */
	get token(): string {
		return this._token;
	}

	/**
	 * The refresh token for the current session, or empty string.
	 *
	 * Kept by the store so a session can outlive the access token (15 minutes on the
	 * server) even across a reload. Persisted under `auth_refresh_token`.
	 */
	get refreshToken(): string {
		return this._refreshToken;
	}

	/** The current authenticated user record, or null. */
	get model(): AuthModel | null {
		return this._model;
	}

	/** Whether a token exists (does not check expiry). */
	get isValid(): boolean {
		return !!this._token;
	}

	/**
	 * Whether the current token has expired (with a 30-second buffer).
	 * Returns false when no expiry has been recorded (e.g. superuser tokens).
	 */
	get isExpired(): boolean {
		return (
			this._tokenExpiresAt !== null &&
			Date.now() >= this._tokenExpiresAt - 30000
		);
	}

	/** The auth collection name used for automatic token refresh. */
	get collectionName(): string | null {
		return this._collectionName;
	}

	/**
	 * Set the auth collection name (used internally by auto-refresh).
	 *
	 * Persisted, so it survives a reload together with the token and model.
	 * @param name The collection name, or null for superuser tokens.
	 */
	setCollectionName(name: string | null): void {
		this._collectionName = name;
		void this.persistCollectionName();
	}

	/**
	 * Load persisted auth state from storage.
	 * Should be called once at application startup.
	 */
	async init(): Promise<void> {
		const [token, model, expiresAt, collectionName, refreshToken] = await Promise.all([
			this.storage.get("auth_token"),
			this.storage.get("auth_model"),
			this.storage.get("auth_expires_at"),
			this.storage.get("auth_collection"),
			this.storage.get("auth_refresh_token"),
		]);
		if (token) this._token = token;
		if (expiresAt) this._tokenExpiresAt = parseInt(expiresAt, 10) || null;
		if (refreshToken) this._refreshToken = refreshToken;
		if (model) {
			try {
				this._model = JSON.parse(model);
			} catch {
				// ignore corrupt data
			}
		}

		if (collectionName) {
			this._collectionName = collectionName;
		} else if (this._model && typeof this._model.collectionName === "string") {
			// Sessions persisted by older versions (or a caller that only called
			// `set`) have no `auth_collection` — recover it from the record.
			this._collectionName = this._model.collectionName;
		}
	}

	/**
	 * Update the current auth token and model, persist to storage, and notify listeners.
	 *
	 * Uses the fallback TTL; prefer {@link setSession} with a server auth response,
	 * which carries the real `expiresIn` and the refresh token.
	 *
	 * @param token The JWT token string.
	 * @param model The authenticated user record, or null for superusers.
	 */
	set(token: string, model: AuthModel | null): void {
		this._token = token;
		this._model = model;
		this._tokenExpiresAt = Date.now() + TOKEN_TTL_MS;

		// Derive the auth collection from the record when the caller did not set it
		// explicitly (e.g. a token refresh of a restored session).
		if (!this._collectionName && model && typeof model.collectionName === "string") {
			this._collectionName = model.collectionName;
		}

		void Promise.all([
			this.storage.set("auth_token", token),
			this.storage.set("auth_expires_at", String(this._tokenExpiresAt)),
			model
				? this.storage.set("auth_model", JSON.stringify(model))
				: this.storage.remove("auth_model"),
			this.persistCollectionName(),
		]);
		this.notify();
	}

	/**
	 * Replace the cached auth model **without** touching the token, its recorded
	 * expiry, or the refresh token.
	 *
	 * Use this when a read refreshes the identity record (e.g. `me()`, or the
	 * server echoing the record back). Routing that through {@link set} would
	 * overwrite the access token's real `expiresIn` with the 7-day fallback TTL,
	 * so `isExpired` stays false long past the real 15-minute lifetime and the
	 * proactive refresh never fires — every request then pays a 401 + retry.
	 *
	 * @param model The authenticated user record, or null for superusers.
	 */
	setModel(model: AuthModel | null): void {
		this._model = model;

		// Mirrors `set`: derive the auth collection when the caller has not set it.
		if (!this._collectionName && model && typeof model.collectionName === "string") {
			this._collectionName = model.collectionName;
		}

		void Promise.all([
			model
				? this.storage.set("auth_model", JSON.stringify(model))
				: this.storage.remove("auth_model"),
			this.persistCollectionName(),
		]);
		this.notify();
	}

	/**
	 * Record a complete auth response: token, model, refresh token and the access
	 * token's real lifetime.
	 *
	 * `expiresIn` is seconds, the field the server's auth responses carry. Not passing
	 * it (an older server) falls back to the historical 7-day assumption.
	 *
	 * @param token The JWT access token.
	 * @param model The authenticated record, or null for a superuser.
	 * @param options `refreshToken` and `expiresIn` from the same response.
	 */
	setSession(
		token: string,
		model: AuthModel | null,
		options?: { refreshToken?: string; expiresIn?: number },
	): void {
		this.set(token, model);
		if (options?.refreshToken) {
			this._refreshToken = options.refreshToken;
			void this.storage.set("auth_refresh_token", options.refreshToken);
		}
		const expiresIn = options?.expiresIn;
		if (typeof expiresIn === "number" && expiresIn > 0) {
			this._tokenExpiresAt = Date.now() + expiresIn * 1000;
			void this.storage.set("auth_expires_at", String(this._tokenExpiresAt));
		}
	}

	/**
	 * Clear all auth state (token, model, expiry, refresh token, collection) and
	 * notify listeners.
	 */
	clear(): void {
		this._token = "";
		this._model = null;
		this._tokenExpiresAt = null;
		this._refreshToken = "";
		this._collectionName = null;
		void Promise.all([
			this.storage.remove("auth_token"),
			this.storage.remove("auth_expires_at"),
			this.storage.remove("auth_model"),
			this.storage.remove("auth_collection"),
			this.storage.remove("auth_refresh_token"),
		]);
		this.notify();
	}

	private persistCollectionName(): Promise<void> | void {
		return this._collectionName
			? this.storage.set("auth_collection", this._collectionName)
			: this.storage.remove("auth_collection");
	}
	/**
	 * Register a listener for auth state changes.
	 * @param fn Callback invoked with (model, token) on every change.
	 * @returns An unsubscribe function.
	 */
	onChange(fn: AuthListener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			fn(this._model, this._token);
		}
	}
}

/**
 * Record a server auth response (login, setup, OAuth2 exchange, refresh) in the store.
 *
 * Every auth response carries `refreshToken` and `expiresIn`; keeping both is what
 * lets a session outlive the access token. Call sites used to store only the token,
 * so the refresh token was dropped and the local expiry was the 7-day fallback — the
 * session was then used until the server refused it, with no way to refresh.
 */
export function rememberAuthResponse(
	store: AuthStore,
	data: Record<string, unknown> | null | undefined,
	model: AuthModel | null,
): void {
	if (!data || typeof data.token !== "string" || !data.token) return;
	store.setSession(data.token, model, {
		refreshToken:
			typeof data.refreshToken === "string" ? data.refreshToken : undefined,
		expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : undefined,
	});
}

// ── Memory-only storage (default, works everywhere) ─────
/** Default storage adapter using `localStorage` with graceful fallback. */
export const memoryStorage: StorageAdapter = {
	get(key: string) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// ignore
		}
	},
	remove(key: string) {
		try {
			localStorage.removeItem(key);
		} catch {
			// ignore
		}
	},
};
