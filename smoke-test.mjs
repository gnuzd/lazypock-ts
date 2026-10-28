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
check(
	"autodate → string",
	fieldTypeScriptType({ name: "created_at", type: "autodate" }),
	"string",
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
			{
				name: "reviewer",
				type: "relation",
				hidden: true,
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
		"CollectionService<\n        LazypockCollections[K],\n        LazypockCreateData[K],",
	),
	true,
);
check(
	"typed collection binds query fields (filter/sort/expand/select)",
	source.includes(
		"LazypockCreateData[K],\n        LazypockQueryFields[K],\n        LazypockExpandMaps[K]\n      >",
	),
	true,
);
check(
	"expand map generated per collection",
	source.includes("export interface BlogPostsExpandMap") &&
		source.includes("export interface UsersExpandMap"),
	true,
);
const blogExpandBlock =
	source.match(/export interface BlogPostsExpandMap\b[\s\S]*?\n}/)?.[0] ?? "";
check(
	"expand map resolves relation targets (name + id lookup)",
	blogExpandBlock.includes('"author": UsersRecord & AuthRecord;') &&
		blogExpandBlock.includes('"reviewer": UsersRecord & AuthRecord;'), // hidden relation too
	true,
);
check(
	"expand map excludes non-relations",
	!blogExpandBlock.includes('"tags"') && !blogExpandBlock.includes('"title"'),
	true,
);
check(
	"expand maps bound to the client",
	source.includes("LazypockExpandMaps[K]") &&
		source.includes('"blog_posts": BlogPostsExpandMap;'),
	true,
);
check(
	"collection names suggested and dynamic names accepted",
	source.includes(
		"override collection<K extends keyof LazypockCollections | (string & {})>",
	),
	true,
);
check(
	"query fields interface generated",
	source.includes("export interface UsersQueryFields") &&
		source.includes("export interface BlogPostsQueryFields"),
	true,
);
check(
	"query fields map generated (auth gets AuthRecord keys)",
	source.includes('"users": UsersQueryFields & AuthRecord;') &&
		source.includes('"blog_posts": BlogPostsQueryFields;'),
	true,
);
const usersQueryBlock =
	source.match(/export interface UsersQueryFields\b[\s\S]*?\n}/)?.[0] ?? "";
check(
	"password excluded from query fields",
	!usersQueryBlock.includes("password"),
	true,
);
const blogPostsRecordBlock =
	source.match(/export interface BlogPostsRecord\b[\s\S]*?\n}/)?.[0] ?? "";
const blogPostsQueryBlock =
	source.match(/export interface BlogPostsQueryFields\b[\s\S]*?\n}/)?.[0] ?? "";
check(
	"hidden relation included in query fields but not read model",
	blogPostsQueryBlock.includes('"reviewer"?: string;') &&
		!blogPostsRecordBlock.includes("reviewer"),
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

// ── 3b. BaseRecord key collisions (created/updated autodate fields) ──
// Regression: PocketBase-style collections carry `created`/`updated` autodate
// fields. Re-declaring them on the read/query interfaces (which extend
// BaseRecord) produced TS2430 ("incorrectly extends interface 'BaseRecord'").
const conflictSource = generateTypes(
	[
		{
			name: "addresses",
			type: "base",
			fields: [
				{ name: "fullName", type: "text" },
				{ name: "created", type: "autodate", options: { onCreate: true } },
				{
					name: "updated",
					type: "autodate",
					options: { onCreate: true, onUpdate: true },
				},
				{
					name: "created_at",
					type: "autodate",
					required: true,
					system: true,
				},
				{
					name: "updated_at",
					type: "autodate",
					required: true,
					system: true,
				},
			],
		},
	],
	{ packageName: "lazypock" },
);

const addressesRecordBlock =
	conflictSource.match(/export interface AddressesRecord\b[\s\S]*?\n}/)?.[0] ?? "";
const addressesQueryBlock =
	conflictSource.match(
		/export interface AddressesQueryFields\b[\s\S]*?\n}/,
	)?.[0] ?? "";

