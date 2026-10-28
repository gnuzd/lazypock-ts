// ── Read-query normalisation tests ──────────────────────
// Run: npm run smoke  (plain script, like the other test files)
//
// These exercise `src/query.ts` directly rather than through a mocked fetch.
// That module is the expand/fields translation layer — the part of the SDK
// that has changed most often — so it is worth testing as pure functions:
// a token matrix is cheap to express here and impossible to read through
// URL assertions alone.
//
// Imports the TypeScript source (Node strips the types) so the tests need no
// build step and no extra public exports: the module is internal API.

import {
	applyExpandNarrowing,
	effectiveFields,
	expandParam,
	mergeExpandFields,
	normalizeExpand,
	prepareReadQuery,
	visibleFields,
} from "./src/query.ts";

let failures = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`}`,
	);
}

/** Run `fn` with console.warn captured (the helpers warn, never throw). */
function warnings(fn) {
	const captured = [];
	const original = console.warn;
	console.warn = (msg) => captured.push(String(msg));
	try {
		fn();
	} finally {
		console.warn = original;
	}
	return captured;
}

// ── Fixtures ──
const users = {
	name: "users",
	type: "base",
	fields: [
		{ name: "id", type: "text" },
		{ name: "name", type: "text" },
		{ name: "email", type: "email" },
		{ name: "avatar", type: "file" },
		{ name: "manager", type: "relation", options: { collection: "users" } },
		{ name: "password", type: "password" },
		{ name: "created", type: "autodate" },
		{ name: "updated", type: "autodate" },
		{ name: "secretNote", type: "text", hidden: true },
	],
};
const posts = {
	name: "posts",
	type: "base",
	fields: [
		{ name: "title", type: "text" },
		{ name: "published", type: "bool" },
		{ name: "author", type: "relation", options: { collection: "users" } },
		{ name: "tags", type: "relation", options: { collection: "users", maxSelect: 5 } },
	],
};
const schemas = { users, posts };
const ctx = {
	collectionName: "posts",
	schema: posts,
	resolveCollection: (nameOrId) => schemas[nameOrId],
};
const bare = { collectionName: "posts" }; // no schema at all

// ── visibleFields: what an unprojected read asks for ──
check(
	"visibleFields: system keys first, hidden/password/autodate excluded",
	visibleFields(users),
	"id,created,updated,collectionId,collectionName,name,email,avatar,manager",
);
check("visibleFields: no schema → undefined (server decides)", visibleFields(undefined), undefined);
check(
	"visibleFields: schema with no fields → undefined",
	visibleFields({ name: "empty", type: "base" }),
	undefined,
);
check(
	"visibleFields: all fields filtered out → undefined",
	visibleFields({ name: "x", type: "base", fields: [{ name: "pw", type: "password" }] }),
	undefined,
);
check(
	"visibleFields: a field named after a system key is deduped",
	visibleFields({
		name: "x",
		type: "base",
		fields: [{ name: "id", type: "text" }, { name: "created", type: "text" }],
	}),
	"id,created,updated,collectionId,collectionName",
);

// ── effectiveFields: caller > select() preset > schema default ──
check(
	"effectiveFields: explicit options.fields wins over the preset",
	effectiveFields(ctx, "title", "id,title"),
	"id,title",
);
check("effectiveFields: select() preset is used verbatim", effectiveFields(ctx, "id,title"), "id,title");
check(
	'effectiveFields: select("*") expands to the visible fields',
	effectiveFields(ctx, "*"),
	"id,created,updated,collectionId,collectionName,title,published,author,tags",
);
check(
	"effectiveFields: no preset → schema default",
	effectiveFields(ctx),
	"id,created,updated,collectionId,collectionName,title,published,author,tags",
);
check("effectiveFields: no schema, no preset → undefined", effectiveFields(bare), undefined);

// ── normalizeExpand: the token matrix ──
check(
	"normalizeExpand: no expand → nothing added",
	(() => {
		const r = normalizeExpand(ctx, undefined);
		return [r.expand, r.fieldSelectors, r.narrow.size];
	})(),
	[undefined, [], 0],
);

check(
	"normalizeExpand: plain relation → expand + expand.<rel> selector",
	(() => {
		const r = normalizeExpand(ctx, "author");
		return [r.expand, r.fieldSelectors, r.narrow.size];
	})(),
	["author", ["expand.author"], 0],
);

check(
	"normalizeExpand: plain token is deduped",
	(() => {
		const r = normalizeExpand(ctx, "author,author");
		return [r.expand, r.fieldSelectors];
	})(),
	["author", ["expand.author"]],
);

check(
	"normalizeExpand: non-relation token warns but stays plain",
	(() => {
		let out;
		const warns = warnings(() => {
			out = normalizeExpand(ctx, "title");
		});
		return [out.expand, out.fieldSelectors, warns.length > 0];
	})(),
	["title", ["expand.title"], true],
);

check(
	"normalizeExpand: all-relation path → every prefix, one selector",
	(() => {
		const r = normalizeExpand(ctx, "author.manager");
		return [r.expand, r.fieldSelectors, r.narrow.size];
	})(),
	["author,author.manager", ["expand.author"], 0],
);

check(
	"normalizeExpand: dotted field selection → relation expand + narrow",
	(() => {
		const r = normalizeExpand(ctx, "author.name,author.email");
		return [r.expand, r.fieldSelectors, [...r.narrow]];
	})(),
	["author", ["expand.author.name", "expand.author.email"], [["author", ["name", "email"]]]],
);

check(
	"normalizeExpand: mixed plain and narrow tokens on different relations",
	(() => {
		const r = normalizeExpand(ctx, "tags,author.name");
		return [r.expand, r.fieldSelectors, [...r.narrow]];
	})(),
	["tags,author", ["expand.tags", "expand.author.name"], [["author", ["name"]]]],
);

