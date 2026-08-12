// ── Smoke test for codegen + typed client ──────────────
// Run: npm run smoke  (node --test? no — plain script)
// Exercises:
//   1. generateTypes() output correctness (field mapping)
//   2. TypedClient.collection() generic resolution
//   3. Full round-trip: generated source → write → typecheck

import { generateTypes, collectionTypeName } from "./dist/index.js";
import { fieldTypeScriptType } from "./dist/index.js";

let failures = 0;
function check(name, actual, expected) {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(
		`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`}`,
	);
}

// ── 1. Field type mapping ──
check(
	"text → string",
	fieldTypeScriptType({ name: "t", type: "text" }),
	"string",
);
check(
	"number → number",
	fieldTypeScriptType({ name: "n", type: "number" }),
	"number",
);
check(
	"bool → boolean",
	fieldTypeScriptType({ name: "b", type: "bool" }),
	"boolean",
);
check(
	"select → union",
	fieldTypeScriptType({
		name: "s",
		type: "select",
		options: { values: ["draft", "published"] },
	}),
	'"draft" | "published"',
);
check(
	"multi_select → union[]",
	fieldTypeScriptType({
		name: "m",
		type: "multi_select",
		options: { values: ["a", "b"] },
	}),
	'("a" | "b")[]',
);
check(
	"relation single → string",
	fieldTypeScriptType({
		name: "r",
		type: "relation",
		options: { collection: "users", maxSelect: 1 },
	}),
	"string",
);
check(
	"relation multi → string[]",
	fieldTypeScriptType({
		name: "r",
		type: "relation",
		options: { collection: "users", maxSelect: 5 },
	}),
	"string[]",
);
check(
	"file → string",
	fieldTypeScriptType({ name: "f", type: "file" }),
	"string",
);
check(
	"multi_file → string[]",
	fieldTypeScriptType({ name: "f", type: "multi_file" }),
	"string[]",
);
check(
	"json → Record",
	fieldTypeScriptType({ name: "j", type: "json" }),
	"Record<string, unknown>",
);
check(
	"geo → Record",
	fieldTypeScriptType({ name: "g", type: "geo" }),
	"Record<string, unknown>",
);
check(
	"password → never",
	fieldTypeScriptType({ name: "p", type: "password" }),
	"never",
);

// ── 2. Identifier sanitization ──
check("collectionTypeName users → Users", collectionTypeName("users"), "Users");
check(
	"collectionTypeName blog-posts → BlogPosts",
	collectionTypeName("blog-posts"),
	"BlogPosts",
);
check("collectionTypeName 2fa → _2fa", collectionTypeName("2fa"), "_2fa");

// ── 3. generateTypes() output ──
const mockCollections = [
	{
		name: "users",
		type: "auth",
		fields: [
			{ name: "email", type: "email", required: true },
			{ name: "verified", type: "bool" },
			{
				name: "role",
				type: "select",
				options: { values: ["admin", "member"] },
			},
			{ name: "password", type: "password" },
		],
	},
	{
		name: "blog_posts",
		type: "base",
		fields: [
			{ name: "title", type: "text", required: true },
			{ name: "published", type: "bool" },
			{
				name: "author",
				type: "relation",
				options: { collection: "users", maxSelect: 1 },
			},
			{ name: "tags", type: "multi_select", options: { values: ["ts", "js"] } },
			{ name: "views", type: "number" },
		],
	},
];

const source = generateTypes(mockCollections, { packageName: "lazypock" });

check(
	"output has UsersRecord",
	source.includes("export interface UsersRecord"),
	true,
);
check(
	"output has BlogPostsRecord",
	source.includes("export interface BlogPostsRecord"),
	true,
);
check("password omitted from record", !source.includes("password"), true);
check("select union in output", source.includes('"admin" | "member"'), true);
check("relation→string", source.includes('"author"?: string;'), true);
check("multi_select→array", source.includes('"tags"?: ("ts" | "js")[];'), true);
check("required field no ?", source.includes('"title": string;'), true);
check("optional bool has ?", source.includes('"published"?: boolean;'), true);
check(
	"LazypockCollections map",
	source.includes('"blog_posts": BlogPostsRecord;'),
	true,
);
check(
	"createClient factory",
	source.includes("export function createClient"),
	true,
);
check("TypedClient class", source.includes("export class TypedClient"), true);
check(
	"auth intersects AuthRecord",
	source.includes('"users": UsersRecord & AuthRecord;'),
	true,
);

// ── Realtime wiring (PocketBase-style) ──
import { LazypockClient, RealtimeService, getScaleUrl } from "./dist/index.js";
import { HttpClient, ApiError, CacheStore } from "./dist/index.js";

// Stub WebSocket so subscribe() doesn't hit the network.
globalThis.WebSocket = class {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = 1;
	onopen = null;
	onmessage = null;
	onclose = null;
	onerror = null;
	constructor() {}
	send() {}
	close() {}
};

(() => {
	const client = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
	const svc = client.collection("posts");

	check("collection.subscribe is a function", typeof svc.subscribe, "function");
	check(
		"collection.unsubscribe is a function",
		typeof svc.unsubscribe,
		"function",
	);
	check("collection.getList is a function", typeof svc.getList, "function");
	check(
		"collection.getFullList is a function",
		typeof svc.getFullList,
		"function",
	);
	check(
		"collection.getFirstListItem is a function",
		typeof svc.getFirstListItem,
		"function",
	);
	check("collection.getOne is a function", typeof svc.getOne, "function");
	check("collection.create is a function", typeof svc.create, "function");
	check("collection.update is a function", typeof svc.update, "function");
	check("collection.delete is a function", typeof svc.delete, "function");

	const unsub = svc.subscribe((e) => e);
	check("subscribe returns a function", typeof unsub, "function");
	unsub();

	check(
		"client.realtime is a RealtimeService",
		client.realtime instanceof RealtimeService,
		true,
	);

	// Registry channel — PocketBase-style pb.collections.subscribe()
	const reg = client.collections;
	check(
		"client.collections.subscribe is a function",
		typeof reg.subscribe,
		"function",
	);
	check(
		"client.collections.unsubscribe is a function",
		typeof reg.unsubscribe,
		"function",
	);
	check(
		"client.collections.getFullList is a function",
		typeof reg.getFullList,
		"function",
	);
	check(
		"client.collections.getList is a function",
		typeof reg.getList,
		"function",
	);
	check(
		"client.collections.getOne is a function",
		typeof reg.getOne,
		"function",
	);
	check(
		"client.collections.create is a function",
		typeof reg.create,
		"function",
	);
	check(
		"client.collections.update is a function",
		typeof reg.update,
		"function",
	);
	check(
		"client.collections.delete is a function",
		typeof reg.delete,
		"function",
	);
	const unsubReg = reg.subscribe((e) => e);
	check(
		"collections.subscribe returns a function",
		typeof unsubReg,
		"function",
	);
	unsubReg();

	check(
		"getScaleUrl builds a scale URL",
		getScaleUrl("/api", "abc-123", "100x100"),
		"/api/files/abc-123/scale/100x100",
	);
})();

// ── Auto-cancellation tests ──
// Exercise the PocketBase-style autoCancel behaviour with a fake fetch:
// duplicated pending requests cancel each other; only the last executes.

await (async () => {
	const store = {
		token: "",
		collectionName: null,
		isExpired: false,
		set() {},
		setCollectionName() {},
		clear() {},
	};

	// controllable fetch: requests stay pending until explicitly settled
	function controllableFetch(pool) {
		return (url, init) =>
			new Promise((resolve, reject) => {
				const d = { url, init, resolve, reject };
				pool.push(d);
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("Aborted", "AbortError")),
				);
			});
	}
	const ok200 = {
		ok: true,
		status: 200,
		text: async () => JSON.stringify({ ok: true }),
	};

	check("HttpClient exported", typeof HttpClient, "function");
	check(
		"ApiError.isAbort defaults to false",
		new ApiError("x", {}, 0).isAbort,
		false,
	);

	// ── 1. duplicate GETs: only the last executes ──
	{
		const h = new HttpClient("http://x/api", store);
		const pool = [];
		const req1 = h.request("GET", "/posts", undefined, {
			fetch: controllableFetch(pool),
		});
		const req2 = h.request("GET", "/posts", undefined, {
			fetch: controllableFetch(pool),
		});
		pool[1].resolve(ok200); // settle the winner
		const r2 = await req2;
		check("second duplicate executes", r2?.ok, true);
		let firstErr = null;
		try {
			await req1;
		} catch (e) {
			firstErr = e;
		}
		check(
			"first duplicate auto-cancelled (ApiError)",
			firstErr instanceof ApiError,
			true,
		);
		check("first duplicate isAbort === true", firstErr?.isAbort, true);
	}

	// ── 2. requestKey override groups requests across paths ──
	{
		const h = new HttpClient("http://x/api", store);
		const pool = [];
		const a = h.request("GET", "/a", undefined, {
			fetch: controllableFetch(pool),
			requestKey: "same",
		});
		const b = h.request("GET", "/b", undefined, {
			fetch: controllableFetch(pool),
			requestKey: "same",
		});
		pool[1].resolve(ok200);
		await b;
		let aborted2 = false;
		try {
			await a;
		} catch (e) {
			aborted2 = e?.isAbort === true;
		}
		check("requestKey groups different paths", aborted2, true);
	}

	// ── 3. requestKey: null disables auto-cancel ──
	{
		const h = new HttpClient("http://x/api", store);
		const pool = [];
		const a = h.request("GET", "/same", undefined, {
			fetch: controllableFetch(pool),
			requestKey: null,
		});
		const b = h.request("GET", "/same", undefined, {
			fetch: controllableFetch(pool),
			requestKey: null,
		});
		pool[0].resolve(ok200);
		pool[1].resolve(ok200);
		const ra = await a;
		const rb = await b;
		check(
			"requestKey null keeps both",
			ra?.ok === true && rb?.ok === true,
			true,
		);
	}

	// ── 4. cancelAllRequests aborts in-flight ──
	{
		const h = new HttpClient("http://x/api", store);
		const pool = [];
		const p = h.request("GET", "/pending", undefined, {
			fetch: controllableFetch(pool),
		});
		h.cancelAllRequests();
		let err = null;
		try {
			await p;
		} catch (e) {
			err = e;
		}
		check("cancelAllRequests aborts", err?.isAbort, true);
	}

	// ── 5. autoCancellation(false) disables globally ──
	{
		const h = new HttpClient("http://x/api", store);
		h.autoCancellation(false);
		const pool = [];
		const a = h.request("GET", "/p", undefined, {
			fetch: controllableFetch(pool),
		});
		const b = h.request("GET", "/p", undefined, {
			fetch: controllableFetch(pool),
		});
		pool[0].resolve(ok200);
		pool[1].resolve(ok200);
		const ra = await a;
		const rb = await b;
		check(
			"autoCancellation(false) keeps both",
			ra?.ok === true && rb?.ok === true,
			true,
		);
	}
})();

// ── Query cache tests ──
// Exercise the opt-in CacheStore: enabled flag, per-request overrides,
// TTL expiry, mutation invalidation, auth-token scoping, persistence.

await (async () => {
	const store = {
		token: "",
		collectionName: null,
		isExpired: false,
		set() {},
		setCollectionName() {},
		clear() {},
	};

	// fetch mock that counts calls per URL
	const counters = new Map();
	const fetchMock = async (url) => {
		counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					items: [{ id: "1", n: String(counters.get(String(url))) }],
					page: 1,
					perPage: 30,
					totalItems: 1,
					totalPages: 1,
				}),
		};
	};
	const callCount = (url) => counters.get(url) ?? 0;

	// ── 1. disabled by default → no store, no caching ──
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		check("cache disabled: cacheStats is null", c.cacheStats(), null);
	}

	// ── 2. enabled via options + per-request override ──
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true, defaultTTL: 60_000 },
		});
		const counters = new Map();
		const fetchMock = async (url) => {
			counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						items: [{
							id: "1",
							n: String(counters.get(String(url))),
						}],
						page: 1,
						perPage: 30,
						totalItems: 1,
						totalPages: 1,
					}),
			};
		};
		const callCount = (url) => counters.get(url) ?? 0;
		const url = "http://x/api/posts?page=1&perPage=20";
		// first GET stores; second GET hits cache → fetch called once
		const p1 = await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		const p2 = await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		check("cache enabled: second getList is cache hit", callCount(url), 1);
		check("cache stats entries", c.cacheStats()?.entries, 1);
		check("cached value returned", p2?.items?.[0]?.n, "1");

		// ── per-request opt-out ──
		const p3 = await c.collection("posts").getList(1, 20, {
			fetch: fetchMock,
			cache: false,
		});
		check("cache:false bypasses (fetch called again)", callCount(url), 2);
		check("cache:false returns fresh", p3?.items?.[0]?.n, "2");

		// ── per-request TTL: number = cache-for-N-ms ──
		// Use a fresh URL so no prior entry exists.
		const ttlUrl = "http://x/api/posts?page=1&perPage=20&ttlTest=1";
		const p4 = await c.collection("posts").getList(1, 20, {
			fetch: fetchMock,
			params: { ttlTest: "1" },
			ttl: 1, // 1ms — expires before next read
		});
		check("ttl:1 stores (fresh key)", c.cacheStats()?.entries, 2);
		check("ttl:1 fetched once", callCount(ttlUrl), 1);
		await new Promise((r) => setTimeout(r, 5)); // let the 1ms TTL lapse
		const p5 = await c.collection("posts").getList(1, 20, {
			fetch: fetchMock,
			params: { ttlTest: "1" },
			ttl: 1,
		});
		// expired → must re-fetch
		check("expired ttl re-fetches", callCount(ttlUrl), 2);
	}

	// ── 3. mutation invalidation ──
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true },
		});
		const counters = new Map();
		const fetchMock = async (url) => {
			counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
			return {
				ok: true,
				status: 200,
				text: async () =>
					JSON.stringify({
						items: [{ id: "1", n: "1" }],
						page: 1,
						perPage: 30,
						totalItems: 1,
						totalPages: 1,
					}),
			};
		};
		const callCount = (url) => counters.get(url) ?? 0;
		await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		const url = "http://x/api/posts?page=1&perPage=20";
		check("mutate block: cached", callCount(url), 1);
		// create → invalidates posts namespace
		await c.collection("posts").create({ title: "New" }, { fetch: fetchMock });
		const after = await c.collection("posts").getList(1, 20, {
			fetch: fetchMock,
		});
		check(
			"create invalidates list cache (re-fetched)",
			callCount(url),
			2,
		);
		// users namespace untouched
		await c.collection("users").getList(1, 20, { fetch: fetchMock });
		const uUrl = "http://x/api/users?page=1&perPage=20";
		check("users cached", callCount(uUrl), 1);
		// posts.create with invalidate: ['users'] → users also cleared
		await c.collection("posts").create(
			{ title: "N2" },
			{ fetch: fetchMock, invalidate: ["users"] },
		);
		await c.collection("users").getList(1, 20, { fetch: fetchMock });
		check("explicit invalidate clears users too", callCount(uUrl), 2);
	}

	// ── 4. auth-token scoping ──
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true },
		});
		const url = "http://x/api/private?page=1&perPage=20";
		await c.collection("private").getList(1, 20, { fetch: fetchMock });
		c.authStore.set("token-A", null);
		await c.collection("private").getList(1, 20, { fetch: fetchMock });
		check("different token → separate cache (re-fetch)", callCount(url), 2);
		await c.collection("private").getList(1, 20, { fetch: fetchMock });
		check("same token → cache hit", callCount(url), 2);
	}

	// ── 5. persistence via StorageAdapter ──
	{
		const mem = new Map();
		const persistent = {
			get: (k) => mem.get(k) ?? null,
			set: (k, v) => void mem.set(k, v),
			remove: (k) => void mem.delete(k),
		};
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true, store: persistent },
		});
		await c.collection("persist").getList(1, 20, { fetch: fetchMock });
		const url = "http://x/api/persist?page=1&perPage=20";
		check("persisted: entry stored", [...mem.keys()].length, 1);
		// new client, same store → hydration works
		const c2 = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true, store: persistent },
		});
		await c2.collection("persist").getList(1, 20, { fetch: fetchMock });
		check("persisted: hydrated across clients (no fetch)", callCount(url), 1);
	}

	// ── 6. deleteByPrefix (getList: vs getOne: granular invalidation) ──
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			cache: { enabled: true },
		});
		const listUrl = "http://x/api/pfix?page=1&perPage=20";
		const oneUrl = "http://x/api/pfix/abc";
		await c.collection("pfix").getList(1, 20, { fetch: fetchMock });
		await c.collection("pfix").getOne("abc", { fetch: fetchMock });
		check("deleteByPrefix section: both cached", callCount(listUrl), 1);
		check("deleteByPrefix section: one cached", callCount(oneUrl), 1);

		// delete all getList cache for the collection (getOne untouched)
		c.cache.deleteByPrefix("getList:pfix");
		await c.collection("pfix").getList(1, 20, { fetch: fetchMock });
		await c.collection("pfix").getOne("abc", { fetch: fetchMock });
		check("deleteByPrefix getList:pfix → re-fetched", callCount(listUrl), 2);
		check("deleteByPrefix getList:pfix → getOne still cached", callCount(oneUrl), 1);

		// delete all getOne cache (now getList cached again)
		c.cache.deleteByPrefix("getOne:pfix");
		await c.collection("pfix").getList(1, 20, { fetch: fetchMock });
		await c.collection("pfix").getOne("abc", { fetch: fetchMock });
		check("deleteByPrefix getOne:pfix → getList still cached", callCount(listUrl), 2);
		check("deleteByPrefix getOne:pfix → getOne re-fetched", callCount(oneUrl), 2);

		// bare prefix (any op) — `getList`/`getOne` tags both match `pfix`
		// via the general scan, but let's assert a stray prefix clears nothing
		c.cache.deleteByPrefix("posts") /* no-op: matches nothing cached */;
		await c.collection("pfix").getList(1, 20, { fetch: fetchMock });
		await c.collection("pfix").getOne("abc", { fetch: fetchMock });
		check("deleteByPrefix posts (no-op) → no invalidation", callCount(listUrl), 2);
		check("deleteByPrefix posts (no-op) → still cached", callCount(oneUrl), 2);
	}
})();

// ── Realtime-driven cache invalidation ──
// When `invalidateCacheOnRealtime(collection)` is active, an inbound
// create/update/delete event clears that collection's cached entries.

await (async () => {
	const store = {
		token: "",
		collectionName: null,
		isExpired: false,
		set() {},
		setCollectionName() {},
		clear() {},
	};
	const counters = new Map();
	const fetchMock = async (url) => {
		counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					items: [{ id: "1" }],
					page: 1,
					perPage: 30,
					totalItems: 1,
					totalPages: 1,
				}),
		};
	};
	const callCount = (url) => counters.get(url) ?? 0;
	const c = new LazypockClient({ baseUrl: "http://x/api", cache: { enabled: true } });
	const url = "http://x/api/posts?page=1&perPage=20";
	await c.collection("posts").getList(1, 20, { fetch: fetchMock });
	check("realtime block: cached first", callCount(url), 1);

	// enable realtime invalidation, then simulate an inbound update event
	const unsub = c.invalidateCacheOnRealtime("posts");
	check("invalidateCacheOnRealtime returns unsub", typeof unsub, "function");

	// fire the collection's realtime handler directly via the RealtimeService
	const { RealtimeService } = await import("./dist/index.js");
	const rt = c.realtime;
	if (rt instanceof RealtimeService) {
		// the subscribe handler is registered; relay a fake event through
		// the service's internal handler via a public channel — easiest is to
		// call the subscribed callback through the emit path: we re-create the
		// same payload the collection handler normalizes.
		const subs = rt["subscriptions"];
		const topic = "collection:posts";
		const callbacks = subs?.get(topic) ?? [];
		for (const s of callbacks) {
			s.callback({
				event: "record_change",
				topic,
				payload: { action: "update", record: { id: "1" } },
			});
		}
	}

	// after the realtime event, the cached list should be invalidated
	await c.collection("posts").getList(1, 20, { fetch: fetchMock });
	check(
		"realtime event invalidates list cache (re-fetched)",
		callCount(url),
		2,
	);
	unsub();
})();

console.log(
	failures === 0 ? "\n✅ All smoke tests passed" : `\n❌ ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
