// Codegen throughput benchmark.
//
// Run from the repo root (builds first):
//
//   npm run bench
//
// Measures `generateTypes` for schemas of 5 / 50 / 500 collections. Pure —
// no network or server required. Reports the median of N runs (ms).

import { performance } from "node:perf_hooks";
import { generateTypes } from "../dist/index.js";

function makeCollections(n) {
	return Array.from({ length: n }, (_, i) => ({
		id: `col_${i}`,
		name: `collection_${i}`,
		type: "base",
		system: false,
		fields: [
			{ name: "title", type: "text", required: true },
			{ name: "views", type: "number" },
			{ name: "published", type: "bool" },
			{ name: "tags", type: "select", options: { values: ["a", "b", "c"] } },
			{ name: "created", type: "autodate", system: true },
			{ name: "updated", type: "autodate", system: true },
		],
	}));
}

function bench(label, fn, iterations = 20) {
	fn(); // warm up
	const times = [];
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}
	times.sort((a, b) => a - b);
	const median = times[Math.floor(times.length / 2)];
	const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
	console.log(
		`${label.padEnd(34)} median ${median.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms`,
	);
}

console.log("\n== Codegen CLI: generateTypes ==\n");
for (const n of [5, 50, 500]) {
	const items = makeCollections(n);
	const bytes = generateTypes(items, { packageName: "lazypock" }).length;
	bench(`${n} collections (${bytes} bytes out)`, () =>
		generateTypes(items, { packageName: "lazypock" }),
	);
}
console.log();
