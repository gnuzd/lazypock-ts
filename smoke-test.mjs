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
			{
				name: "password_hash",
				type: "password",
				system: true,
				hidden: true,
			},
			{ name: "verified", type: "bool", required: true, system: true },
			{
				name: "emailVisibility",
				type: "bool",
				required: true,
				system: true,
				options: { defaultValue: true },
			},
			{
				name: "role",
				type: "select",
				options: { values: ["admin", "member"] },
			},
			{ name: "password", type: "password", hidden: true },
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
const usersRecordBlock =
	source.match(/export interface UsersRecord\b[\s\S]*?\n}/)?.[0] ?? "";
check(
	"password omitted from record interface (read model)",
	!usersRecordBlock.includes("password"),
	true,
);
check(
	"password writable in create data even when hidden (write-only)",
	source.includes('"password"?: string;'),
	true,
);
check(
	"password optional in create data (accounts may exist without one)",
	source.includes('"password"?: string;'),
	true,
);
check(
	"password_hash kept as backward-compat alias in create data",
	source.includes('"password_hash"?: string;'),
	true,
);
check(
	"create data interface generated",
	source.includes("export interface UsersCreateData"),
	true,
);
check(
	"base collection create data generated",
	source.includes("export interface BlogPostsCreateData"),
	true,
);
check(
	"create data map generated",
	source.includes('"users": UsersCreateData;'),
	true,
);
check(
	"typed collection binds create data",
	source.includes(
		"CollectionService<LazypockCollections[K], LazypockCreateData[K]>",
	),
	true,
);
check(
	"collection names suggested and dynamic names accepted",
	source.includes(
		"override collection<K extends keyof LazypockCollections | (string & {})>",
	),
	true,
);
check("select union in output", source.includes('"admin" | "member"'), true);
check("relation→string", source.includes('"author"?: string;'), true);
check("multi_select→array", source.includes('"tags"?: ("ts" | "js")[];'), true);
check("required field no ?", source.includes('"title": string;'), true);
check("optional bool has ?", source.includes('"published"?: boolean;'), true);
check("email required in create data", source.includes('"email": string;'), true);
check(
	"verified optional in create data (server default false)",
	source.includes('"verified"?: boolean;'),
	true,
);
check(
	"emailVisibility optional in create data (defaultValue true)",
	source.includes('"emailVisibility"?: boolean;'),
	true,
);
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
import { HttpClient, ApiError } from "./dist/index.js";

