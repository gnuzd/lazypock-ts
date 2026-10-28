// ── CRUD + query serialisation ──────────────────────────
// Every read funnels through getList/getOne, so these tests pin the request
// shape (path, pagination, query params) and the option→transport split.

import { describe, expect, test } from "bun:test";
import { makeService, listPage, pathOf, queryOf } from "./helpers";
import type { RecordedCall } from "./helpers";

describe("paths", () => {
	test("encodes the collection name and record id", async () => {
		const { svc, calls } = makeService({
			name: "blog-posts",
			reply: () => ({ id: "1" }),
		});
		await svc.getOne("a/b c");
		expect(pathOf(calls[0].path)).toBe("/collections/blog-posts/records/a%2Fb%20c");
	});

	test("getList, create, update, delete target the records endpoint", async () => {
		const { svc, calls } = makeService({ reply: () => ({ id: "1" }) });
		await svc.getList();
		await svc.create({ title: "x" });
		await svc.update("1", { title: "y" });
		await svc.delete("1");
		expect(calls.map((c: RecordedCall) => [c.method, pathOf(c.path)])).toEqual([
			["GET", "/collections/posts/records"],
			["POST", "/collections/posts/records"],
			["PATCH", "/collections/posts/records/1"],
			["DELETE", "/collections/posts/records/1"],
		]);
	});
});

describe("getList", () => {
	test("sends page and perPage", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(2, 10);
		const q = queryOf(calls[0].path);
		expect(q.get("page")).toBe("2");
		expect(q.get("perPage")).toBe("10");
	});

	test("defaults to page 1, perPage 30", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList();
		const q = queryOf(calls[0].path);
		expect(q.get("page")).toBe("1");
		expect(q.get("perPage")).toBe("30");
	});

	test("joins the array forms of sort and expand", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, { sort: ["-created", "title"], expand: ["owner"] });
		const q = queryOf(calls[0].path);
		expect(q.get("sort")).toBe("-created,title");
		expect(q.get("expand")).toBe("owner");
	});

	test("resolves a filter callback through the typed where helper", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, {
			filter: (w) => w("title").contains("x").and(w("id").in(["a", "b"])),
		});
		expect(queryOf(calls[0].path).get("filter")).toBe(
			"(title ~ 'x' && (id = 'a' || id = 'b'))",
		);
	});

	test("passes a raw filter string through untouched", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, { filter: "title = 'x'" });
		expect(queryOf(calls[0].path).get("filter")).toBe("title = 'x'");
	});

	test("serialises a pre-built FilterExpr", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, { filter: svc.where("title").eq("x") });
		expect(queryOf(calls[0].path).get("filter")).toBe("title = 'x'");
	});

	test("keeps transport options out of the query string", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, {
			requestKey: "k",
			headers: { "X-Test": "1" },
			singleFlight: true,
		});
		const q = queryOf(calls[0].path);
		for (const key of ["requestKey", "headers", "singleFlight", "fetch", "signal"]) {
			expect(q.has(key)).toBe(false);
		}
		// …and still hands them to the transport layer.
		expect((calls[0].options as { requestKey?: string }).requestKey).toBe("k");
	});

	test("passes unknown keys through as raw query params", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getList(1, 30, { skipTotal: 1 });
		expect(queryOf(calls[0].path).get("skipTotal")).toBe("1");
	});
});

describe("getFullList", () => {
	test("auto-paginates until the last page", async () => {
		const { svc, calls } = makeService({
			reply: (path) => {
				const page = Number(queryOf(path).get("page"));
				return listPage([{ id: `p${page}` }], 3, page);
			},
		});
		const items = await svc.getFullList();
		expect(items).toEqual([{ id: "p1" }, { id: "p2" }, { id: "p3" }]);
		expect(calls.length).toBe(3);
	});

	test("stops on an empty page even if totalPages is larger", async () => {
		const { svc, calls } = makeService({
			reply: (path) =>
				Number(queryOf(path).get("page")) === 1
					? listPage([{ id: "a" }], 99, 1)
					: listPage([], 99, 2),
		});
		expect(await svc.getFullList()).toEqual([{ id: "a" }]);
		expect(calls.length).toBe(2);
	});

	test("defaults the batch to the server maximum (500)", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getFullList();
		expect(queryOf(calls[0].path).get("perPage")).toBe("500");
	});

	test("clamps an oversized batch instead of sending it", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getFullList({ batch: 10_000 });
		expect(queryOf(calls[0].path).get("perPage")).toBe("500");
	});

	test("shares one request key across pages, but single-flights the fetch", async () => {
		const { svc, calls } = makeService({
			reply: (path) => {
				const page = Number(queryOf(path).get("page"));
				return listPage([{ id: `p${page}` }], 2, page);
			},
		});
		await svc.getFullList();
		const keys = calls.map(
			(c: RecordedCall) => (c.options as { requestKey?: string }).requestKey,
		);
		expect(new Set(keys).size).toBe(1);
		expect((calls[0].options as { singleFlight?: boolean }).singleFlight).toBe(true);
	});

	test("honours a caller-supplied requestKey", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getFullList({ requestKey: "custom" });
		expect((calls[0].options as { requestKey?: string }).requestKey).toBe("custom");
	});

	test("does not leak the batch option into the query string", async () => {
		const { svc, calls } = makeService({ reply: () => listPage([]) });
		await svc.getFullList({ batch: 50 });
		expect(queryOf(calls[0].path).has("batch")).toBe(false);
	});
});

describe("getFirstListItem", () => {
	test("asks for exactly one record and returns it", async () => {
		const { svc, calls } = makeService({
			reply: () => ({ items: [{ id: "a" }], page: 1, perPage: 1, totalItems: 1, totalPages: 1 }),
		});
		const rec = await svc.getFirstListItem("title = 'x'");
		expect(rec).toEqual({ id: "a" });
		const q = queryOf(calls[0].path);
		expect(q.get("perPage")).toBe("1");
		expect(q.get("filter")).toBe("title = 'x'");
	});

	test("returns null when nothing matches", async () => {
		const { svc } = makeService({ reply: () => listPage([]) });
		expect(await svc.getFirstListItem("title = 'x'")).toBeNull();
	});
});

describe("expandFields", () => {
	test("lists relation fields and their targets", async () => {
		const { svc, calls } = makeService({
			reply: () => ({
				fields: [
					{ name: "title", type: "text" },
					{ name: "owner", type: "relation", options: { collection: "users" } },
				],
			}),
		});
		const res = await svc.expandFields();
		expect(res).toEqual([{ field: "owner", targetCollection: "users" }]);
		expect(pathOf(calls[0].path)).toBe("/collections/posts");
	});
});