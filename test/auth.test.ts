// ── Auth routes → session store ─────────────────────────
// Every auth route funnels through one session recorder, so the refresh token
// and the access token's real lifetime can never be dropped. These tests pin
// the route, the body and the stored session.

import { describe, expect, test } from "bun:test";
import { AuthStore } from "../src/auth";
import { pathOf, stubHttp } from "./helpers";
import { LazypockClient } from "../src/lazypock";
import * as auth from "../src/collection/auth";

function ctx(reply: (path: string) => unknown, collectionName = "users") {
	const { http, calls } = stubHttp((path) => reply(path));
	const store = new AuthStore();
	return { ctx: { http, collectionName, authStore: store }, calls, store };
}

const AUTH_OK = {
	token: "access-1",
	refreshToken: "refresh-1",
	expiresIn: 900,
	record: { id: "u1", collectionName: "users", email: "ada@example.com" },
};

describe("authWithPassword", () => {
	test("posts the credentials to the collection's auth route", async () => {
		const { ctx: c, calls } = ctx(() => AUTH_OK);
		await auth.authWithPassword(c, "ada@example.com", "secret");
		expect(calls[0].method).toBe("POST");
		expect(pathOf(calls[0].path)).toBe("/collections/users/auth-with-password");
		expect(calls[0].body).toEqual({
			identity: "ada@example.com",
			password: "secret",
		});
	});

	test("records token, refresh token, model and collection", async () => {
		const { ctx: c, store } = ctx(() => AUTH_OK);
		await auth.authWithPassword(c, "ada@example.com", "secret");
		expect(store.token).toBe("access-1");
		expect(store.refreshToken).toBe("refresh-1");
		expect(store.collectionName).toBe("users");
		expect(store.model?.id).toBe("u1");
		expect(store.isExpired).toBe(false);
	});

	test("returns the raw response", async () => {
		const { ctx: c } = ctx(() => AUTH_OK);
		const res = await auth.authWithPassword(c, "ada@example.com", "secret");
		expect(res?.token).toBe("access-1");
	});
});

describe("authRefresh", () => {
	test("sends the stored refresh token", async () => {
		const { ctx: c, calls, store } = ctx(() => AUTH_OK);
		await auth.authWithPassword(c, "ada@example.com", "secret");
		calls.length = 0;
		await auth.authRefresh(c);
		expect(pathOf(calls[0].path)).toBe("/collections/users/auth-refresh");
		expect(calls[0].body).toEqual({ refreshToken: "refresh-1" });
		expect(store.token).toBe("access-1");
	});
});

describe("email flows", () => {
	test("password reset request returns true", async () => {
		const { ctx: c, calls } = ctx(() => null);
		expect(await auth.requestPasswordReset(c, "ada@example.com")).toBe(true);
		expect(pathOf(calls[0].path)).toBe("/collections/users/request-password-reset");
		expect(calls[0].body).toEqual({ email: "ada@example.com" });
	});

	test("password reset confirm posts token + passwords", async () => {
		const { ctx: c, calls } = ctx(() => null);
		await auth.confirmPasswordReset(c, "tok", "newpass1", "newpass1");
		expect(pathOf(calls[0].path)).toBe("/collections/users/confirm-password-reset");
		expect(calls[0].body).toEqual({
			token: "tok",
			password: "newpass1",
			passwordConfirm: "newpass1",
		});
	});

	test("verification confirm resolves with the record", async () => {
		const { ctx: c } = ctx(() => ({ record: { id: "u1", verified: true } }));
		expect(await auth.confirmVerification(c, "tok")).toEqual({
			id: "u1",
			verified: true,
		});
	});

	test("email change request/confirm use their routes", async () => {
		const { ctx: c, calls } = ctx(() => ({ record: { id: "u1" } }));
		await auth.requestEmailChange(c, "new@example.com");
		await auth.confirmEmailChange(c, "tok", "pw");
		expect(calls.map((x) => pathOf(x.path))).toEqual([
			"/collections/users/request-email-change",
			"/collections/users/confirm-email-change",
		]);
	});
});

describe("OAuth2", () => {
	test("code exchange posts and records the session", async () => {
		const { ctx: c, calls, store } = ctx(() => AUTH_OK);
		await auth.authWithOAuth2Code(c, {
			provider: "github",
			code: "code-1",
			codeVerifier: "verifier-1",
		});
		expect(pathOf(calls[0].path)).toBe("/collections/users/auth-with-oauth2");
		expect(calls[0].body).toMatchObject({
			provider: "github",
			code: "code-1",
			codeVerifier: "verifier-1",
		});
		expect(store.refreshToken).toBe("refresh-1");
	});

	test("throws a coded ApiError when the exchange returns nothing", async () => {
		const { ctx: c } = ctx(() => null);
		await expect(
			auth.authWithOAuth2Code(c, {
				provider: "github",
				code: "c",
				codeVerifier: "v",
			}),
		).rejects.toMatchObject({ code: "oauth2_exchange_failed" });
	});
});

describe("LazypockClient delegation", () => {
	test("login(collection, …) uses the collection service's route", async () => {
		const calls: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify(AUTH_OK), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		try {
			const client = new LazypockClient({ baseUrl: "http://api.test/api" });
			await client.login("ada@example.com", "secret", "users");
			expect(calls[0]).toBe("http://api.test/api/collections/users/auth-with-password");
			expect(client.authStore.token).toBe("access-1");
			expect(client.authStore.collectionName).toBe("users");
		} finally {
			globalThis.fetch = original;
		}
	});

	test("client.authWithPassword(collection, …) and authRefresh delegate", async () => {
		const paths: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			paths.push(new URL(String(input)).pathname);
			return new Response(JSON.stringify(AUTH_OK), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		try {
			const client = new LazypockClient({ baseUrl: "http://api.test/api" });
			await client.authWithPassword("users", "ada@example.com", "secret");
			await client.authRefresh("users");
			expect(paths).toEqual([
				"/api/collections/users/auth-with-password",
				"/api/collections/users/auth-refresh",
			]);
		} finally {
			globalThis.fetch = original;
		}
	});
});