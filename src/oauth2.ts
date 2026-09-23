// ── OAuth2 — provider types + popup (postMessage) bridge ───────────
//
// The backend (`core`) drives the security-sensitive half of the flow:
//   - `GET /api/{collection}/auth-methods` returns each provider's
//     ready-to-use `authURL` (state + PKCE `codeVerifier` already embedded
//     and stored server-side, keyed by `state`).
//   - The provider redirects back to `GET /api/oauth2-redirect`, which
//     exchanges the code, links/upserts the auth record, and serves a tiny
//     page that posts the finished `{ token, record, meta }` result back to
//     the popup opener via `window.postMessage`.
//
// This means the SDK never handles `code`/`state`/`codeVerifier` for the
// popup flow — the backend owns them. The SDK's job is: fetch the provider
// list, present the `authURL`, and wait for the `postMessage` result (with
// strict `event.origin` + `event.source` validation), then populate the
// auth store exactly like every other auth method.

import { ApiError } from "./types";

/** A single configured OAuth2 provider, as returned by `auth-methods`. */
export interface AuthProviderInfo {
	/** Provider identifier (e.g. `"google"`, `"github"`). */
	name: string;
	/** Ready-to-use authorization URL (state + PKCE already embedded). */
	authURL: string;
	/** CSRF state value (generated + stored server-side). */
	state: string;
	/** PKCE code verifier (stored server-side against `state`). */
	codeVerifier: string;
	/** Human-friendly name (PocketBase parity; not returned by the backend). */
	displayName?: string;
}

/** Shape returned by `GET /api/{collection}/auth-methods`. */
export interface AuthMethodsList {
	password: boolean;
	oauth2: {
		providers: AuthProviderInfo[];
		/** Provider name → display name map (PocketBase parity). */
		displayName?: string;
	};
	mfa?: Record<string, unknown>;
}

/** The `meta` object attached to an OAuth2 auth result (PocketBase parity). */
export interface OAuth2Meta {
	/** The auth record id (not the provider's user id). */
	id: string;
	name?: string;
	email?: string;
	/** The provider's avatar URL (backend key is `avatarURL`). */
	avatarURL?: string;
	/** `true` when this sign-in created a new auth record. */
	isNew: boolean;
	/** The raw provider user object. */
	rawUser?: Record<string, unknown>;
	/** The provider's own access token, when returned. */
	accessToken?: string;
	/** The provider's own refresh token, when returned. */
	refreshToken?: string;
	/** Token expiry as returned by the provider, when available. */
	expiry?: string | number;
}

/** Auth result with an optional OAuth2 `meta` (PocketBase `AuthData` parity). */
export interface RecordAuth<T = Record<string, unknown>> {
	token: string;
	record: T;
	meta?: OAuth2Meta;
}

/** Popup geometry for {@link OAuth2Options.popup}. */
export interface OAuth2PopupOptions {
	width?: number;
	height?: number;
}

/**
 * Options for {@link CollectionService.authWithOAuth2} (the popup flow).
 *
 * `createData` is accepted for PocketBase signature parity but is **not**
 * currently forwarded by the backend's popup redirect flow (it signs up
 * with provider-derived fields only). Use {@link OAuth2AuthCodeOptions.createData}
 * via `authWithOAuth2Code` when you need extra fields on first sign-up.
 */
export interface OAuth2Options {
	/** Provider identifier (e.g. `"google"`). */
	provider: string;
	/** Extra fields for the auto-created record (see note above). */
	createData?: Record<string, unknown>;
	/**
	 * Called with the authorization URL instead of auto-opening a popup.
	 * The presented window must preserve `window.opener` (open it without
	 * `noopener`) so the `postMessage` result can reach the SDK.
	 *
	 * For React Native / non-browser environments, use
	 * `listAuthMethods()` + `authWithOAuth2Code()` instead — the popup flow
	 * depends on `window.postMessage`.
	 */
	urlCallback?: (url: string) => void | Promise<void>;
	/** Popup geometry (defaults: 500×700). */
	popup?: OAuth2PopupOptions;
	/** Abandon if no result arrives within this many ms (default 120000). */
	timeoutMs?: number;
}

