// ── Field projection (`select`) ─────────────────────────
// Covers the strict-projection rules both servers are built around:
// system keys must always be requested, hidden/password/autodate fields must
// never be, and an explicit projection overrides the schema default.

import { describe, expect, test } from "bun:test";
import { captureWarnings, makeService, queryOf, tokens } from "./helpers";
import { POSTS_SCHEMA } from "./helpers";

const SYSTEM = ["collectionId", "collectionName", "created", "id", "updated"];

describe("default projection", () => {
	test("sends no fields param when no schema is known", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.getList();
		expect(queryOf(calls[0].path).has("fields")).toBe(false);
	});

	test("includes every system key plus visible fields when a schema is known", async () => {
		const { svc, calls } = makeService({
			schema: POSTS_SCHEMA,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		await svc.getList();
		const fields = tokens(queryOf(calls[0].path).get("fields"));
		expect(fields).toEqual([...SYSTEM, "owner", "title"].sort());
	});

	test("excludes hidden, password and autodate fields", async () => {
		const { svc, calls } = makeService({
			schema: POSTS_SCHEMA,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		await svc.getList();
		const fields = tokens(queryOf(calls[0].path).get("fields"));
		expect(fields).not.toContain("secret");
		expect(fields).not.toContain("password");
	});

	test("applies to getOne too", async () => {
		const { svc, calls } = makeService({ schema: POSTS_SCHEMA, reply: () => ({ id: "1" }) });
		await svc.getOne("1");
		expect(tokens(queryOf(calls[0].path).get("fields"))).toContain("title");
	});
});

describe("select()", () => {
	test("projects to the requested fields only", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.select("id", "title").getList();
		expect(tokens(queryOf(calls[0].path).get("fields"))).toEqual(["id", "title"]);
	});

	test('select("*") restores the schema default', async () => {
		const { svc, calls } = makeService({
			schema: POSTS_SCHEMA,
			reply: () => ({ items: [], totalPages: 1 }),
		});
		await svc.select("*").getList();
		const fields = tokens(queryOf(calls[0].path).get("fields"));
		expect(fields).toContain("title");
		expect(fields).toContain("collectionId");
	});

	test("does not mutate the original service", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		svc.select("title");
		await svc.getList();
		expect(queryOf(calls[0].path).has("fields")).toBe(false);
	});

	test("an explicit options.fields wins over the select() preset", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.select("title").getList(1, 30, { fields: "id" });
		expect(tokens(queryOf(calls[0].path).get("fields"))).toEqual(["id"]);
	});

	test("does not warn for system keys that are absent from the schema", async () => {
		const { svc } = makeService({ schema: POSTS_SCHEMA });
		const warnings = await captureWarnings(() =>
			svc.select("id", "created", "updated", "collectionId", "collectionName", "title"),
		);
		expect(warnings).toEqual([]);
	});

	test("warns once for a genuinely unknown field", async () => {
		const { svc } = makeService({ schema: POSTS_SCHEMA });
		const warnings = await captureWarnings(() => svc.select("nope"));
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("nope");
	});

	test("withSchema() keeps the active select() preset", async () => {
		const { svc, calls } = makeService({ reply: () => ({ items: [], totalPages: 1 }) });
		await svc.select("title").withSchema(POSTS_SCHEMA).getList();
		expect(tokens(queryOf(calls[0].path).get("fields"))).toEqual(["title"]);
	});
});