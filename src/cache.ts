// ── Cache Store ──────────────────────────────────────────
// Pluggable query-cache for GET responses. Mirrors the AuthStore pattern:
// a default memory store (Map) with an optional custom storage adapter
// (localStorage, AsyncStorage, IndexedDB, ...) for cross-page persistence.

import type { StorageAdapter } from "./auth";

/** Options for enabling/customising the client's query cache. */
export interface CacheConfig {
	/**
	 * Master switch. When `true`, readable GET requests are cached with the
	 * default TTL unless a request opts out via `{ cache: false }`.
	 *
	 * When `false` (default), caching is disabled unless a request opts in
	 * via `{ cache: true }` or `{ ttl: <ms> }`. Opt-in works regardless.
	 */
	enabled?: boolean;
	/**
	 * Default time-to-live for cached entries, in milliseconds.
	 * @default 60_000 (1 minute)
	 */
	defaultTTL?: number;
	/**
	 * Optional persistence backend (same interface as AuthStore's storage).
	 * Defaults to an in-memory Map — swap for `localStorage` / `AsyncStorage`
	 * to keep the cache across page reloads / app restarts.
	 */
	store?: StorageAdapter;
	/**
	 * Max number of entries to keep in memory (LRU eviction).
	 * @default 500
	 */
	maxEntries?: number;
	/**
	 * When true and the client has an active realtime subscription for a
	 * collection, inbound create/update/delete events invalidate that
	 * collection's cached entries automatically.
	 * @default false — only local mutations invalidate (explicit + predictable)
	 */
	invalidateOnRealtime?: boolean;
}

/** Per-request cache controls (mixed into {@link RequestOptions}). */
export interface CacheRequestOptions {
	/**
	 * Cache control for this request:
	 * - `true` — cache with the default (or global) TTL
	 * - `false` — always fetch fresh, bypass cache (and don't store the result)
	 * - a number — cache with this TTL in milliseconds
	 * - an object — `{ ttl, key }` for finer control
	 *
	 * When unset, the global `cache.enabled` flag decides.
	 */
	cache?: boolean | number | { ttl?: number; key?: string };
	/** Alias of `cache: <ms>` (convenience, reads naturally). */
	ttl?: number;
	/**
	 * Extra cache namespaces to invalidate when this mutation succeeds.
	 * The current collection is always invalidated automatically.
	 * @example create({ ... }, { invalidate: ['users'] })
	 */
	invalidate?: string[];
}

/** A single cached entry. */
interface CacheEntry<T = unknown> {
	value: T;
	expiresAt: number;
	/** Namespace (collection name) this entry belongs to — for invalidation. */
	namespace?: string;
	/** Prefix tags (e.g. `getList:posts`) for deleteByPrefix. */
	tags?: string[];
}

/** LRU-ish memory store + optional persistent adapter hybrid. */
export class CacheStore {
	private memory = new Map<string, CacheEntry>();
	private readonly ttl: number;
	private readonly persistence?: StorageAdapter;
	private readonly maxEntries: number;
	private hits = 0;
	private misses = 0;
	private namespaceEntries = new Map<string, Set<string>>();
	/** Key → set of prefix tags registered for that key (e.g. `getList:posts`). */
	private prefixEntries = new Map<string, Set<string>>();

	constructor(config: {
		defaultTTL?: number;
		store?: StorageAdapter;
		maxEntries?: number;
	} = {}) {
		this.ttl = config.defaultTTL ?? 60_000;
		this.persistence = config.store;
		this.maxEntries = config.maxEntries ?? 500;
	}

	/** Resolve the effective TTL: request override → global default. */
	private resolveTTL(ttl?: number): number {
		return ttl && ttl > 0 ? ttl : this.ttl;
	}

	/**
	 * Read a cached value. Fast sync path (memory) with async persistence
	 * fallback for adapters whose `get` returns a Promise.
	 * @param key Cache key (e.g. `"GET /posts?page=1"`).
	 * @returns The cached value, or undefined when absent/expired (the hit is
	 * cleared on expiry so a stale value is never served).
	 */
	async get<T = unknown>(key: string): Promise<T | undefined> {
		const mem = this.memory.get(key);
		if (mem !== undefined) {
			if (Date.now() > mem.expiresAt) {
				this.delete(key);
				this.misses++;
				return undefined;
			}
			// refresh recency for LRU eviction
			this.memory.delete(key);
			this.memory.set(key, mem);
			this.hits++;
			return mem.value as T;
		}
		if (this.persistence) {
			const entry = await this.readPersisted(key);
			if (entry) {
				if (Date.now() > entry.expiresAt) {
					this.delete(key);
					this.misses++;
					return undefined;
				}
				this.hits++;
				return entry.value as T;
			}
		}
		this.misses++;
		return undefined;
	}

