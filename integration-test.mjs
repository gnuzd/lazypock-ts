// ── Live integration test ───────────────────────────────
// Verifies the query features against a running LazyPock server.
//
//   LAZYPOCK_URL=http://localhost:4000/api \
//   LAZYPOCK_EMAIL=admin@example.com LAZYPOCK_PASSWORD=... \
//   npm run test:integration
//
// (or provide LAZYPOCK_TOKEN instead of email/password). With no
// LAZYPOCK_URL set the test is skipped, so `npm run smoke`/CI stay offline.

import { LazypockClient } from "./dist/index.js";

const url = process.env.LAZYPOCK_URL;
if (!url) {
	console.log("⏭  Skipping integration test (set LAZYPOCK_URL to run).");
	process.exit(0);
}

const email = process.env.LAZYPOCK_EMAIL;
const password = process.env.LAZYPOCK_PASSWORD;
const envToken = process.env.LAZYPOCK_TOKEN;

let failures = 0;
const check = (label, ok, extra = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  ${extra}`}`);
};
const first = (value) => (Array.isArray(value) ? value[0] : value);

async function getToken() {
	if (envToken) return envToken;
	const res = await fetch(`${url}/_superusers/auth-with-password`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ identity: email, password }),
	});
	if (!res.ok) throw new Error(`Superuser login failed (${res.status})`);
	return (await res.json()).token;
}

const auth = await getToken();
const collectionsResponse = await fetch(`${url}/collections`, {
	headers: { Authorization: `Bearer ${auth}` },
}).then((res) => res.json());
const items = Array.isArray(collectionsResponse)
	? collectionsResponse
	: collectionsResponse.items;

const client = new LazypockClient({ baseUrl: url, types: { schemas: items } });
client.authStore.set(auth, null);

// Find a relation field whose target has a usable leaf field, plus a record
// that actually references it.
let pick = null;
for (const coll of items) {
	if (coll.system || coll.name.startsWith("_")) continue;
	const relation = (coll.fields ?? []).find((f) => f.type === "relation");
	if (!relation) continue;
	const targetName = relation.options?.collection;
	const target = items.find((c) => c.name === targetName);
	const leaf = (target?.fields ?? []).find(
		(f) => !f.hidden && !f.system && f.name !== "id",
	);
	if (!target || !leaf) continue;
	const rows = await client
		.collection(coll.name)
		.getFullList({ perPage: 5 })
		.catch(() => []);
	const row = rows.find((r) => r[relation.name]);
	if (!row) continue;
	pick = { coll, relation, leaf: leaf.name, row };
	break;
}

if (!pick) {
	console.log("⏭  No populated relation found; skipping expand checks.");
} else {
	const { coll, relation, leaf, row } = pick;
	const svc = client.collection(coll.name);
	const relName = relation.name;

	const full = first(await svc.getFullList({ expand: [relName] }));
	check(
		`expand(['${relName}']) returns the related record`,
		Boolean(full?.expand?.[relName]),
		JSON.stringify(full?.expand),
	);

	const narrowed = first(await svc.getFullList({ expand: [`${relName}.${leaf}`] }));
	const narrowedKeys = Object.keys(narrowed?.expand?.[relName] ?? {});
	check(
		`expand(['${relName}.${leaf}']) keeps only the requested fields`,
		narrowedKeys.length === 1 && narrowedKeys[0] === leaf,
		JSON.stringify(narrowed?.expand?.[relName]),
	);

	// A projection must not drop the expanded data.
	const otherField = (coll.fields ?? []).find(
		(f) => f.name !== "id" && f.name !== relName && !f.hidden && !f.system,
	);
	const projected = first(
		await svc.select("id").getFullList({ expand: [`${relName}.${leaf}`] }),
	);
	check(
		"select('id') + expand keeps the expanded record and the projection",
		Boolean(projected?.expand?.[relName]) &&
			(otherField ? !(otherField.name in projected) : true),
		JSON.stringify(projected),
	);

	const one = await svc.getOne(row.id, { expand: [`${relName}.${leaf}`] });
	check("getOne + expand narrowing", Boolean(one?.expand?.[relName]));
}

// Array sort + filter builder on any collection that has records.
const sortable = items.find(
	(c) =>
		!c.system &&
		!c.name.startsWith("_") &&
		(c.fields ?? []).some((f) => f.type === "number"),
);
if (sortable) {
	const svc = client.collection(sortable.name);
	const numeric = sortable.fields.find((f) => f.type === "number").name;
	const sorted = await svc.getFullList({ sort: [`-${numeric}`] }).catch(() => []);
	check(
		`sort(['-${numeric}']) is descending`,
		sorted.every((r, i) => i === 0 || sorted[i - 1][numeric] >= r[numeric]),
		JSON.stringify(sorted.map((r) => r[numeric])),
	);
}

const anyColl = items.find((c) => !c.system && !c.name.startsWith("_"));
if (anyColl) {
	const svc = client.collection(anyColl.name);
	const rows = await svc.getFullList({ perPage: 3 }).catch(() => []);
	const ids = rows.map((r) => r.id);
	const byIds = await svc
		.getFullList({ filter: svc.where("id").in(ids) })
		.catch(() => []);
	check(
		"where('id').in(ids) returns the same records",
		byIds.length === ids.length,
		`${byIds.length} != ${ids.length}`,
	);

	let threw = false;
	try {
		svc.where("id").in([]);
	} catch {
		threw = true;
	}
	check("where('id').in([]) throws", threw);
}

console.log(
	failures === 0
		? "\n✅ Live integration checks passed"
		: `\n❌ ${failures} live integration check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