check(
	"BaseRecord key `created` not redeclared on the read model",
	!addressesRecordBlock.includes('"created"'),
	true,
);
check(
	"BaseRecord key `updated` not redeclared on the read model",
	!addressesRecordBlock.includes('"updated"'),
	true,
);
check(
	"BaseRecord keys not redeclared on the query interface",
	!addressesQueryBlock.includes('"created"') &&
		!addressesQueryBlock.includes('"updated"'),
	true,
);
check(
	"autodate system timestamps typed as string",
	addressesRecordBlock.includes('"created_at": string;') &&
		addressesRecordBlock.includes('"updated_at": string;'),
	true,
);
check(
	"regular field still emitted on a colliding collection",
	addressesRecordBlock.includes('"fullName"?: string;'),
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
		getScaleUrl("/api", "posts/p1/abc-123.png", "100x100"),
		"/api/files/posts/p1/abc-123.png?thumb=100x100",
	);

	// A preset name is looked up rather than turned into a box, and a storage key
	// keeps its separators while each segment is encoded.
	check(
		"getScaleUrl passes a preset name through",
		getScaleUrl("/api", "posts/p1/a b.png", "md"),
		"/api/files/posts/p1/a%20b.png?preset=md",
	);

	// Realtime is SSE now: the transport, topic mapping, headers and frame
	// parsing are covered by realtime-test.mjs against a fake SSE server.

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
					perPage: 500,
					totalItems: 2,
					totalPages: 1,
				}),
		};
	};
	const callCount = (url) => counters.get(url) ?? 0;
	const c = new LazypockClient({ baseUrl: "http://x/api" });

	// concurrent identical calls → 1 request, both resolve
	const url = "http://x/api/collections/posts/records?page=1&perPage=500";
	const [a, b] = await Promise.allSettled([
		c.collection("posts").getFullList({ fetch: fetchMock }),
		c.collection("posts").getFullList({ fetch: fetchMock }),
	]);
	check("getFullList dedup: 1 request for concurrent calls", callCount(url), 1);
	check("getFullList dedup: first resolves", a.status, "fulfilled");
	check("getFullList dedup: second resolves", b.status, "fulfilled");
	check("getFullList dedup: same data", a.value?.length, 2);

	// `batch` is capped at the server's perPage maximum (500); a larger value would 400
	const capped = [];
	const cappedFetch = async (u) => {
		capped.push(String(u));
		return fetchMock(u);
	};
	await c
		.collection("posts")
		.getFullList({ fetch: cappedFetch, batch: 5000, requestKey: "cap" })
		.catch(() => {});
	check("getFullList clamps batch to 500", capped[0]?.includes("perPage=500"), true);

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
					perPage: 500,
					totalItems: 4,
					totalPages: 2,
				}),
		};
	};
	const c3 = new LazypockClient({ baseUrl: "http://x/api" });
	const multi = await c3.collection("multi").getFullList({ fetch: pageFetch });
	check("getFullList dedup: multi-page returns 4 items", multi?.length, 4);
	const pageReqs = [...counters.keys()].filter((k) => k.includes("multi") && k.includes("page=")).length;
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

	// users schema so relation targets can be resolved across collections
	const usersSchema = {
		name: "users",
		type: "auth",
		fields: [
			{ name: "name", type: "text" },
			{ name: "email", type: "email" },
			{ name: "manager", type: "relation", options: { collection: "users" } },
		],
	};

	// 9. expand field selection — a dotted tail that is not a relation is
	// rewritten to PocketBase's `expand` + `fields=expand.<rel>.<field>` form
	// (raw `expand=owner.name` is silently dropped by the server).
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema, usersSchema] },
		});
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: "author.name,author.email" });
		check(
			"expand('author.name,author.email') → expand=author (dotted tails dropped)",
			lastUrl().includes("expand=author") && !lastUrl().includes("expand=author.name"),
			true,
		);
		check(
			"expand field selection → fields carries expand.author.{name,email}",
			lastUrl().includes("expand.author.name") &&
				lastUrl().includes("expand.author.email"),
			true,
		);
	}

	// 10. a dotted tail that IS a relation keeps nested-expand behaviour
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema, usersSchema] },
		});
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: "author.manager" });
		check(
			"expand('author.manager') keeps every relation prefix (author first)",
			lastUrl().includes("expand=author%2Cauthor.manager"),
			true,
		);
		check(
			"nested expand adds expand.author to fields (not the leaf path)",
			lastUrl().includes("expand.author") &&
				!lastUrl().includes("expand.author.manager"),
			true,
		);
	}

	// 11. plain expand survives the schema-default field projection
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema] },
		});
		await c.collection("posts").getList(1, 20, { fetch: fetchMock, expand: "author" });
		check(
			"plain expand + schema projection keeps expand.author in fields",
			lastUrl().includes("expand.author") && lastUrl().includes("expand=author"),
			true,
		);
	}

	// 12. no schema: two+ dotted tokens under one relation → field selection
	{
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: "author.name,author.email" });
		check(
			"no-schema expand('author.name,author.email') → expand=author, no fields param",
			lastUrl().includes("expand=author") && !lastUrl().includes("fields="),
			true,
		);
	}

	// 13. no schema: a lone dotted token stays a nested relation (with a warning)
	{
		const warns = [];
		const origWarn = console.warn;
		console.warn = (...a) => warns.push(a.join(" "));
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: "author.manager" });
		console.warn = origWarn;
		check(
			"no-schema single dotted token → expand=author,author.manager (nested)",
			lastUrl().includes("expand=author%2Cauthor.manager"),
			true,
		);
		check(
			"no-schema single dotted token warns about ambiguity",
			warns.some((w) => w.includes("treated as a nested relation")),
			true,
		);
	}

	// 14. array shorthands for sort / expand join to the comma form
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema, usersSchema] },
		});
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, sort: ["-title", "published"] });
		check(
			"sort array joins to sort=-title,published",
			lastUrl().includes("sort=-title%2Cpublished"),
			true,
		);
		await c
			.collection("posts")
			.getList(1, 20, { fetch: fetchMock, expand: ["author"] });
		check(
			"expand array joins + keeps expand.author",
			lastUrl().includes("expand=author") && lastUrl().includes("expand.author"),
			true,
		);
		await c
			.collection("posts")
			.getList(1, 20, {
				fetch: fetchMock,
				expand: ["author.name", "author.email"],
			});
		check(
			"expand array field selection rewrites to expand=author + fields",
			lastUrl().includes("expand=author") &&
				lastUrl().includes("expand.author.name"),
			true,
		);
	}

	// 15. typed filter builder — field/operator methods, safe escaping
	{
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema, usersSchema] },
		});
		const svc = c.collection("posts");
		const q = svc.where;

		check("where eq builds field = value", q("title").eq("x").toString(), "title = 'x'");
		check(
			"where escapes single quotes",
			q("title").contains("it's").toString(),
			"title ~ 'it\\'s'",
		);
		check(
			"where and() wraps and joins with &&",
			q("title").eq("a").and(q("published").eq(true)).toString(),
			"(title = 'a' && published = true)",
		);
		check(
			"where or()/not()",
			q("title").eq("a").or(q("title").eq("b")).not().toString(),
			"!((title = 'a' || title = 'b'))",
		);
		check(
			"where anyContains() uses the ?~ operator",
			q("title").anyContains("news").toString(),
			"title ?~ 'news'",
		);
		check("where eq(null) emits null", q("title").eq(null).toString(), "title = null");
		check(
			"where in() builds an OR chain",
			q("id").in(["a", "b", "c"]).toString(),
			"(id = 'a' || id = 'b' || id = 'c')",
		);
		check(
			"where notIn() builds an AND chain",
			q("id").notIn(["a", "b"]).toString(),
			"(id != 'a' && id != 'b')",
		);
		check(
			"where in() escapes values",
			q("id").in(["a'b"]).toString(),
			"(id = 'a\\'b')",
		);
		check(
			"where in() composes with and() without precedence bugs",
			q("id").in(["a", "b"]).and(q("title").eq("x")).toString(),
			"((id = 'a' || id = 'b') && title = 'x')",
		);
		let inThrew = false;
		try {
			q("id").in([]);
		} catch {
			inThrew = true;
		}
		check("where in([]) throws", inThrew, true);

		await svc.getList(1, 20, {
			fetch: fetchMock,
			filter: q("title").eq("a").and(q("published").eq(true)),
		});
		check(
			"filter accepts a FilterExpr",
			lastUrl().includes("filter=") && lastUrl().includes("published"),
			true,
		);

		// Filter callback: receives the typed `where` helper inline.
		await svc.getFullList({
			fetch: fetchMock,
			filter: (w) => w("title").contains("x").and(w("published").eq(true)),
		});
		check(
			"filter accepts a where-callback",
			lastUrl().includes("filter=") &&
				lastUrl().includes("title") &&
				lastUrl().includes("published"),
			true,
		);
	}

	// 16. client-side field selection on expanded records (servers that always
	// return the full related record, e.g. the LazyPock server)
	{
		const expandedItems = {
			items: [
				{
					id: "1",
					author: "u1",
					expand: {
						author: {
							id: "u1",
							name: "Ada",
							email: "ada@x.com",
							avatar: "a.png",
							created: "c",
							updated: "u",
						},
					},
				},
			],
			page: 1,
			perPage: 30,
			totalItems: 1,
			totalPages: 1,
		};
		const expandedFetch = async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify(expandedItems),
		});
		const oneFetch = async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify(expandedItems.items[0]),
		});
		const c = new LazypockClient({
			baseUrl: "http://x/api",
			types: { schemas: [postsSchema, usersSchema] },
		});
		const list = await c
			.collection("posts")
			.getList(1, 20, { fetch: expandedFetch, expand: "author.name,author.email" });
		const rec = list.items[0];
		check(
			"client-side expand narrowing keeps only requested fields",
			JSON.stringify(Object.keys(rec.expand.author).sort()),
			JSON.stringify(["email", "name"]),
		);
		const one = await c
			.collection("posts")
			.getOne("1", { fetch: oneFetch, expand: ["author.name"] });
		check(
			"client-side expand narrowing applies to getOne too",
			JSON.stringify(Object.keys(one.expand.author)),
			JSON.stringify(["name"]),
		);
		// A full (non-dotted) expand is left untouched.
		const fullList = await c
			.collection("posts")
			.getList(1, 20, { fetch: expandedFetch, expand: "author" });
		const full = fullList.items[0];
		check(
			"plain expand is not narrowed client-side",
			"email" in full.expand.author && "avatar" in full.expand.author,
			true,
		);
	}
})();