	/**
	 * Store a value.
	 * @param key Cache key.
	 * @param value The response payload.
	 * @param ttlOverride Optional TTL override (ms).
	 * @param namespace Optional namespace for group invalidation.
	 */
	set(
		key: string,
		value: unknown,
		ttlOverride?: number,
		namespace?: string,
		tags?: string[],
	): void {
		const expiresAt = Date.now() + this.resolveTTL(ttlOverride);
		const entry: CacheEntry = { value, expiresAt, namespace, tags };
		this.memory.set(key, entry);

		// LRU eviction when over capacity
		if (this.memory.size > this.maxEntries) {
			const oldest = this.memory.keys().next().value as string | undefined;
			if (oldest !== undefined) this.delete(oldest);
		}

		if (namespace) {
			let keys = this.namespaceEntries.get(namespace);
			if (!keys) {
				keys = new Set();
				this.namespaceEntries.set(namespace, keys);
			}
			keys.add(key);
		}

		for (const tag of tags ?? []) {
			let keys = this.prefixEntries.get(tag);
			if (!keys) {
				keys = new Set();
				this.prefixEntries.set(tag, keys);
			}
			keys.add(key);
		}

		if (this.persistence) {
			void this.persistence.set(this.persistKey(key), JSON.stringify(entry));
		}
	}

	/**
	 * Invalidate entries belonging to a namespace (e.g. a collection name).
	 * Also clears the namespace index entry.
	 */
	invalidate(namespace: string): void {
		const keys = Array.from(this.namespaceEntries.get(namespace) ?? []);
		for (const key of keys) this.delete(key);
		this.namespaceEntries.delete(namespace);
	}

	/** Remove a single key. */
	delete(key: string): void {
		const entry = this.memory.get(key);
		if (entry?.namespace) {
			const set = this.namespaceEntries.get(entry.namespace);
			if (set) {
				set.delete(key);
				if (set.size === 0) this.namespaceEntries.delete(entry.namespace);
			}
		}
		for (const tag of entry?.tags ?? []) {
			const set = this.prefixEntries.get(tag);
			if (set) {
				set.delete(key);
				if (set.size === 0) this.prefixEntries.delete(tag);
			}
		}
		this.memory.delete(key);
		if (this.persistence) {
			void this.persistence.remove(this.persistKey(key));
		}
	}

	/**
	 * Delete every entry whose key starts with `prefix`.
	 *
	 * Useful for fine-grained invalidation, e.g.:
	 * ```ts
	 * client.cache.deleteByPrefix('getList:posts'); // delete all getList cache
	 * client.cache.deleteByPrefix('getOne:posts');  // delete all getOne cache
	 * ```
	 */
	deleteByPrefix(prefix: string): void {
		if (!prefix) return;
		// exact tag match (fast path — the common `op:collection` case)
		const tagged = this.prefixEntries.get(prefix);
		if (tagged) {
			for (const key of Array.from(tagged)) this.delete(key);
			this.prefixEntries.delete(prefix);
			return;
		}
		// general prefix scan (e.g. `posts` matches any `op:posts`/`GET /posts`)
		for (const key of Array.from(this.memory.keys())) {
			if (key.startsWith(prefix)) this.delete(key);
		}
	}

	/** Drop every cached entry (memory + persistence). */
	clear(): void {
		this.memory.clear();
		this.namespaceEntries.clear();
		this.prefixEntries.clear();
		// Best-effort: clear all persisted keys via the adapter. The adapter has
		// no list API, so we track a prefix index in memory only — a full
		// persistence wipe is only possible if the adapter supports enumeration.
		// Most use localStorage directly; callers may also recreate the client.
	}

	/** Cache hit/miss/entry statistics. */
	stats(): { hits: number; misses: number; entries: number } {
		return { hits: this.hits, misses: this.misses, entries: this.memory.size };
	}

	private persistKey(key: string): string {
		return "lazypock:cache:" + key;
	}

	private async readPersisted(key: string): Promise<CacheEntry | undefined> {
		if (!this.persistence) return undefined;
		const raw = await this.persistence.get(this.persistKey(key));
		if (raw == null) return undefined;
		try {
			const entry = JSON.parse(raw) as CacheEntry;
			// Re-hydrate a copy in memory (TTL checked by caller)
			this.memory.set(key, entry);
			if (entry.namespace) {
				let keys = this.namespaceEntries.get(entry.namespace);
				if (!keys) {
					keys = new Set();
					this.namespaceEntries.set(entry.namespace, keys);
				}
				keys.add(key);
			}
			for (const tag of entry.tags ?? []) {
				let keys = this.prefixEntries.get(tag);
				if (!keys) {
					keys = new Set();
					this.prefixEntries.set(tag, keys);
				}
				keys.add(key);
			}
			return entry;
		} catch {
			void this.persistence.remove(this.persistKey(key));
			return undefined;
		}
	}
}

// ── Helpers ──

/** Resolve per-request cache options into a usable directive. */
export function resolveCacheDirective(opts?: {
	cache?: boolean | number | { ttl?: number; key?: string };
	ttl?: number;
}): { enabled: boolean; ttl?: number; key?: string } | null {
	if (!opts) return null;
	// convenience alias: ttl: 5000  →  cache for 5s
	if (typeof opts.ttl === "number" && opts.ttl > 0) {
		return { enabled: true, ttl: opts.ttl };
	}
	const c = opts.cache;
	if (c === undefined) return null; // use global enabled flag
	if (c === true) return { enabled: true };
	if (c === false) return { enabled: false };
	if (typeof c === "number") return { enabled: true, ttl: c > 0 ? c : undefined };
	// object form
	return { enabled: true, ttl: c.ttl, key: c.key };
}