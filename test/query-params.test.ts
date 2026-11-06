// ── Shared request-key helpers ──────────────────────────
// `stableStringify` is the dedup key for single-flight/caching, so two option
// bags that are structurally different must never hash the same.

import { describe, expect, test } from "bun:test";
import { MAX_PER_PAGE, clampBatch, stableStringify } from "../src/query-params";

describe("clampBatch", () => {
	test("keeps an in-range batch", () => {
		expect(clampBatch(50)).toBe(50);
	});

	test("caps at the server maximum", () => {
		expect(clampBatch(MAX_PER_PAGE + 1)).toBe(MAX_PER_PAGE);
	});

	test("floors at 1", () => {
		expect(clampBatch(0)).toBe(1);
		expect(clampBatch(-5)).toBe(1);
	});

	test("floors fractional values", () => {
		expect(clampBatch(20.9)).toBe(20);
	});

	test("falls back to the maximum for non-finite input", () => {
		expect(clampBatch(Number.NaN)).toBe(MAX_PER_PAGE);
		expect(clampBatch(Number.POSITIVE_INFINITY)).toBe(MAX_PER_PAGE);
	});
});

describe("stableStringify", () => {
	test("is insensitive to key order", () => {
		expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
	});

	test("strips request-transport keys at the top level", () => {
		const withTransport = { a: 1, requestKey: "x", singleFlight: true, signal: {} };
		expect(stableStringify(withTransport)).toBe(stableStringify({ a: 1 }));
	});

	test("keeps a payload field that happens to be named like a transport key", () => {
		// A record field called `signal` is data, not transport.
		expect(stableStringify({ data: { signal: "up" } })).not.toBe(
			stableStringify({ data: {} }),
		);
	});

	test("distinguishes a shared reference from a cycle", () => {
		const shared = { title: "x" };
		const dag = { filter: shared, sort: shared };
		expect(stableStringify(dag)).not.toContain("Circular");
	});

	test("survives a genuine cycle", () => {
		const node: Record<string, unknown> = { a: 1 };
		node.self = node;
		expect(() => stableStringify(node)).not.toThrow();
	});

	test("distinguishes structurally different option bags", () => {
		const a = { filter: "x", sort: "-created" };
		const b = { filter: "x", sort: "created" };
		expect(stableStringify(a)).not.toBe(stableStringify(b));
	});
});