// ── Mail service ──
// The service is a thin mapping onto five endpoints, so what is worth checking
// is the mapping: which method, which path, and which body — a template send
// must not smuggle raw `subject`/`html`, and a preview must send only the drafts
// the editor actually has.
await (async () => {
	const calls = [];
	let reply = {};
	const mailFetch = async (url, init) => {
		calls.push({
			method: init.method,
			url,
			body: init.body ? JSON.parse(init.body) : undefined,
		});
		return new Response(JSON.stringify(reply), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	const last = () => calls[calls.length - 1];
	const c = new LazypockClient({ baseUrl: "http://x/api" });

	for (const method of [
		"send",
		"listTemplates",
		"getTemplate",
		"saveTemplate",
		"deleteTemplate",
		"preview",
	]) {
		check(`client.mail.${method} is a function`, typeof c.mail[method], "function");
	}

	// 1. A template send carries the template and its assigns, nothing raw.
	reply = { queued: true, id: "job-1" };
	const queued = await c.mail.send(
		{ to: "ada@example.com", toName: "Ada", template: "receipt", assigns: { total: 42 } },
		{ fetch: mailFetch },
	);
	check("send() POSTs /mail", last().method + " " + last().url, "POST http://x/api/mail");
	check(
		"a template send sends only the template fields",
		JSON.stringify(last().body),
		JSON.stringify({
			to: "ada@example.com",
			toName: "Ada",
			template: "receipt",
			assigns: { total: 42 },
		}),
	);
	check("send() returns the queued job", queued.id, "job-1");

	// 2. A raw send carries the subject and bodies instead.
	await c.mail.send(
		{ to: "ada@example.com", subject: "Hi", text: "Hello" },
		{ fetch: mailFetch },
	);
	check(
		"a raw send sends the subject and body",
		JSON.stringify(last().body),
		JSON.stringify({ to: "ada@example.com", subject: "Hi", text: "Hello" }),
	);

	// 3. The listing unwraps `items`.
	reply = {
		items: [
			{
				name: "receipt",
				source: "database",
				parts: { subject: "database", html: "file", text: "builtin" },
				subject: "Receipt",
				html: "<p>x</p>",
				text: "x",
			},
		],
	};
	const templates = await c.mail.listTemplates({ fetch: mailFetch });
	check("listTemplates() GETs /mail/templates", last().url, "http://x/api/mail/templates");
	check("listTemplates() unwraps items", templates.length, 1);
	check("a template reports its per-part layers", templates[0].parts.html, "file");

	// 4. A name is encoded, so a slash cannot become a path segment.
	reply = { name: "a/b", source: "builtin", parts: {}, subject: "s", html: "h", text: "t" };
	await c.mail.getTemplate(" a/b ", { fetch: mailFetch });
	check("getTemplate() encodes the name", last().url, "http://x/api/mail/templates/a%2Fb");

	// 5. A save replaces all three parts in one PUT.
	await c.mail.saveTemplate(
		"receipt",
		{ subject: "S", html: "<p>H</p>", text: "T" },
		{ fetch: mailFetch },
	);
	check("saveTemplate() PUTs the template", last().method + " " + last().url, "PUT http://x/api/mail/templates/receipt");
	check(
		"saveTemplate() sends all three parts",
		JSON.stringify(last().body),
		JSON.stringify({ subject: "S", html: "<p>H</p>", text: "T" }),
	);

	// 6. A reset reports how many stored parts went away.
	reply = { name: "receipt", deleted: 3 };
	const reset = await c.mail.deleteTemplate("receipt", { fetch: mailFetch });
	check("deleteTemplate() DELETEs the template", last().method + " " + last().url, "DELETE http://x/api/mail/templates/receipt");
	check("deleteTemplate() reports the reset", reset.deleted, 3);

	// 7. A preview sends the draft in place of the stored part.
	reply = { name: "receipt", subject: "Rendered", html: "<p>R</p>", text: "R" };
	const preview = await c.mail.preview(
		"receipt",
		{ html: "<p>draft</p>" },
		{ fetch: mailFetch },
	);
	check(
		"preview() POSTs the preview path",
		last().method + " " + last().url,
		"POST http://x/api/mail/templates/receipt/preview",
	);
	check(
		"preview() sends only the drafts it has",
		JSON.stringify(last().body),
		JSON.stringify({ html: "<p>draft</p>" }),
	);
	check("preview() returns the rendered parts", preview.subject, "Rendered");
})();

// ── P1 regression batch ────────────────────────────────
// One focused case per fixed defect, placed together so the batch can be
// reviewed as a unit. Each fails against the pre-fix build.

import { AuthStore } from "./dist/index.js";

// 1. collections.delete must await the request and surface failures.
await (async () => {
	const c = new LazypockClient({ baseUrl: "http://x/api" });
	const okFetch = async () => ({ ok: true, status: 204, text: async () => "" });
	const deleted = await c.collections.delete("abc", { fetch: okFetch });
	check("collections.delete() returns true on success", deleted, true);

	let err = null;
	const forbidden = async () => ({
		ok: false,
		status: 403,
		statusText: "Forbidden",
		text: async () => JSON.stringify({ message: "nope" }),
	});
	try {
		await c.collections.delete("abc", { fetch: forbidden, requestKey: null });
	} catch (e) {
		err = e;
	}
	check("collections.delete() rejects on failure", err instanceof ApiError, true);
	check("collections.delete() propagates the status", err?.status, 403);
})();

// 2. getFullList owns page/perPage: caller keys must not hijack the loop.
await (async () => {
	const urls = [];
	const pageFetch = async (url) => {
		urls.push(String(url));
		const m = String(url).match(/page=(\d+)/);
		const page = m ? Number(m[1]) : 1;
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					items: page === 1 ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }],
					page,
					perPage: 500,
					totalItems: 3,
					totalPages: 2,
				}),
		};
	};
	const c = new LazypockClient({ baseUrl: "http://x/api" });

	await c
		.collection("cap")
		.getFullList({ fetch: pageFetch, perPage: 1000, requestKey: "cap-bypass" });
	check(
		"getFullList ignores a raw perPage (cap not bypassable)",
		urls.some((u) => u.includes("perPage=1000")),
		false,
	);
	check(
		"getFullList still pages at the 500 cap",
		urls.every((u) => u.includes("perPage=500")),
		true,
	);

	urls.length = 0;
	const rows = await c
		.collection("pg")
		.getFullList({ fetch: pageFetch, page: 2, requestKey: "pg-bypass" });
	check("getFullList starts at page 1", urls[0].includes("page=1"), true);
	check(
		"getFullList ignores a raw page (no duplicated rows)",
		rows.map((r) => r.id).join(","),
		"1,2,3",
	);
})();

