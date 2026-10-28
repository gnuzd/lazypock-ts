// ── Test helpers ────────────────────────────────────────
// A stub HttpClient that records requests and replies with a supplied body,
// so the collection service can be exercised without a server. Assertions are
// made against the *public* surface (the URLs the SDK builds), which keeps
// these tests valid across internal refactors.

import type { HttpClient } from "../src/http";
import { CollectionService } from "../src/collection";
import type { CollectionSchema } from "../src/schema";

export interface RecordedCall {
	method: string;
	path: string;
	body?: unknown;
	options?: unknown;
}

/** A fake HttpClient. `reply` receives the raw path and returns the body. */
export function stubHttp(reply: (path: string, method: string) => unknown = () => null) {
	const calls: RecordedCall[] = [];
	const http = {
		async get(path: string, options?: unknown) {
			calls.push({ method: "GET", path, options });
			return reply(path, "GET");
		},
		async post(path: string, body?: unknown, options?: unknown) {
			calls.push({ method: "POST", path, body, options });
			return reply(path, "POST");
		},
		async patch(path: string, body?: unknown, options?: unknown) {
			calls.push({ method: "PATCH", path, body, options });
			return reply(path, "PATCH");
		},
		async put(path: string, body?: unknown, options?: unknown) {
			calls.push({ method: "PUT", path, body, options });
			return reply(path, "PUT");
		},
		async delete(path: string, options?: unknown) {
			calls.push({ method: "DELETE", path, options });
			return reply(path, "DELETE");
		},
	};
	return { http: http as unknown as HttpClient, calls };
}

/** The `/records` service wired to a stub client. */
export function makeService(opts: {
	schema?: CollectionSchema;
	schemas?: CollectionSchema[];
	reply?: (path: string, method: string) => unknown;
	name?: string;
} = {}) {
	const { http, calls } = stubHttp(opts.reply);
	const byName = new Map((opts.schemas ?? []).map((s) => [s.name, s]));
	const svc = new CollectionService(
		http,
		opts.name ?? "posts",
		undefined,
		undefined,
		// Mirror the client: an explicit schema, else the one registered by name.
		opts.schema ?? byName.get(opts.name ?? "posts"),
		(key) => byName.get(key),
	);
	return { svc, calls, http };
}

/** Parse the query string of a recorded request path. */
export function queryOf(path: string): URLSearchParams {
	const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
	return new URLSearchParams(qs);
}

/** Path without its query string. */
export function pathOf(path: string): string {
	return path.split("?")[0];
}

/** Split a comma-separated param into a sorted array (order-independent checks). */
export function tokens(param: string | null | undefined): string[] {
	if (!param) return [];
	return param
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)
		.sort();
}

/** A PocketBase/LazyPock-shaped list response. */
export function listPage(items: unknown[], totalPages = 1, page = 1) {
	return {
		items,
		page,
		perPage: 30,
		totalItems: items.length,
		totalPages,
	};
}

/** A schema whose fields deliberately omit the implicit system keys. */
export const POSTS_SCHEMA: CollectionSchema = {
	name: "posts",
	type: "base",
	fields: [
		{ name: "title", type: "text" },
		{ name: "secret", type: "text", hidden: true },
		{ name: "password", type: "password" },
		{ name: "created", type: "autodate" },
		{ name: "owner", type: "relation", options: { collection: "users", maxSelect: 1 } },
	],
};

export const USERS_SCHEMA: CollectionSchema = {
	name: "users",
	type: "auth",
	fields: [
		{ name: "email", type: "text" },
		{ name: "name", type: "text" },
		{ name: "manager", type: "relation", options: { collection: "users", maxSelect: 1 } },
	],
};

/** Capture console.warn output while `fn` runs. */
export async function captureWarnings(fn: () => unknown): Promise<string[]> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	};
	try {
		await fn();
	} finally {
		console.warn = original;
	}
	return warnings;
}