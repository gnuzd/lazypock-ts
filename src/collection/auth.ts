// ── Collection auth routes ──────────────────────────────
// Password, refresh, OAuth2 and the email/verification flows for a single auth
// collection. Kept out of the CRUD service: these only need a transport, the
// collection name and the session store.

import { ApiError } from "../types";
import type { ApiRecord, RequestOptions } from "../types";
import { collectionPath } from "./paths";
import {
	postWithSession,
	rememberSessionRecord,
	type AuthResponse,
	type SessionContext,
} from "./session";
import {
	authorizeWithOAuth2Popup,
	oauth2RedirectOrigin,
	DEFAULT_OAUTH2_TIMEOUT_MS,
	type AuthMethodsList,
	type OAuth2Options,
	type OAuth2AuthCodeOptions,
	type RecordAuth,
} from "../oauth2";

/**
 * Authenticate with email/password against this auth collection.
 * Stores the returned token and user model in the auth store.
 */
export function authWithPassword(
	ctx: SessionContext,
	identity: string,
	password: string,
	options?: RequestOptions,
): Promise<AuthResponse | null> {
	return postWithSession<AuthResponse>(
		ctx,
		collectionPath(ctx.collectionName) + "/auth-with-password",
		{ identity, password },
		options,
	);
}

/**
 * Refresh the auth token for the currently authenticated user.
 * Updates the stored token and user model.
 */
export function authRefresh(
	ctx: SessionContext,
	options?: RequestOptions,
): Promise<AuthResponse | null> {
	return postWithSession<AuthResponse>(
		ctx,
		collectionPath(ctx.collectionName) + "/auth-refresh",
		{ refreshToken: ctx.authStore?.refreshToken },
		options,
	);
}

/**
 * Get available auth methods for this collection (PocketBase `listAuthMethods`).
 * Returns `password`, `oauth2.providers` (each with `name`, `authURL`,
 * `state`, `codeVerifier`), and `mfa`.
 */
export function listAuthMethods(
	ctx: SessionContext,
	options?: RequestOptions,
): Promise<AuthMethodsList | null> {
	return ctx.http.get<AuthMethodsList>(
		collectionPath(ctx.collectionName) + "/auth-methods",
		options,
	);
}

// ── Email / Verification / Password Reset (PocketBase parity) ──

/**
 * Send a password reset email to the given address (PocketBase
 * `requestPasswordReset`). The backend always answers 204 to avoid
 * revealing whether the address exists.
 */
export async function requestPasswordReset(
	ctx: SessionContext,
	email: string,
	options?: RequestOptions,
): Promise<boolean> {
	await ctx.http.post(
		collectionPath(ctx.collectionName) + "/request-password-reset",
		{ email },
		options,
	);
	return true;
}

/**
 * Confirm a password reset (PocketBase `confirmPasswordReset`).
 *
 * @param passwordResetToken The token emailed by `requestPasswordReset`.
 * @param password The new password (min 8 chars server-side).
 * @param passwordConfirm Must equal `password`.
 */
export async function confirmPasswordReset(
	ctx: SessionContext,
	passwordResetToken: string,
	password: string,
	passwordConfirm: string,
	options?: RequestOptions,
): Promise<boolean> {
	await ctx.http.post(
		collectionPath(ctx.collectionName) + "/confirm-password-reset",
		{ token: passwordResetToken, password, passwordConfirm },
		options,
	);
	return true;
}

/**
 * Send a verification email to the given address (PocketBase
 * `requestVerification`). The backend always answers 204 to avoid
 * revealing whether the address exists.
 */
export async function requestVerification(
	ctx: SessionContext,
	email: string,
	options?: RequestOptions,
): Promise<boolean> {
	await ctx.http.post(
		collectionPath(ctx.collectionName) + "/request-verification",
		{ email },
		options,
	);
	return true;
}

/**
 * Confirm an email verification (PocketBase `confirmVerification`).
 * Resolves with the verified auth record.
 */
export async function confirmVerification<T>(
	ctx: SessionContext,
	verificationToken: string,
	options?: RequestOptions,
): Promise<T | null> {
	const data = await ctx.http.post<{ record: ApiRecord }>(
		collectionPath(ctx.collectionName) + "/confirm-verification",
		{ token: verificationToken },
		options,
	);
	return (data?.record as T | undefined) ?? null;
}

