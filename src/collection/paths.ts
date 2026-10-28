// ── Collection paths ────────────────────────────────────
// The server's collection routes live in exactly one place: a path repeated
// eighteen times is a path that drifts.

/** URL-encode a collection name or record id. */
export function encodeId(id: string): string {
	return encodeURIComponent(id);
}

/**
 * The records endpoint for a collection
 * (`/api/collections/<name>/records`).
 */
export function recordsPath(collectionName: string): string {
	return "/collections/" + encodeId(collectionName) + "/records";
}

/** The collection's own endpoint, which is where its auth routes live. */
export function collectionPath(collectionName: string): string {
	return "/collections/" + encodeId(collectionName);
}