// Stub WebSocket so subscribe() doesn't hit the network.
// Captures created sockets, their URLs (token assertions) and outbound
// messages (join payload assertions) into `wsLog`.
const wsLog = { urls: [], sends: [], instances: [] };
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
	constructor(url) {
		wsLog.urls.push(url);
		wsLog.instances.push(this);
	}
	send(data) {
		wsLog.sends.push(
			typeof data === "string"
				? (() => {
						try {
							return JSON.parse(data);
						} catch {
							return data;
						}
				  })()
				: data,
		);
	}
	close() {
		this.readyState = 3;
	}
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

	// ── PocketBase-style subscribe arg forms ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		const s = c.collection("posts");
		wsLog.sends = [];
		const joins = () => wsLog.sends.filter((m) => m.event === "phx_join");

		const offStar = s.subscribe("*", (e) => e);
		check(
			"subscribe('*', cb) joins the wildcard topic",
			joins().at(-1)?.topic,
			"collection:posts",
		);

		const offRec = s.subscribe("abc-123", (e) => e);
		check(
			"subscribe('id', cb) joins the record topic",
			joins().at(-1)?.topic,
			"collection:posts:abc-123",
		);

		const offCb = s.subscribe((e) => e);
		check(
			"subscribe(cb) joins the wildcard topic",
			joins().at(-1)?.topic,
			"collection:posts",
		);

		const offLegacy = s.subscribe((e) => e, "legacy-id");
		check(
			"legacy subscribe(cb, id) joins the record topic",
			joins().at(-1)?.topic,
			"collection:posts:legacy-id",
		);

		offStar();
		offRec();
		offCb();
		offLegacy();
	}

	// ── subscribe options are forwarded to the join payload ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		wsLog.sends = [];
		c.collection("posts").subscribe("*", (e) => e, {
			expand: "author",
			headers: { "X-Custom": "1" },
			customKey: 42,
		});
		const join = wsLog.sends.filter((m) => m.event === "phx_join").at(-1);
		check(
			"join payload carries expand",
			join?.payload?.expand,
			"author",
		);
		check("join payload carries custom keys", join?.payload?.customKey, 42);
		check(
			"join payload strips HTTP headers",
			join?.payload?.headers,
			undefined,
		);
	}

	// ── subscribe delivers the full record regardless of select() ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		// Projected service: select() must NOT leak into subscriptions.
		const s = c.collection("posts").select("id", "title");
		let received = null;
		const off = s.subscribe((e) => (received = e));
		const fullRecord = {
			id: "1",
			title: "x",
			secret_field: "hidden",
			author: "u1",
		};
		wsLog.instances
			.at(-1)
			.onmessage?.({
				data: JSON.stringify({
					topic: "collection:posts",
					event: "record_change",
					payload: { action: "create", record: fullRecord },
				}),
			});
		check(
			"subscribe delivers all fields (no select projection)",
			JSON.stringify(received?.record),
			JSON.stringify(fullRecord),
		);
		off();
	}

	// ── unsubscribe variants ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		const s = c.collection("posts");
		const got = [];
		s.subscribe((e) => got.push(e));
		s.subscribe("rec-1", (e) => got.push(e));
		s.subscribe("rec-2", (e) => got.push(e));
		const ws = wsLog.instances.at(-1);
		const fire = (topic) =>
			ws.onmessage?.({
				data: JSON.stringify({
					topic,
					event: "record_change",
					payload: { action: "update", record: { id: "x" } },
				}),
			});

		fire("collection:posts");
		check("wildcard sub receives events", got.length, 1);

		s.unsubscribe("*");
		fire("collection:posts");
		check("unsubscribe('*') stops wildcard events", got.length, 1);

		fire("collection:posts:rec-1");
		check("record sub still receives events", got.length, 2);

		s.unsubscribe("rec-1");
		fire("collection:posts:rec-1");
		check("unsubscribe('rec-1') stops that record's events", got.length, 2);

		fire("collection:posts:rec-2");
		check("other record sub unaffected", got.length, 3);

		s.unsubscribe();
		fire("collection:posts:rec-2");
		check("unsubscribe() removes all remaining subs", got.length, 3);
	}

	// ── auth token is attached to the realtime socket ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		c.authStore.set("jwt-token-123", null);
		wsLog.urls = [];
		c.collection("posts").subscribe((e) => e);
		check(
			"socket URL carries the auth token",
			wsLog.urls.some((u) => u.includes("token=jwt-token-123")),
			true,
		);
	}

	// ── auth change reconnects the socket with the new token ──
	{
		const c = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
		c.collection("posts").subscribe((e) => e); // open socket, no token
		wsLog.urls = [];
		wsLog.sends = [];
		c.authStore.set("token-after-login", null); // triggers refresh()
		check(
			"auth change reconnects (new socket opened)",
			wsLog.urls.length,
			1,
		);
		check(
			"reconnected socket URL carries the token",
			wsLog.urls[0]?.includes("token=token-after-login"),
			true,
		);
		wsLog.instances.at(-1)?.onopen?.();
		const joins = wsLog.sends.filter((m) => m.event === "phx_join");
		check(
			"topics are re-joined after reconnect",
			joins.some((m) => m.topic === "collection:posts"),
			true,
		);
	}
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

	// ── 1b. abort landing during body read must throw, not return {} ──
	{
		const h = new HttpClient("http://x/api", store);
		// Response whose headers arrived but the body read is aborted
		// (auto-cancel fires mid-stream). Must reject as an abort error —
		// silently resolving {} would make list callers clear their rows.
		const abortedBodyFetch = async (_url, init) => {
			const response = {
				ok: true,
				status: 200,
				text: async () => {
					throw new DOMException("Aborted", "AbortError");
				},
			};
			init.signal?.addEventListener("abort", () => {});
			return response;
		};
		try {
			await h.request("GET", "/posts", undefined, {
				fetch: abortedBodyFetch,
				requestKey: null,
			});
			check("mid-body abort throws (not silent {})", false, true);
		} catch (e) {
			check("mid-body abort throws (not silent {})", true, true);
			check("mid-body abort is isAbort", e?.isAbort, true);
		}
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

// ── getFullList single-flight dedup (issue #2) ──
// Concurrent identical getFullList() calls must not fire duplicate requests.
// Different options must remain distinct.

await (async () => {
	const counters = new Map();
	const fetchMock = async (url, init) => {
		const signal = init?.signal;
		counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
		await new Promise((resolve, reject) => {
			if (signal?.aborted)
				return reject(new DOMException("Aborted", "AbortError"));
			signal?.addEventListener(
				"abort",
				() => reject(new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			setTimeout(resolve, 30);
		});
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					items: [{ id: "1" }, { id: "2" }],
					page: 1,
					perPage: 1000,
					totalItems: 2,
					totalPages: 1,
				}),
		};
	};
	const callCount = (url) => counters.get(url) ?? 0;
	const c = new LazypockClient({ baseUrl: "http://x/api" });

	// concurrent identical calls → 1 request, both resolve
	const url = "http://x/api/posts?page=1&perPage=1000";
	const [a, b] = await Promise.allSettled([
		c.collection("posts").getFullList({ fetch: fetchMock }),
		c.collection("posts").getFullList({ fetch: fetchMock }),
	]);
	check("getFullList dedup: 1 request for concurrent calls", callCount(url), 1);
	check("getFullList dedup: first resolves", a.status, "fulfilled");
	check("getFullList dedup: second resolves", b.status, "fulfilled");
	check("getFullList dedup: same data", a.value?.length, 2);

	// different options → still distinct requests
	const c2 = new LazypockClient({ baseUrl: "http://x/api" });
	counters.clear();
	const [x, y] = await Promise.allSettled([
		c2.collection("posts").getFullList({ fetch: fetchMock, sort: "title" }),
		c2.collection("posts").getFullList({ fetch: fetchMock, sort: "-title" }),
	]);
	check("getFullList dedup: different sort → 2 requests", counters.size, 2);
	check("getFullList dedup: both resolve", x.status, "fulfilled");
	check("getFullList dedup: second sort resolves", y.status, "fulfilled");

	// multi-page pagination still works end-to-end
	const pages = [
		[{ id: "1" }, { id: "2" }],
		[{ id: "3" }, { id: "4" }],
	];
	const pageFetch = async (url, init) => {
		const signal = init?.signal;
		counters.set(String(url), (counters.get(String(url)) ?? 0) + 1);
		await new Promise((resolve, reject) => {
			if (signal?.aborted)
				return reject(new DOMException("Aborted", "AbortError"));
			signal?.addEventListener(
				"abort",
				() => reject(new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			setTimeout(resolve, 10);
		});
		const m = String(url).match(/page=(\d+)/);
		const page = m ? Number(m[1]) : 1;
		const items = pages[page - 1] ?? [];
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					items,
					page,
					perPage: 1000,
					totalItems: 4,
					totalPages: 2,
				}),
		};
	};
	const c3 = new LazypockClient({ baseUrl: "http://x/api" });
	const multi = await c3.collection("multi").getFullList({ fetch: pageFetch });
	check("getFullList dedup: multi-page returns 4 items", multi?.length, 4);
	const pageReqs = [...counters.keys()].filter((k) => k.includes("/multi?")).length;
	check("getFullList dedup: multi-page = 2 page requests", pageReqs, 2);
})();

