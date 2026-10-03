// ── AuthStore persistence test ─────────────────────────
// Regression test: the auth collection name must survive `init()` (a page
// reload), otherwise token auto-refresh silently stops working and callers
// cannot tell which auth collection a restored session belongs to.
//
// Run: node auth-store-test.mjs  (also wired into `npm run smoke`)

import { AuthStore } from "./dist/index.js";

let failures = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures++;
	console.log(
		`${ok ? "✓" : "✗"} ${name}${ok ? "" : `\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`}`,
	);
}

/** localStorage-like adapter kept in memory for the test. */
function memoryStorage() {
	const map = new Map();
	return {
		get: (key) => (map.has(key) ? map.get(key) : null),
		set: (key, value) => void map.set(key, value),
		remove: (key) => void map.delete(key),
	};
}

// 1. Logging in persists the collection name…
{
	const storage = memoryStorage();
	const store = new AuthStore(storage);

	store.setCollectionName("users");
	store.set("token-1", { id: "u1", email: "a@b.c", collectionName: "users" });

	check("setCollectionName persists auth_collection", storage.get("auth_collection"), "users");

	// 2. …and a fresh store (page reload) restores it.
	const reloaded = new AuthStore(storage);
	await reloaded.init();

	check("init restores collectionName", reloaded.collectionName, "users");
	check("init restores the model", reloaded.model?.id, "u1");
	check("init restores the token", reloaded.token, "token-1");
}

// 3. Sessions persisted by older versions recover it from the record.
{
	const storage = memoryStorage();
	storage.set("auth_token", "token-2");
	storage.set("auth_model", JSON.stringify({ id: "u2", collectionName: "members" }));

	const store = new AuthStore(storage);
	await store.init();

	check("init falls back to model.collectionName", store.collectionName, "members");
}

// 4. `set` derives the collection when the caller did not set it explicitly.
{
	const storage = memoryStorage();
	const store = new AuthStore(storage);

	store.set("token-3", { id: "u3", collectionName: "staff" });

	check("set derives collectionName from the record", store.collectionName, "staff");
	check("set persists the derived collectionName", storage.get("auth_collection"), "staff");
}

// 5. Superuser sessions carry no collection; clear() removes everything.
{
	const storage = memoryStorage();
	const store = new AuthStore(storage);

	store.setCollectionName(null);
	store.set("su-token", null);

	check("superuser session has no collectionName", store.collectionName, null);
	check("superuser session stores no auth_collection", storage.get("auth_collection"), null);

	store.setCollectionName("users");
	store.clear();

	check("clear removes auth_collection", storage.get("auth_collection"), null);
	check("clear nulls collectionName", store.collectionName, null);
}

console.log(
	failures === 0 ? "\n✅ All auth-store tests passed" : `\n❌ ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