// 3. AuthStore.setModel refreshes the record without resetting the expiry.
{
	const memoryStorage = () => {
		const map = new Map();
		return {
			get: (k) => (map.has(k) ? map.get(k) : null),
			set: (k, v) => void map.set(k, v),
			remove: (k) => void map.delete(k),
		};
	};
	const store = new AuthStore(memoryStorage());
	// A 1-second token already counts as expired under the 30s refresh buffer.
	store.setSession("tok-1", { id: "u1" }, { refreshToken: "r1", expiresIn: 1 });
	check("setSession records a short expiresIn", store.isExpired, true);

	store.setModel({ id: "u1", name: "fresh" });
	check("setModel keeps the recorded expiry", store.isExpired, true);
	check("setModel keeps the token", store.token, "tok-1");
	check("setModel keeps the refresh token", store.refreshToken, "r1");
	check("setModel updates the model", store.model?.name, "fresh");

	// Documents why me() must not route through set().
	store.set("tok-1", { id: "u1", name: "fresh" });
	check("set() still resets to the fallback TTL", store.isExpired, false);
}

// 4. Superuser login surfaces auth errors instead of falling back to a route
//    the server may not have.
await (async () => {
	const realFetch = globalThis.fetch;
	try {
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			// The modern endpoint rejects the credentials; the legacy route does not
			// exist on this server (404). The old fallback therefore reported "not
			// found" instead of the real auth failure.
			if (String(url).includes("/collections/_superusers/auth-with-password")) {
				return {
					ok: false,
					status: 401,
					statusText: "Unauthorized",
					text: async () => JSON.stringify({ message: "Failed to authenticate." }),
				};
			}
			return {
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () => JSON.stringify({ message: "not found" }),
			};
		};
		let err = null;
		try {
			await new LazypockClient({ baseUrl: "http://x/api" }).login("a@b.c", "wrong");
		} catch (e) {
			err = e;
		}
		check("superuser login surfaces the auth error", err?.status, 401);
		check("superuser login keeps the server message", err?.message, "Failed to authenticate.");
		check(
			"superuser login does not fall back on a 401",
			calls.filter((u) => u.includes("/superusers/login")).length,
			0,
		);

		// An older server without the modern endpoint answers 404 → legacy route.
		calls.length = 0;
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).includes("/collections/_superusers/auth-with-password")) {
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					text: async () => JSON.stringify({ message: "not found" }),
				};
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ token: "legacy-token" }),
			};
		};
		const data = await new LazypockClient({ baseUrl: "http://x/api" }).login(
			"a@b.c",
			"pw",
		);
		check(
			"superuser login falls back on a 404",
			calls.some((u) => u.includes("/superusers/login")),
			true,
		);
		check("superuser login returns the legacy token", data?.token, "legacy-token");
	} finally {
		globalThis.fetch = realFetch;
	}
})();

