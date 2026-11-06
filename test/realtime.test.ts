// ── Collection realtime subscriptions ───────────────────
// Topic naming, event normalisation and the accepted argument forms.

import { describe, expect, test } from "bun:test";
import type { RealtimeService } from "../src/realtime";
import {
	normalizeAction,
	subscribeToCollection,
	unsubscribeFromCollection,
} from "../src/collection/realtime";

interface Sub {
	topic: string;
	handler: (e: {
		event: string;
		topic: string;
		payload?: Record<string, unknown>;
	}) => void;
	joinPayload?: Record<string, unknown>;
}

function fakeRealtime() {
	const subs: Sub[] = [];
	const events: string[] = [];
	const realtime = {
		ensureConnected() {
			events.push("ensureConnected");
		},
		subscribe(topic: string, handler: Sub["handler"], joinPayload?: Record<string, unknown>) {
			subs.push({ topic, handler, joinPayload });
		},
		unsubscribe(topic: string, handler?: Sub["handler"]) {
			events.push(`unsubscribe:${topic}`);
			const i = subs.findIndex((s) => s.topic === topic && s.handler === handler);
			if (i >= 0) subs.splice(i, 1);
		},
		unsubscribeByPrefix(prefix: string) {
			events.push(`unsubscribeByPrefix:${prefix}`);
		},
	} as unknown as RealtimeService;
	return { realtime, subs, events };
}

const ctx = (realtime: RealtimeService) => ({ realtime, collectionName: "posts" });

describe("subscribe", () => {
	test("subscribes to the collection topic and connects", () => {
		const { realtime, subs, events } = fakeRealtime();
		subscribeToCollection(ctx(realtime), () => {});
		expect(subs[0].topic).toBe("collection:posts");
		expect(events).toContain("ensureConnected");
	});

	test("subscribe(recordId, cb) targets one record", () => {
		const { realtime, subs } = fakeRealtime();
		subscribeToCollection(ctx(realtime), "abc", () => {});
		expect(subs[0].topic).toBe("collection:posts:abc");
	});

	test("subscribe('*', cb) is the whole collection", () => {
		const { realtime, subs } = fakeRealtime();
		subscribeToCollection(ctx(realtime), "*", () => {});
		expect(subs[0].topic).toBe("collection:posts");
	});

	test("the deprecated callback-first form still works", () => {
		const { realtime, subs } = fakeRealtime();
		const cb = () => {};
		subscribeToCollection(ctx(realtime), cb, "abc");
		expect(subs[0].topic).toBe("collection:posts:abc");
	});

	test("forwards join options but not HTTP headers", () => {
		const { realtime, subs } = fakeRealtime();
		subscribeToCollection(ctx(realtime), "*", () => {}, {
			expand: "owner",
			headers: { "X-Test": "1" },
		});
		expect(subs[0].joinPayload).toEqual({ expand: "owner" });
	});

	test("normalises the payload into { action, record, topic }", () => {
		const { realtime, subs } = fakeRealtime();
		const received: unknown[] = [];
		subscribeToCollection(ctx(realtime), (e) => received.push(e));
		subs[0].handler({
			event: "record_change",
			topic: "collection:posts",
			payload: { action: "create", record: { id: "1" } },
		});
		expect(received[0]).toEqual({
			action: "create",
			record: { id: "1" },
			topic: "collection:posts",
		});
	});

	test("returns an unsubscribe function for that handler only", () => {
		const { realtime, subs, events } = fakeRealtime();
		const stop = subscribeToCollection(ctx(realtime), () => {});
		stop();
		expect(subs.length).toBe(0);
		expect(events.at(-1)).toBe("unsubscribe:collection:posts");
	});

	test("warns and no-ops without a realtime service", () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
		try {
			const stop = subscribeToCollection({ collectionName: "posts" }, () => {});
			expect(typeof stop).toBe("function");
			expect(warnings[0]).toContain("No realtime service configured");
		} finally {
			console.warn = original;
		}
	});
});

describe("unsubscribe", () => {
	test("no argument removes every subscription of the collection", () => {
		const { realtime, events } = fakeRealtime();
		unsubscribeFromCollection(ctx(realtime));
		expect(events).toEqual(["unsubscribeByPrefix:collection:posts"]);
	});

	test("'*' removes the wildcard topic", () => {
		const { realtime, events } = fakeRealtime();
		unsubscribeFromCollection(ctx(realtime), "*");
		expect(events).toEqual(["unsubscribe:collection:posts"]);
	});

	test("a record id removes that record's topic", () => {
		const { realtime, events } = fakeRealtime();
		unsubscribeFromCollection(ctx(realtime), "abc");
		expect(events).toEqual(["unsubscribe:collection:posts:abc"]);
	});
});

describe("normalizeAction", () => {
	test("prefers the payload action", () => {
		expect(normalizeAction("record_change", "DELETE")).toBe("delete");
	});

	test("falls back to the event name", () => {
		expect(normalizeAction("record_create")).toBe("create");
		expect(normalizeAction("record_delete")).toBe("delete");
		expect(normalizeAction("record_change")).toBe("update");
	});

	test("defaults to update for anything unrecognised", () => {
		expect(normalizeAction("whatever")).toBe("update");
	});
});