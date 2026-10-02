// ── OAuth2 popup-flow (postMessage bridge) test ─────────────
// Verifies the SDK half of the hardened flow against a stubbed backend:
//   1. fetch listAuthMethods → open popup with the provider authURL
//   2. accept ONLY a same-origin message from the opened popup
//   3. treat the relayed payload as a single-use `code`
//   4. finish by calling auth-with-oauth2 with codeVerifier + createData
//      + default redirectUrl
//
// Runs fully offline (no browser, no server).

import { LazypockClient } from "./dist/index.js";

let failures = 0;
const check = (label, ok, extra = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${extra}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonResponse = (status, data) => ({
	status,
	ok: status >= 200 && status < 300,
	statusText: `status ${status}`,
	text: async () => JSON.stringify(data),
	json: async () => data,
});

// ── browser stubs ──────────────────────────────────────────
const listeners = [];
let popup = null;

globalThis.window = {
	addEventListener: (type, fn) => {
		if (type === "message") listeners.push(fn);
	},
	removeEventListener: (type, fn) => {
		if (type !== "message") return;
		const i = listeners.indexOf(fn);
		if (i >= 0) listeners.splice(i, 1);
	},
	open: () => {
		popup = {
			closed: false,
			close() {
				this.closed = true;
			},
		};
		return popup;
	},
};

const emit = (event) => {
	for (const fn of [...listeners]) fn(event);
};

// ── fetch stub ─────────────────────────────────────────────
let postedBody = null;

globalThis.fetch = async (url, init = {}) => {
	const href = String(url);
	if (href.endsWith("/auth-methods")) {
		return jsonResponse(200, {
			password: true,
			oauth2: {
				providers: [
					{
						name: "google",
						authURL: "https://accounts.google.test/o/oauth2/auth?client_id=c",
						state: "state-1",
						codeVerifier: "verifier-1",
					},
				],
			},
			mfa: {},
		});
	}
	if (href.endsWith("/auth-with-oauth2")) {
		try {
			postedBody = JSON.parse(init.body);
		} catch {
			postedBody = null;
		}
		return jsonResponse(200, {
			token: "jwt-token",
			record: { id: "rec1", email: "ada@example.com" },
			meta: { id: "rec1", isNew: true },
		});
	}
	return jsonResponse(404, { message: "unexpected " + href });
};

// ── the flow ───────────────────────────────────────────────
const client = new LazypockClient({ baseUrl: "http://localhost:4000/api" });

let settled = false;
const pending = client
	.collection("users")
	.authWithOAuth2({ provider: "google", createData: { name: "Ada" } })
	.then(
		(auth) => {
			settled = true;
			return auth;
		},
		(err) => {
			settled = true;
			throw err;
		},
	);

await sleep(20);

check("popup opened with the provider authURL", popup !== null && popup.closed === false);

// A message from any other origin must be ignored (spoofing boundary).
emit({
	origin: "http://evil.test",
	source: popup,
	data: { type: "lazypock:oauth2", code: "EVIL" },
});
await sleep(20);
check("wrong-origin message is ignored", settled === false);

// A message from a different window must be ignored too.
emit({
	origin: "http://localhost:4000",
	source: { not: "our popup" },
	data: { type: "lazypock:oauth2", code: "WRONG_WINDOW" },
});
await sleep(20);
check("message from another window is ignored", settled === false);

// The real relay: same origin + same popup window, carrying only a code.
emit({
	origin: "http://localhost:4000",
	source: popup,
	data: { type: "lazypock:oauth2", code: "CODE-123", state: "state-1" },
});

const auth = await pending;

check("resolves with the exchanged token", auth.token === "jwt-token");
check("exchange used the relayed code", postedBody?.code === "CODE-123");
check("exchange used the provider codeVerifier", postedBody?.codeVerifier === "verifier-1");
check("exchange forwarded createData", postedBody?.createData?.name === "Ada");
check(
	"exchange used the default redirectUrl",
	postedBody?.redirectUrl === "http://localhost:4000/api/oauth2-redirect",
);
check("auth store populated", client.authStore.token === "jwt-token");
check("popup was closed", popup.closed === true);

console.log(
	failures === 0
		? "\n✅ OAuth2 relay tests passed"
		: `\n❌ OAuth2 relay tests failed (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