check(
	"normalizeExpand: no schema, two dotted tokens under one relation → field selection",
	(() => {
		const r = normalizeExpand(bare, "author.name,author.email");
		return [r.expand, r.fieldSelectors, [...r.narrow]];
	})(),
	["author", ["expand.author.name", "expand.author.email"], [["author", ["name", "email"]]]],
);

check(
	"normalizeExpand: no schema, lone dotted token → nested expand (with a hint)",
	(() => {
		let out;
		const warns = warnings(() => {
			out = normalizeExpand(bare, "author.name");
		});
		return [out.expand, out.fieldSelectors, out.narrow.size, warns.length];
	})(),
	["author,author.name", ["expand.author"], 0, 1],
);
check(
	"normalizeExpand: no schema, dotted tokens on different relations stay nested",
	(() => {
		let out;
		warnings(() => {
			out = normalizeExpand(bare, "author.name,tags.title");
		});
		return [out.expand, out.narrow.size];
	})(),
	["author,author.name,tags,tags.title", 0],
);

// ── mergeExpandFields: keep the expansion alive under strict projection ──
const narrowInfo = normalizeExpand(ctx, "author.name");
check(
	"mergeExpandFields: no selectors → base untouched",
	mergeExpandFields("id,title", normalizeExpand(ctx, undefined)),
	"id,title",
);
check(
	"mergeExpandFields: no base → no projection invented",
	mergeExpandFields(undefined, normalizeExpand(ctx, "author")),
	undefined,
);
check(
	"mergeExpandFields: adds relation field and expand.<rel>",
	mergeExpandFields("id,title", normalizeExpand(ctx, "author")),
	"id,title,author,expand.author",
);
check(
	"mergeExpandFields: narrow selector omits the full expand key",
	mergeExpandFields("id", narrowInfo),
	"id,author,expand.author.name",
);
check(
	"mergeExpandFields: full expand key swallows the narrower selector",
	mergeExpandFields("id", {
		fieldSelectors: ["expand.author", "expand.author.name"],
		narrow: narrowInfo.narrow,
	}),
	"id,author,expand.author",
);
check(
	"mergeExpandFields: already-present entries are not duplicated",
	mergeExpandFields("id,author,expand.author", normalizeExpand(ctx, "author")),
	"id,author,expand.author",
);

// ── applyExpandNarrowing: client-side field selection ──
{
	const record = { id: "1", expand: { author: { id: "u1", name: "Ada", email: "a@x.com" } } };
	const out = applyExpandNarrowing(record, new Map([["author", ["name"]]]));
	check(
		"applyExpandNarrowing: keeps only the requested leaves",
		out.expand.author,
		{ name: "Ada" },
	);
	check(
		"applyExpandNarrowing: original record is not mutated",
		Object.keys(record.expand.author).sort(),
		["email", "id", "name"],
	);
	check(
		"applyExpandNarrowing: no narrow map → same record returned",
		applyExpandNarrowing(record, new Map()),
		record,
	);
	check(
		"applyExpandNarrowing: already-narrowed record is a no-op",
		applyExpandNarrowing({ id: "1", expand: { author: { name: "Ada" } } }, new Map([["author", ["name", "email"]]])),
		{ id: "1", expand: { author: { name: "Ada" } } },
	);
	const multi = {
		id: "1",
		expand: { tags: [{ id: "u1", name: "Ada", email: "a@x.com" }, { id: "u2", name: "Bo", email: "b@x.com" }] },
	};
	check(
		"applyExpandNarrowing: multi-relation is narrowed element-wise",
		applyExpandNarrowing(multi, new Map([["tags", ["name"]]])).expand.tags,
		[{ name: "Ada" }, { name: "Bo" }],
	);
	check(
		"applyExpandNarrowing: missing/absent expand payload → record untouched",
		applyExpandNarrowing({ id: "1" }, new Map([["author", ["name"]]])),
		{ id: "1" },
	);
}

// ── expandParam: the array shorthand ──
check("expandParam: array joins", expandParam(["author", "tags"]), "author,tags");
check("expandParam: string passes through", expandParam("author"), "author");
check("expandParam: anything else → undefined", expandParam(42), undefined);
check("expandParam: empty array joins to empty string", expandParam([]), "");

// ── prepareReadQuery: one derivation for getList and getOne ──
{
	const fromString = prepareReadQuery(ctx, { expand: "author.name", fields: undefined }, undefined);
	const fromArray = prepareReadQuery(ctx, { expand: ["author.name"], fields: undefined }, undefined);
	check(
		"prepareReadQuery: array and string expand are equivalent (getList/getOne parity)",
		[fromArray.expand, fromArray.fields, [...fromArray.narrow]],
		[fromString.expand, fromString.fields, [...fromString.narrow]],
	);
	check(
		"prepareReadQuery: expand survives the default projection",
		fromString.fields,
		"id,created,updated,collectionId,collectionName,title,published,author,tags,expand.author.name",
	);
	const explicit = prepareReadQuery(ctx, { expand: "author", fields: "id,title" }, "id");
	check(
		"prepareReadQuery: explicit options.fields wins over the select() preset",
		[explicit.expand, explicit.fields],
		["author", "id,title,author,expand.author"],
	);
	check(
		"prepareReadQuery: no schema, no expand → no query params at all",
		(() => {
			const r = prepareReadQuery(bare, {}, undefined);
			return [r.expand, r.fields, r.narrow.size];
		})(),
		[undefined, undefined, 0],
	);
}

console.log(
	failures === 0
		? "\n✅ All query normalisation tests passed"
		: `\n❌ ${failures} query normalisation test(s) failed`,
);
if (failures > 0) process.exitCode = 1;