/**
 * Options for {@link CollectionService.authWithOAuth2Code} — the direct
 * code exchange (PocketBase `authWithOAuth2Code` parity), used by mobile /
 * non-browser flows where the app captures the authorization `code` itself.
 */
export interface OAuth2AuthCodeOptions {
	/** Provider identifier (e.g. `"google"`). */
	provider: string;
	/** The authorization `code` captured from the redirect. */
	code: string;
	/** The PKCE code verifier from `listAuthMethods()` (`codeVerifier`). */
	codeVerifier: string;
	/**
	 * The redirect URL the code was issued for. Defaults to
	 * `{baseUrl}/oauth2-redirect` (the backend's own callback).
	 */
	redirectUrl?: string;
	/** Extra fields merged into the record on first sign-up. */
	createData?: Record<string, unknown>;
}

/** The postMessage payload the backend's redirect page sends. */
interface OAuth2RedirectMessage {
	type: "lazypock:oauth2" | "lazypock:oauth2:error";
	result: RecordAuth | { code?: number; message?: string; data?: unknown };
}

const DEFAULT_POPUP_WIDTH = 500;
const DEFAULT_POPUP_HEIGHT = 700;
/** Default abandon window for the popup flow (2 minutes). */
export const DEFAULT_OAUTH2_TIMEOUT_MS = 120_000;
const CLOSE_POLL_MS = 500;

/** Derive the backend's origin from the API base URL, for origin checks. */
export function oauth2RedirectOrigin(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		throw new ApiError(
			`Invalid baseUrl for OAuth2 origin check: "${baseUrl}"`,
			{},
			0,
			false,
			"oauth2_invalid_base_url",
		);
	}
}

/** Reject non-http(s) URLs (defense-in-depth — authURL is server-provided). */
function isSafeBrowserUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function isRecordAuth(value: unknown): value is RecordAuth {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as RecordAuth).token === "string" &&
		!!(value as RecordAuth).record &&
		typeof (value as RecordAuth).record === "object"
	);
}

/**
 * Present the OAuth2 authorization URL and resolve with the backend's
 * `{ token, record, meta }` result delivered via `postMessage`.
 *
 * This is the shared orchestration behind `authWithOAuth2`: open a popup
 * (or invoke `urlCallback`), wait for the backend's `lazypock:oauth2`
 * message, validate its origin + source, and clean up all timers/listeners
 * on every exit path.
 */
