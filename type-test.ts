// ── Type-level test: TypedClient + create() field validation ──
// This file is NOT executed — it's typechecked. If the generated types
// don't reject unknown fields, `tsc` will still pass; we use @ts-expect-error
// to ASSERT that bad calls FAIL to compile.
//
// Run: npx tsc --noEmit --strict type-test.ts

import {
	LazypockClient,
	createClient,
	TypedClient,
	type LazypockCollections,
	type CacheConfig,
} from "./src/index";

// A hand-rolled collections map (simulating codegen output)
interface Post {
	id: string;
	title: string;
	published: boolean;
}

interface User {
	id: string;
	email: string;
	role: "admin" | "member";
}

type MyCollections = {
	posts: Post;
	users: User;
};

// ── 1. Base client: collection<T>() generic ──
const base = new LazypockClient({ baseUrl: "http://localhost:4000/api" });
const postsSvc = base.collection("posts").typed<Post>();
// @ts-expect-error title is string, not number
postsSvc.create({ title: 123 });
postsSvc.create({ title: "hi" }); // ✓ no error

// @ts-expect-error unknown field
postsSvc.create({ nope: 1 });
// @ts-expect-error unknown field on update too
postsSvc.update("id1", { nope: 1 });

// @ts-expect-error getOne returns Post, not string
const bad: string = await postsSvc.getOne("abc");

// ── 2. Typed client: collection<K>() resolves per-collection ──
const typed = createClient<MyCollections>({
	baseUrl: "http://localhost:4000/api",
});
const userSvc = typed.collection("users");
// @ts-expect-error users have email, not title
userSvc.create({ title: "x" });
// ✓ correct: users have email + role
userSvc.create({ email: "a@b.c", role: "admin" });

// @ts-expect-error role is union, not arbitrary string
userSvc.create({ email: "a@b.c", role: "superadmin" });

// @ts-expect-error "nope" is not in MyCollections
const nopeSvc = typed.collection("nope");

// Positive: literal key resolves to the right type (posts → Post)
const postSvc = typed.collection("posts");
postSvc.create({ title: "ok" }); // ✓

// Dynamic collection names: strict keys reject a plain string variable,
// so use the base client (untyped) or a cast for dynamic access.
const dynName: string = "posts";
// @ts-expect-error strict keys: string not assignable to literal
const dynSvc = typed.collection(dynName);
// Escape hatch: cast to keyof
const dynCast = typed.collection(dynName as keyof MyCollections);
dynCast.create({ title: "ok" }); // ✓

// ── 3. TypedClient direct instantiation ──
const tc = new TypedClient<MyCollections>({
	baseUrl: "http://localhost:4000/api",
});
// @ts-expect-error posts collection has no email
tc.collection("posts").create({ email: "x" });

// ── 4. getList() typing ──
const postList = await postsSvc.getList();
if (postList) {
	// @ts-expect-error items are Post[], title is string not number
	const n: number = postList.items[0].title;
}

// ── 5. cache options typing ──
const cacheCfg: CacheConfig = { enabled: true, defaultTTL: 30_000 };
const withCache = new LazypockClient({
	baseUrl: "http://localhost:4000/api",
	cache: cacheCfg,
});
withCache.cache({ enabled: false });
withCache.clearCache();
withCache.invalidateCache("posts");
withCache.cache.deleteByPrefix("getList:posts");
withCache.cache.invalidate("posts");
withCache.cache.clear();
const cacheStats2 = withCache.cache.stats();
if (cacheStats2) {
	// @ts-expect-error hits is number, not string
	const badStats: string = cacheStats2.hits;
}
const stats = withCache.cacheStats();
if (stats) {
	// @ts-expect-error hits is number, not string
	const bad: string = stats.hits;
}
// cache/ttl/invalidate flow through request options
typed.collection("posts").getList(1, 20, { cache: true });
typed.collection("posts").getList(1, 20, { ttl: 120_000 });
typed.collection("posts").getList(1, 20, { cache: false });
typed.collection("posts").create({ title: "hi" }, { invalidate: ["users"] });
// @ts-expect-error cache must be boolean/number/object, not a string
typed.collection("posts").getList(1, 20, { cache: "yes" });

console.log("type-test OK (compile-time checks only)");
