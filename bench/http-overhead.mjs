// HTTP-layer overhead benchmark: single-flight coalescing + AbortController map.
//
// Run from the repo root (builds first):
//
//   npm run bench
//
// Uses a stubbed `globalThis.fetch` so no server is required. The stub adds a
// small latency and counts calls, letting us verify that `singleFlight` really
// coalesces duplicate requests and measure the per-request bookkeeping cost.

import { performance } from "node:perf_hooks";
import { AuthStore, HttpClient } from "../dist/index.js";

let fetchCalls = 0;

// HttpClient captures globalThis.fetch at construction, so stub it first.
globalThis.fetch = async () => {
	fetchCalls++;
	await new Promise((resolve) => setTimeout(resolve, 1));
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};

function newClient() {
	return new HttpClient("http://localhost:4000/api", new AuthStore());
}

async function timeAsync(fn) {
	const t0 = performance.now();
	await fn();
	return performance.now() - t0;
}

const N = 200;

// ── 1. Serial request bookkeeping overhead ────────────────────────────────
{
	const http = newClient();
	fetchCalls = 0;
	const ms = await timeAsync(async () => {
		for (let i = 0; i < N; i++) {
			await http.request("GET", `/thing?i=${i}`, undefined, {
				requestKey: null,
			});
		}
	});
	console.log(
		`\n== HTTP overhead (${N} requests) ==\n` +
			`serial (requestKey null)      ${ms.toFixed(1)} ms total   ${(ms / N).toFixed(3)} ms/req   fetch calls ${fetchCalls}`,
	);
}

// ── 2. Single-flight coalescing ───────────────────────────────────────────
{
	const http = newClient();
	fetchCalls = 0;
	const ms = await timeAsync(async () => {
		await Promise.all(
			Array.from({ length: 50 }, () =>
				http.request("GET", "/coalesced", undefined, {
					singleFlight: true,
					requestKey: "bench-coalesced",
				}),
			),
		);
	});
	console.log(
		`50 concurrent, singleFlight    ${ms.toFixed(1)} ms total   fetch calls ${fetchCalls} (expected 1)`,
	);
}

// ── 3. No coalescing, same key ────────────────────────────────────────────
{
	const http = newClient();
	fetchCalls = 0;
	const ms = await timeAsync(async () => {
		await Promise.all(
			Array.from({ length: 50 }, () =>
				http.request("GET", "/uncoalesced", undefined, {
					requestKey: null,
				}),
			),
		);
	});
	console.log(
		`50 concurrent, no singleFlight ${ms.toFixed(1)} ms total   fetch calls ${fetchCalls} (expected 50)`,
	);
}

// ── 4. Abort-map management at high frequency ─────────────────────────────
{
	const http = newClient();
	fetchCalls = 0;
	const ms = await timeAsync(async () => {
		for (let i = 0; i < N; i++) {
			// Same key every time → auto-cancel bookkeeping on each iteration.
			await http.request("GET", "/hot-path", undefined, {
				requestKey: "bench-hot",
			});
		}
	});
	console.log(
		`auto-cancel same key (${N}x)     ${ms.toFixed(1)} ms total   ${(ms / N).toFixed(3)} ms/req   fetch calls ${fetchCalls}\n`,
	);
}