export function authorizeWithOAuth2Popup(opts: {
	authURL: string;
	expectedOrigin: string;
	urlCallback?: (url: string) => void | Promise<void>;
	popup?: OAuth2PopupOptions;
	timeoutMs: number;
}): Promise<RecordAuth> {
	return new Promise<RecordAuth>((resolve, reject) => {
		// The popup flow depends on a browser `window` for both presenting the
		// popup and receiving the `postMessage` result.
		if (typeof window === "undefined") {
			reject(
				new ApiError(
					"OAuth2 popup flow requires a browser window. Use `authWithOAuth2Code()` in non-browser environments.",
					{},
					0,
					false,
					"oauth2_popup_unavailable",
				),
			);
			return;
		}

		let settled = false;
		let popup: Window | null = null;
		let closePoll: ReturnType<typeof setInterval> | null = null;
		let timeout: ReturnType<typeof setTimeout> | null = null;

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = null;
			}
			if (closePoll) {
				clearInterval(closePoll);
				closePoll = null;
			}
			window.removeEventListener("message", onMessage);
		};

		const finish = (err: ApiError | null, result?: RecordAuth) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (err) reject(err);
			else resolve(result as RecordAuth);
		};

		const onMessage = (event: MessageEvent) => {
			// Only accept messages from the backend origin — this is the
			// security boundary that prevents other origins from spoofing a
			// login result.
			if (event.origin !== opts.expectedOrigin) return;
			// When we opened a popup, only accept messages from *that* window,
			// so concurrent authWithOAuth2 flows never cross-deliver.
			if (popup && event.source && event.source !== popup) return;

			const data = event.data as Partial<OAuth2RedirectMessage> | null;
			if (!data || typeof data !== "object") return;

			if (data.type === "lazypock:oauth2") {
				if (isRecordAuth(data.result)) {
					if (popup) {
						try {
							popup.close();
						} catch {
							// ignore — the backend already closes it
						}
					}
					finish(null, data.result);
				} else {
					finish(
						new ApiError(
							"OAuth2 callback returned an invalid result.",
							data,
							400,
							false,
							"oauth2_provider_error",
						),
					);
				}
				return;
			}

			if (data.type === "lazypock:oauth2:error") {
				const result = (data.result ?? {}) as {
					code?: number;
					message?: string;
					data?: unknown;
				};
				const message =
					typeof result.message === "string" && result.message
						? result.message
						: "OAuth2 authorization failed.";
				finish(
					new ApiError(
						message,
						result,
						typeof result.code === "number" ? result.code : 400,
						false,
						"oauth2_provider_error",
					),
				);
			}
		};

		const openPopup = () => {
			// Defense-in-depth: never open a non-http(s) target. The authURL
			// is server-provided, but validate it at the point of use.
			if (!isSafeBrowserUrl(opts.authURL)) {
				finish(
					new ApiError(
						"OAuth2 authorization URL has an unsupported protocol.",
						{},
						0,
						false,
						"oauth2_provider_error",
					),
				);
				return;
			}
			const width = opts.popup?.width ?? DEFAULT_POPUP_WIDTH;
			const height = opts.popup?.height ?? DEFAULT_POPUP_HEIGHT;
			// A non-empty features string keeps `window.opener` set (required
			// for the backend's postMessage bridge). Do NOT add `noopener`.
			const features =
				"width=" +
				width +
				",height=" +
				height +
				",scrollbars=yes,resizable=yes";
			// authURL is server-provided (from `auth-methods`), not user input, and
			// is protocol-validated just above. Opening it in a popup is the standard
			// OAuth2 flow (same as PocketBase) — not an open redirect.
			// pi-lens-ignore: no-open-redirect-js
			const win = window.open(opts.authURL, "_blank", features);
			if (!win) {
				finish(
					new ApiError(
						"OAuth2 popup was blocked by the browser. Please allow popups for this site and try again.",
						{},
						0,
						false,
						"oauth2_popup_blocked",
					),
				);
				return;
			}
			popup = win;
			closePoll = setInterval(() => {
				if (popup && popup.closed) {
					finish(
						new ApiError(
							"OAuth2 sign-in was cancelled.",
							{},
							0,
							false,
							"oauth2_cancelled",
						),
					);
				}
			}, CLOSE_POLL_MS);
		};

		window.addEventListener("message", onMessage);

		timeout = setTimeout(() => {
			if (popup) {
				try {
					popup.close();
				} catch {
					// ignore
				}
			}
			finish(
				new ApiError(
					"OAuth2 sign-in timed out.",
					{},
					0,
					false,
					"oauth2_timeout",
				),
			);
		}, opts.timeoutMs);

		if (opts.urlCallback) {
			Promise.resolve(opts.urlCallback(opts.authURL)).catch((err: unknown) => {
				finish(
					err instanceof ApiError
						? err
						: new ApiError(
								`OAuth2 urlCallback failed: ${String(err)}`,
								{},
								0,
								false,
								"oauth2_provider_error",
							),
				);
			});
		} else if (typeof window.open === "function") {
			openPopup();
		} else {
			finish(
				new ApiError(
					"OAuth2 popup flow requires a browser window. Use `authWithOAuth2Code()` in non-browser environments.",
					{},
					0,
					false,
					"oauth2_popup_unavailable",
				),
			);
		}
	});
}
