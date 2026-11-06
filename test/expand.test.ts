// ── Expand normalisation ────────────────────────────────
// `expand` accepts three shapes that must be told apart:
//   - plain relation        `author`            → expand=author
//   - nested relation       `author.manager`    → expand=author,author.manager
//   - field selection       `owner.name`        → expand=owner + fields=expand.owner.name
// The third is rewritten because the servers silently ignore `expand=owner.name`.

import { describe, expect, test } from "bun:test";
import { captureWarnings, makeService, queryOf, tokens } from "./helpers";
import { POSTS_SCHEMA, USERS_SCHEMA } from "./helpers";
import type { CollectionSchema } from "../src/schema";

const SCHEMAS = [POSTS_SCHEMA, USERS_SCHEMA];

describe("plain relations", () => {
	test("sends the relation and keeps expand.<key> alive under projection", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.getList(1, 30, { expand: "owner" });
		const q = queryOf(calls[0].path);
		expect(q.get("expand")).toBe("owner");
		// no schema → no fields param at all (server keeps expand by default)
		expect(q.has("fields")).toBe(false);
	});

	test("under an active projection, adds both the field and expand.<key>", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.select("id", "title").getList(1, 30, { expand: "owner" });
		const fields = tokens(queryOf(calls[0].path).get("fields"));
		expect(fields).toEqual(["expand.owner", "id", "owner", "title"]);
	});

	test("accepts the array form", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.getList(1, 30, { expand: ["owner"] });
		expect(queryOf(calls[0].path).get("expand")).toBe("owner");
	});
});

describe("nested relations", () => {
	test("emits every relation prefix so one-level servers still resolve", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.getList(1, 30, { expand: "owner.manager" });
		expect(tokens(queryOf(calls[0].path).get("expand"))).toEqual([
			"owner",
			"owner.manager",
		]);
	});

	test("warns about a dotted token it cannot disambiguate without a schema", async () => {
		const { svc } = makeService();
		const warnings = await captureWarnings(() =>
			svc.getList(1, 30, { expand: "owner.manager" }),
		);
		expect(warnings.some((w) => w.includes("nested relation"))).toBe(true);
	});
});

describe("field selection on expanded records", () => {
	test("rewrites owner.name,owner.email into expand + fields selectors", async () => {
		const { svc, calls } = makeService({
			schemas: SCHEMAS,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		await svc.select("id").getList(1, 30, { expand: "owner.name,owner.email" });
		const q = queryOf(calls[0].path);
		expect(q.get("expand")).toBe("owner");
		const fields = tokens(q.get("fields"));
		// The relation field itself must survive strict projection…
		expect(fields).toContain("owner");
		// …along with the per-field selectors that keep the expand payload.
		expect(fields).toContain("expand.owner.name");
		expect(fields).toContain("expand.owner.email");
	});

	test("narrows the expanded record client-side", async () => {
		const { svc } = makeService({
			schemas: SCHEMAS,
			reply: () => ({
				items: [
					{
						id: "1",
						owner: "u1",
						expand: { owner: { id: "u1", name: "Ada", email: "ada@example.com" } },
					},
				],
				totalPages: 1,
			}),
		});
		const res = await svc.select("id").getList(1, 30, { expand: "owner.name" });
		expect(res!.items[0].expand).toEqual({ owner: { name: "Ada" } });
	});

	test("narrows multi-relations element-wise", async () => {
		const schema: CollectionSchema = {
			name: "posts",
			type: "base",
			fields: [
				{ name: "tags", type: "relation", options: { collection: "users", maxSelect: 5 } },
			],
		};
		const { svc } = makeService({
			schemas: [schema, USERS_SCHEMA],
			reply: () => ({
				items: [
					{ id: "1", expand: { tags: [{ id: "a", name: "x" }, { id: "b", name: "y" }] } },
				],
				totalPages: 1,
			}),
		});
		const res = await svc.getList(1, 30, { expand: "tags.name" });
		expect(res!.items[0].expand).toEqual({ tags: [{ name: "x" }, { name: "y" }] });
	});

	test("leaves a record untouched when the server already narrowed it", async () => {
		const { svc } = makeService({
			schemas: SCHEMAS,
			reply: () => ({
				items: [{ id: "1", expand: { owner: { name: "Ada" } } }],
				totalPages: 1,
			}),
		});
		const res = await svc.getList(1, 30, { expand: "owner.name" });
		expect(res!.items[0].expand).toEqual({ owner: { name: "Ada" } });
	});

	test("returns a null/undefined expand unchanged", async () => {
		const { svc } = makeService({
			schemas: SCHEMAS,
			reply: () => ({ items: [{ id: "1" }], totalPages: 1 }),
		});
		const res = await svc.getList(1, 30, { expand: "owner.name" });
		expect(res!.items[0]).toEqual({ id: "1" });
	});

	test("applies to getOne as well", async () => {
		const { svc, calls } = makeService({
			schemas: SCHEMAS,
			reply: () => ({ id: "1", expand: { owner: { id: "u1", name: "Ada" } } }),
		});
		const rec = await svc.getOne("1", { expand: "owner.name" });
		expect(queryOf(calls[0].path).get("expand")).toBe("owner");
		expect(rec!.expand).toEqual({ owner: { name: "Ada" } });
	});
});

describe("invalid expand targets", () => {
	test("warns when the field is not a relation, and still sends it", async () => {
		const { svc, calls } = makeService({
			schema: POSTS_SCHEMA,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		const warnings = await captureWarnings(() =>
			svc.getList(1, 30, { expand: "title" }),
		);
		expect(warnings.some((w) => w.includes("not a relation"))).toBe(true);
		expect(queryOf(calls[0].path).get("expand")).toBe("title");
	});

	test("an unknown dotted path with a known schema is treated as field selection", async () => {
		// `owner` is a relation, `nickname` is not a field of users → still a
		// field selection (the schema graph ran out at `owner`).
		const { svc, calls } = makeService({
			schemas: SCHEMAS,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		await svc.getList(1, 30, { expand: "owner.nickname" });
		expect(queryOf(calls[0].path).get("expand")).toBe("owner");
	});
});