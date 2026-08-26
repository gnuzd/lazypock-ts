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
const _bad: string = await postsSvc.getOne("abc");
void _bad;

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
const _nopeSvc = typed.collection("nope");
void _nopeSvc;

// Positive: literal key resolves to the right type (posts → Post)
const postSvc = typed.collection("posts");
postSvc.create({ title: "ok" }); // ✓

// Dynamic collection names: strict keys reject a plain string variable,
// so use the base client (untyped) or a cast for dynamic access.
const dynName: string = "posts";
// @ts-expect-error strict keys: string not assignable to literal
const _dynSvc = typed.collection(dynName);
void _dynSvc;
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
	const _n: number = postList.items[0].title;
	void _n;
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
// Operators need not be surrounded by spaces (`project=x` and `project = x` both compile).
const search: string = "abc";
await postsSvc.getList(1, 20, { filter: `title=${search}` });
await postsSvc.getList(1, 20, { filter: "title~'x'" });
// Parenthesized / negated expressions — the first clause is still validated.
await postsSvc.getList(1, 20, { filter: "(title = 'a' || published = true)" });
await postsSvc.getList(1, 20, { filter: "!(published = true)" });
// Relation dot-paths (`author.email = 'x'`) are accepted.
await postsSvc.getList(1, 20, { filter: "author.email = 'x'" });
// @ts-expect-error filter rejects unknown fields
await postsSvc.getList(1, 20, { filter: "nope = 'x'" });
// @ts-expect-error filter rejects invalid operators
await postsSvc.getList(1, 20, { filter: "title nope 'x'" });

await postsSvc.getList(1, 20, { expand: "author" });
await postsSvc.getOne("abc", { expand: "author", fields: "id,title" });
// Nested dot-paths (`author.user`) are accepted for multi-level relations.
await postsSvc.getList(1, 20, { expand: "author.user" });
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
// Query fields — the filter/sort/expand/select key set. Mirrors what the
// codegen CLI emits: it includes hidden fields, which are excluded from the
// read model but remain expandable/filterable at runtime.
interface ProjectMembersRecord {
	id: string;
	collectionId: string;
	collectionName: string;
	created: string;
	updated: string;
	role: "owner" | "editor" | "viewer";
}
interface ProjectMembersCreateData {
	role?: "owner" | "editor" | "viewer";
}
interface ProjectMembersQueryFields extends ProjectMembersRecord {
	project?: string; // hidden relation — not on the read model
	user?: string; // hidden relation — not on the read model
}
type GeneratedCollections = {
	users: UsersRecord;
	project_members: ProjectMembersRecord;
};
type GeneratedCreateData = {
	users: UsersCreateData;
	project_members: ProjectMembersCreateData;
};
type GeneratedQueryFields = {
	users: UsersRecord;
	project_members: ProjectMembersQueryFields;
};

declare function genCollection<
	K extends keyof GeneratedCollections | (string & {}),
>(
	name: K,
): K extends keyof GeneratedCollections
	? CollectionService<
			GeneratedCollections[K],
			GeneratedCreateData[K],
			GeneratedQueryFields[K]
		>
	: CollectionService<unknown>;

const genUsers = genCollection("users");
// The generated-style signature also accepts dynamic/unknown names, which
// resolve to the untyped service (studio/dynamic-collection use case).
const genDynamic: string = "whatever";
genCollection(genDynamic).getList(); // ✓ untyped, no error
genCollection("nope").getList(); // ✓ untyped, no error
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
	void genUser.password;
}

// ── 7b. Hidden relation fields in filter/sort/expand/select ──
// Hidden fields are excluded from the read model (no `record.user`) but the
// server still resolves them for expand/filter/select — the QueryFields type
// keeps those keys usable while the read model stays clean.
const genPM = genCollection("project_members");
genPM.getFullList({ expand: "user" }); // ✓ hidden relation expandable
genPM.getFullList({ expand: "user,project" }); // ✓
genPM.getFullList({ expand: "user.avatar" }); // ✓ dot-path
genPM.getList(1, 20, { expand: "user" }); // ✓
genPM.getOne("abc", { expand: "user" }); // ✓
genPM.getList(1, 20, { filter: "user = 'x'" }); // ✓ hidden field filterable
genPM.select("user"); // ✓ hidden field selectable
genPM.getList(1, 20, { sort: "-created" }); // ✓ system keys still available
// @ts-expect-error unknown expand still rejected
genPM.getFullList({ expand: "nope" });
// @ts-expect-error unknown filter field still rejected
genPM.getList(1, 20, { filter: "nope = 'x'" });
// @ts-expect-error hidden field is NOT on the read model
void genPM.getOne("abc").then((r) => r && r.user);

// ── 8. PocketBase-style realtime subscribe / unsubscribe ──
// All PocketBase argument forms typecheck against the typed service.
postsSvc.subscribe("*", (e) => {
	// The callback receives a full record (not projected by select())
	const id: string = e.record.id as string;
	void id;
}); // ✓ wildcard
postsSvc.subscribe("abc-123", (e) => e); // ✓ single record
postsSvc.subscribe((e) => e); // ✓ shorthand (all records)
postsSvc.subscribe("abc-123", (e) => e, {
	expand: "author",
	headers: { "X-Custom": "1" },
}); // ✓ options
// Legacy callback-first form still typechecks
postsSvc.subscribe((e) => e, "legacy-id");
// @ts-expect-error topic-first form requires a callback
postsSvc.subscribe("*");
// @ts-expect-error subscribe options must be an object
postsSvc.subscribe("*", (e) => e, 123);

postsSvc.unsubscribe("*"); // ✓ wildcard
postsSvc.unsubscribe("abc-123"); // ✓ single record
postsSvc.unsubscribe(); // ✓ all

console.log("type-test OK (compile-time checks only)");