// 5. disconnect() is not a one-way door: a later subscribe() reconnects.
await (async () => {
	const realFetch = globalThis.fetch;
	try {
		let connects = 0;
		globalThis.fetch = async () => {
			connects++;
			return {
				ok: true,
				status: 200,
				// A stream that never ends keeps the connection "open".
				body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
			};
		};
		const tick = () => new Promise((r) => setTimeout(r, 10));
		const rt = new RealtimeService();
		rt.setUrl("http://x/api/realtime");

		rt.subscribe("collection:posts", () => {});
		await tick();
		const first = connects;

		rt.disconnect();
		await tick();
		const afterDisconnect = connects;

		rt.subscribe("collection:posts", () => {});
		await tick();
		const afterResubscribe = connects;
		rt.disconnect();

		check("realtime opens a stream on first subscribe", first, 1);
		check("realtime disconnect stops the stream", afterDisconnect, 1);
		check("subscribe() after disconnect() reconnects", afterResubscribe, 2);
	} finally {
		globalThis.fetch = realFetch;
	}
})();

// 6. files.uploadDirect works where global `File` does not exist (Node 18 / RN).
// Exercised through uploadDirect, not upload(): Node's own FormData.append calls
// `new File(...)` internally, so clearing the global breaks undici before our
// code is reached. Both paths share `uploadFileName`, which is the guard under
// test — a Blob carries no name, so the default must be used.
await (async () => {
	const RealFile = globalThis.File;
	const realFetch = globalThis.fetch;
	try {
		const bodies = [];
		globalThis.fetch = async (url, init) => {
			bodies.push({
				url: String(url),
				body: init?.body ? JSON.parse(init.body) : null,
			});
			return {
				ok: false,
				status: 400,
				statusText: "Bad Request",
				text: async () => JSON.stringify({ message: "direct upload not configured" }),
			};
		};
		const c = new LazypockClient({ baseUrl: "http://x/api" });
		globalThis.File = undefined;
		let err = null;
		try {
			await c.files.uploadDirect(new Blob(["hi"]));
		} catch (e) {
			err = e;
		}
		check(
			"files.uploadDirect survives a missing global File",
			err instanceof ApiError,
			true,
		);
		check(
			"files.uploadDirect falls back to the default upload name",
			bodies[0]?.body?.filename,
			"file",
		);
	} finally {
		globalThis.File = RealFile;
		globalThis.fetch = realFetch;
	}
})();

