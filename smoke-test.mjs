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
check(
	"password omitted from record interface",
	!source.includes('"password"?:') && !source.includes('"password": never'),
	true,
);
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
import { HttpClient, ApiError } from "./dist/index.js";

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

// ── getFullList single-flight dedup (issue #2) ──
// Concurrent identical getFullList() calls must not fire duplicate requests.
// Different options must remain distinct.

await (async () => {
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
	const store = {
		token: "",
		collectionName: null,
		isExpired: false,
		set() {},
		setCollectionName() {},
		clear() {},
	};

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

	// 2. select("*") + schema → visible fields (hidden excluded)
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c.collection("posts").select("*").getList(1, 20, { fetch: fetchMock });
		check(
			"select(*) + schema → fields=visible (hidden excluded)",
			lastUrl().includes("fields=title%2Cpublished%2Cauthor"),
			true,
		);
	}

	// 3. no select() + schema → same visible default
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c.collection("posts").getList(1, 20, { fetch: fetchMock });
		check(
			"no select() + schema → fields=visible by default",
			lastUrl().includes("fields=title%2Cpublished%2Cauthor"),
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
