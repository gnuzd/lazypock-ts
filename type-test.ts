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
	type CollectionService,
} from "./src/index";

// A hand-rolled collections map (simulating codegen output)
interface Post {
	id: string;
	title: string;
	published: boolean;
	author: string; // relation to users
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

// ── 5. select() field projection ──
postsSvc.select("id", "title"); // ✓ known fields
postsSvc.select("*"); // ✓ wildcard
postsSvc.select(); // ✓ reset to default
// @ts-expect-error select rejects unknown fields
postsSvc.select("nope");
// @ts-expect-error select rejects unknown fields (mixed)
postsSvc.select("id", "nope");
// chainable into a read
await postsSvc.select("title").getList(1, 20);
await postsSvc.select("title").getOne("abc");
// untyped client accepts any field name
base.collection("posts").select("anything", "at-all");

// ── 6. typed filter / sort / expand suggestions ──
await postsSvc.getList(1, 20, { sort: "-title" });
await postsSvc.getList(1, 20, { sort: "title,published" });
// @ts-expect-error sort rejects unknown fields
await postsSvc.getList(1, 20, { sort: "-nope" });
// @ts-expect-error sort rejects unknown fields (bare)
await postsSvc.getList(1, 20, { sort: "nope" });

await postsSvc.getList(1, 20, { filter: "title ~ 'x'" });
await postsSvc.getList(1, 20, { filter: "title = 'a' && published = true" });
await postsSvc.getFirstListItem("title ~ 'x'");
// @ts-expect-error filter rejects unknown fields
await postsSvc.getList(1, 20, { filter: "nope = 'x'" });
// @ts-expect-error filter rejects invalid operators
await postsSvc.getList(1, 20, { filter: "title == 'x'" });

await postsSvc.getList(1, 20, { expand: "author" });
await postsSvc.getOne("abc", { expand: "author", fields: "id,title" });
// @ts-expect-error expand rejects unknown fields
await postsSvc.getList(1, 20, { expand: "nope" });

// untyped client: filter/sort/expand remain free-form strings
await base.collection("posts").getList(1, 20, {
	filter: "anything = 'x'",
	sort: "-anything",
	expand: "whatever",
});

// ── 7. Auth collection: write-only password in create data ──
// Mirrors what the codegen CLI emits for the built-in `users` auth
// collection: the read model has NO password, while the *CreateData write
// model exposes `password` (canonical, optional) plus the legacy
// `password_hash` alias.
interface UsersRecord {
	id: string;
	collectionId: string;
	collectionName: string;
	created: string;
	updated: string;
	email: string;
	verified: boolean;
	emailVisibility: boolean;
}
interface UsersCreateData {
	email: string;
	password?: string;
	password_hash?: string;
	name?: string;
	verified?: boolean;
	emailVisibility?: boolean;
}
type GeneratedCollections = { users: UsersRecord };
type GeneratedCreateData = { users: UsersCreateData };

declare function genCollection<T extends string>(
	name: T,
): T extends keyof GeneratedCollections
	? CollectionService<GeneratedCollections[T], GeneratedCreateData[T]>
	: CollectionService<unknown>;

const genUsers = genCollection("users");
// Creating a user with `password` typechecks (the canonical write key)
genUsers.create({ email: "a@b.c", password: "secret" }); // ✓
// Password is optional — accounts may exist without one
genUsers.create({ email: "a@b.c" }); // ✓
// Legacy `password_hash` alias still accepted
genUsers.create({ email: "a@b.c", password_hash: "legacy" }); // ✓
// @ts-expect-error password is a string, not a number
genUsers.create({ email: "a@b.c", password: 123 });
// @ts-expect-error unknown field
genUsers.create({ email: "a@b.c", nope: 1 });
// The read model never carries a password
const genUser = await genUsers.getOne("abc");
if (genUser) {
	// @ts-expect-error password is never on the read model
	genUser.password;
}

console.log("type-test OK (compile-time checks only)");