// ── select() field projection + schema-driven fields ──
// select(...fields) sends a `fields` param; without a select() call (or
// select("*")) all non-hidden fields are requested when a schema is known.

await (async () => {
	// schema with a hidden field + a relation field
	const postsSchema = {
		name: "posts",
		type: "base",
		fields: [
			{ name: "title", type: "text", required: true },
			{ name: "published", type: "bool" },
			{ name: "secret_note", type: "text", hidden: true },
			{ name: "author", type: "relation", options: { collection: "users" } },
		],
	};

	const urls = [];
	const fetchMock = async (url) => {
		urls.push(String(url));
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
	const lastUrl = () => urls[urls.length - 1];

	// 1. select("id", "title") → fields=id,title
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c
			.collection("posts")
			.select("id", "title")
			.getList(1, 20, { fetch: fetchMock });
		check("select() adds fields=id,title", lastUrl().includes("fields=id%2Ctitle"), true);
	}

	// 2. select("*") + schema → system keys + visible fields (hidden excluded)
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c.collection("posts").select("*").getList(1, 20, { fetch: fetchMock });
		check(
			"select(*) + schema → fields=id,created,updated,… + visible (hidden excluded)",
			lastUrl().includes(
				"fields=id%2Ccreated%2Cupdated%2CcollectionId%2CcollectionName%2Ctitle%2Cpublished%2Cauthor",
			),
			true,
		);
	}

	// 3. no select() + schema → same default (system keys + visible fields)
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		check(
			"no select() + schema → fields=id,created,updated,… + visible by default",
			lastUrl().includes(
				"fields=id%2Ccreated%2Cupdated%2CcollectionId%2CcollectionName%2Ctitle%2Cpublished%2Cauthor",
			),
			true,
		);
	}

	// 4. no schema → no fields param
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		check("no schema → no fields param", !lastUrl().includes("fields="), true);
	}

	// 5. explicit options.fields overrides the select() preset
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c
			.collection("posts")
			.select("id", "title")
			.getList(1, 20, { fetch: fetchMock, fields: "title" });
		check("options.fields overrides select()", lastUrl().includes("fields=title"), true);
	}

	// 6. getOne applies the preset too
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c
			.collection("posts")
			.select("id", "title")
			.getOne("abc", { fetch: fetchMock });
		check("select() applies to getOne", lastUrl().includes("fields=id%2Ctitle"), true);
	}

	// 7. select() returns a derived service — the original is untouched
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		const svc = c.collection("posts");
		const projected = svc.select("title");
		await svc.getList(1, 20, { fetch: fetchMock });
		check("original service unaffected by select()", !lastUrl().includes("fields="), true);
		await projected.getList(1, 20, { fetch: fetchMock });
		check("derived service sends fields=title", lastUrl().includes("fields=title"), true);
	}

	// 8. expand validation warns on non-relation fields (schema known)
	{
		const warns = [];
		const origWarn = console.warn;
		console.warn = (...a) => warns.push(a.join(" "));
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: "title" });
		console.warn = origWarn;
		check(
			"expand(non-relation) warns when schema known",
			warns.some((w) => w.includes("expand(\"title\")") && w.includes("not a relation")),
			true,
		);
	}
})();

console.log(
	failures === 0 ? "\n✅ All smoke tests passed" : `\n❌ ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