// 7. An injected fetch also intercepts the automatic token refresh.
await (async () => {
	const realFetch = globalThis.fetch;
	try {
		let globalCalls = 0;
		globalThis.fetch = async () => {
			globalCalls++;
			throw new Error("global fetch used for the refresh");
		};
		const seen = [];
		const injected = async (url) => {
			seen.push(String(url));
			if (String(url).includes("auth-refresh")) {
				// performRefresh reads the refresh response with res.json().
				const payload = {
					token: "new",
					refreshToken: "r2",
					expiresIn: 900,
					record: { id: "u1" },
				};
				return {
					ok: true,
					status: 200,
					json: async () => payload,
					text: async () => JSON.stringify(payload),
				};
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
		};
		const sessions = [];
		const store = {
			token: "old",
			refreshToken: "r1",
			collectionName: "users",
			model: { id: "u1" },
			isExpired: true,
			set() {},
			setSession(...args) {
				sessions.push(args);
			},
			setCollectionName() {},
			clear() {},
		};
		const h = new HttpClient("http://x/api", store);
		const res = await h.request("GET", "/posts", undefined, {
			fetch: injected,
			requestKey: null,
		});

		check("refresh never touches the global fetch", globalCalls, 0);
		check(
			"refresh is issued through the injected fetch",
			seen.some((u) => u.includes("auth-refresh")),
			true,
		);
		check("refresh rotated the session", sessions.length, 1);
		check("the original request still completes", res?.ok, true);
	} finally {
		globalThis.fetch = realFetch;
	}
})();

console.log(
	failures === 0 ? "\n✅ All smoke tests passed" : `\n❌ ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