/**
 * Send an email-change confirmation email to a new address (PocketBase
 * `requestEmailChange`). Requires an authenticated auth-collection user.
 */
export async function requestEmailChange(
	ctx: SessionContext,
	newEmail: string,
	options?: RequestOptions,
): Promise<boolean> {
	await ctx.http.post(
		collectionPath(ctx.collectionName) + "/request-email-change",
		{ newEmail },
		options,
	);
	return true;
}

/**
 * Confirm an email change (PocketBase `confirmEmailChange`). Requires the
 * currently authenticated user's password. Resolves with the updated auth
 * record.
 */
export async function confirmEmailChange<T>(
	ctx: SessionContext,
	emailChangeToken: string,
	password: string,
	options?: RequestOptions,
): Promise<T | null> {
	const data = await ctx.http.post<{ record: ApiRecord }>(
		collectionPath(ctx.collectionName) + "/confirm-email-change",
		{ token: emailChangeToken, password },
		options,
	);
	return (data?.record as T | undefined) ?? null;
}

// ── OAuth2 ──

/**
 * Sign in with an OAuth2 provider (PocketBase `authWithOAuth2` parity).
 *
 * One call handles the whole web flow: fetch the provider's `authURL`, open a
 * popup (or call `options.urlCallback`), receive the single-use authorization
 * `code` the backend relays via `postMessage`, exchange it, populate the auth
 * store, and resolve with `{ token, record, meta }`.
 *
 * `options.createData` is forwarded on first sign-up (the exchange goes
 * through {@link authWithOAuth2Code}), matching PocketBase.
 *
 * React Native / non-browser: the popup flow depends on
 * `window.postMessage`. Use {@link listAuthMethods} + {@link authWithOAuth2Code}
 * instead.
 */
export async function authWithOAuth2<T>(
	ctx: SessionContext,
	options: OAuth2Options,
): Promise<RecordAuth<T>> {
	const {
		provider,
		createData,
		urlCallback,
		popup,
		timeoutMs = DEFAULT_OAUTH2_TIMEOUT_MS,
	} = options;

	const methods = await listAuthMethods(ctx);
	const providerInfo = methods?.oauth2?.providers?.find(
		(p) => p.name === provider,
	);
	if (!providerInfo) {
		throw new ApiError(
			`OAuth2 provider "${provider}" is not enabled for this collection.`,
			methods ?? {},
			400,
			false,
			"oauth2_unknown_provider",
		);
	}

	// The redirect page relays only the authorization code (never a token).
	// Exchange it through the shared code path so `createData` is forwarded
	// and the auth store is populated in one place.
	const { code } = await authorizeWithOAuth2Popup({
		authURL: providerInfo.authURL,
		expectedOrigin: oauth2RedirectOrigin(ctx.http.baseUrl),
		urlCallback,
		popup,
		timeoutMs,
	});

	return authWithOAuth2Code<T>(ctx, {
		provider,
		code,
		codeVerifier: providerInfo.codeVerifier,
		createData,
	});
}

/**
 * Exchange an OAuth2 authorization code directly (PocketBase
 * `authWithOAuth2Code` parity).
 *
 * Used by mobile / non-browser flows: fetch {@link listAuthMethods} to get
 * the provider `authURL` + `codeVerifier`, present the URL yourself,
 * capture the `code` from your redirect/deep link, then call this to
 * finish and populate the auth store.
 */
export async function authWithOAuth2Code<T>(
	ctx: SessionContext,
	options: OAuth2AuthCodeOptions,
): Promise<RecordAuth<T>> {
	const { provider, code, codeVerifier, redirectUrl, createData } = options;

	const data = await ctx.http.post<RecordAuth<ApiRecord>>(
		collectionPath(ctx.collectionName) + "/auth-with-oauth2",
		{
			provider,
			code,
			codeVerifier,
			redirectUrl: redirectUrl ?? ctx.http.baseUrl + "/oauth2-redirect",
			createData: createData ?? {},
		},
	);

	if (!data) {
		throw new ApiError(
			"OAuth2 code exchange returned no data.",
			{},
			0,
			false,
			"oauth2_exchange_failed",
		);
	}

	rememberSessionRecord(ctx, data as unknown as Record<string, unknown>);
	// SAFETY: `data.record` is the server's auth record for this collection;
	// it satisfies `T` at runtime — `T` is a compile-time lens only.
	return data as unknown as RecordAuth<T>;
}