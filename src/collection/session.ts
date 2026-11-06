// ── Auth responses & session recording ──────────────────
// One place that turns a server auth response into a stored session. Every
// auth route (password, refresh, OAuth2, superuser login) goes through it, so
// the refresh token and the real `expiresIn` can never be dropped again.

import {
	rememberAuthResponse,
	type AuthModel,
	type AuthStore,
} from "../auth";
import type { HttpClient } from "../http";
import type { ApiRecord, RequestOptions } from "../types";

/**
 * The shape of a successful auth response: Pancake/PocketBase auth routes
 * return a token plus the authenticated record.
 */
export type AuthResponse = { token: string; record: ApiRecord } & Record<
	string,
	unknown
>;

/** What the auth routes need: a transport, the collection, and the store. */
export interface SessionContext {
	http: HttpClient;
	/** The auth collection this session belongs to. */
	collectionName: string;
	/** Where the session is recorded. When absent, the response is returned only. */
	authStore?: AuthStore;
}

/**
 * Record an auth response in the store: the collection name, the access token,
 * the refresh token and the access token's real lifetime.
 *
 * `model` is explicit because a superuser session has no record — it is stored
 * with a `null` model and no collection name.
 */
export function rememberSession(
	ctx: SessionContext,
	data: Record<string, unknown> | null | undefined,
	model: AuthModel | null,
): void {
	if (!data || !ctx.authStore) return;
	ctx.authStore.setCollectionName(ctx.collectionName);
	rememberAuthResponse(ctx.authStore, data, model);
}

/** Record the auth response's own `record` field as the session model. */
export function rememberSessionRecord(
	ctx: SessionContext,
	data: Record<string, unknown> | null | undefined,
): void {
	const record = data?.["record"];
	// SAFETY: the server's auth response record is a superset of AuthModel;
	// the auth store consumes it generically.
	const model =
		record && typeof record === "object" ? (record as AuthModel) : null;
	rememberSession(ctx, data, model);
}

/**
 * POST an auth route and record the resulting session.
 *
 * @param path Route suffix appended to the collection path (e.g. `auth-refresh`).
 */
export async function postWithSession<T extends Record<string, unknown>>(
	ctx: SessionContext,
	path: string,
	body: unknown,
	options?: RequestOptions,
): Promise<T | null> {
	const data = await ctx.http.post<T>(path, body, options);
	rememberSessionRecord(ctx, data);
	return data;
}