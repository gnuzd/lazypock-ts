// ── Collection realtime subscriptions ───────────────────
// Topic naming, event normalisation and the PocketBase-compatible argument
// forms for a single collection's record channel.

import type { RealtimeService } from "../realtime";

/**
 * A realtime record-change event delivered to subscription callbacks.
 * Mirrors PocketBase's RealtimeService result shape (`action` + `record`).
 */
export interface RealtimeMessage {
	action: "create" | "update" | "delete";
	record: Record<string, unknown>;
	topic?: string;
}

/** Subscription callback for a collection's realtime events. */
export type RealtimeCallback = (e: RealtimeMessage) => void;

/**
 * Options for {@link CollectionService.subscribe} (PocketBase-compatible).
 *
 * `expand` and any extra keys are forwarded to the server channel join
 * payload (available to `onRealtimeSubscribeRequest` hooks). `headers` is
 * accepted for PocketBase signature compatibility but has no effect over
 * the SSE connection — it is not forwarded.
 */
export interface RealtimeSubscribeOptions {
	/** Fields to expand on the subscribed records (server join payload). */
	expand?: string;
	/** Accepted for PocketBase parity; not sent over the SSE connection. */
	headers?: Record<string, string>;
	/** Any extra keys are forwarded verbatim to the server join payload. */
	[key: string]: unknown;
}

/** Raw event passed by the low-level realtime service. */
interface RealtimeEventLike {
	event: string;
	topic: string;
	payload?: Record<string, unknown>;
}

/** What a collection's realtime helpers need. */
export interface CollectionRealtimeContext {
	realtime?: RealtimeService;
	collectionName: string;
}

/** The topic prefix shared by every subscription of one collection. */
export function collectionTopic(collectionName: string): string {
	return "collection:" + collectionName;
}

/** Map a raw event/action to a normalised create/update/delete action. */
export function normalizeAction(
	event: string,
	rawAction?: unknown,
): RealtimeMessage["action"] {
	if (typeof rawAction === "string") {
		const a = rawAction.toLowerCase();
		if (a === "create" || a === "update" || a === "delete") {
			return a;
		}
	}
	if (event === "record_change") return "update";
	if (event === "create" || event === "record_create") return "create";
	if (event === "delete" || event === "record_delete") return "delete";
	return "update";
}

/**
 * Subscribe to this collection's realtime changes.
 *
 * Accepts the PocketBase argument order (`recordId`, `callback`, `options`)
 * and the legacy callback-first form (`callback`, `recordId`).
 *
 * @returns A function that unsubscribes this callback.
 */
export function subscribeToCollection(
	ctx: CollectionRealtimeContext,
	topicOrCallback: string | RealtimeCallback,
	maybeCallback?: RealtimeCallback | string,
	options?: RealtimeSubscribeOptions,
): () => void {
	const { realtime, collectionName } = ctx;
	if (!realtime) {
		console.warn("[lazypock] No realtime service configured.");
		return () => {};
	}

	let recordId: string | undefined;
	let callback: RealtimeCallback;
	let joinPayload: Record<string, unknown> | undefined;

	if (typeof topicOrCallback === "function") {
		callback = topicOrCallback;
		if (typeof maybeCallback === "string") recordId = maybeCallback;
	} else {
		callback = maybeCallback as RealtimeCallback;
		recordId = topicOrCallback === "*" ? undefined : topicOrCallback;
		// Forward subscribe options (minus HTTP-only headers) to the server
		// channel join payload.
		const { headers: _ignored, ...rest } = options ?? {};
		if (Object.keys(rest).length > 0) joinPayload = rest;
	}

	const topic =
		collectionTopic(collectionName) + (recordId ? ":" + recordId : "");
	const handler = (raw: RealtimeEventLike) => {
		const record = (raw.payload?.["record"] ?? {}) as Record<string, unknown>;
		callback({
			action: normalizeAction(raw.event, raw.payload?.["action"]),
			record,
			topic: raw.topic,
		});
	};
	realtime.ensureConnected();
	realtime.subscribe(topic, handler as never, joinPayload);
	return () => realtime.unsubscribe(topic, handler as never);
}

/**
 * Unsubscribe from realtime changes (PocketBase-compatible):
 *   - `unsubscribe()` — remove **all** subscriptions of this collection
 *   - `unsubscribe('*')` — remove wildcard subscriptions
 *   - `unsubscribe('RECORD_ID')` — remove that record's subscriptions
 */
export function unsubscribeFromCollection(
	ctx: CollectionRealtimeContext,
	recordId?: string,
): void {
	const { realtime, collectionName } = ctx;
	if (recordId === undefined) {
		realtime?.unsubscribeByPrefix(collectionTopic(collectionName));
		return;
	}
	const topic =
		collectionTopic(collectionName) + (recordId === "*" ? "" : ":" + recordId);
	realtime?.unsubscribe(topic);
}