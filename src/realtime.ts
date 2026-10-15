// ── SSE Realtime Client ───────────────────────────────
//
// Subscribes to this server's Server-Sent Events endpoint at `/api/realtime`.
//
// One connection carries every topic the client is subscribed to: the server takes
// a comma-separated `subscribe` query parameter and cannot change it on a live
// connection, so changing the subscription set reconnects. The stream is read with
// `fetch` rather than `EventSource` so the bearer token and the `X-Connection-Id`
// header can be sent — `EventSource` supports neither.

interface RealtimeEvent {
	event: string;
	topic: string;
	payload: Record<string, unknown>;
}

interface SubEntry {
	topic: string;
	callback: (e: RealtimeEvent) => void;
	/** Accepted for API compatibility; SSE has no join payload. */
	joinPayload?: Record<string, unknown>;
}

export type RealtimeConnectOpts = {
	/** SSE endpoint URL, e.g. `http://localhost:4000/api/realtime`. */
	url: string;
	/** Auth token to send as a bearer. */
	token?: string;
};

/**
 * Provides the current auth token at connect/reconnect time.
 * Wired by {@link LazypockClient} from its `authStore` so the stream is
 * always authenticated with the latest token (PocketBase parity).
 */
export type RealtimeTokenProvider = () => string | undefined;

/**
 * Derive the SSE endpoint from an HTTP base URL.
 * `http://localhost:4000/api` → `http://localhost:4000/api/realtime`
 */
export function sseUrlFromBaseUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/realtime`;
}

/**
 * @deprecated Realtime is SSE, not WebSocket. Use {@link sseUrlFromBaseUrl}.
 * Kept so an existing import keeps compiling.
 */
export function wsUrlFromBaseUrl(baseUrl: string): string {
	return sseUrlFromBaseUrl(baseUrl);
}

/**
 * Translate an SDK topic to the server's `subscribe` specifier.
 *
 * The SDK keeps PocketBase's topic names (`collection:posts`, `collections`); the
 * server takes a collection name, an optional `/recordId`, and the registry topic.
 */
function serverTopic(topic: string): string | null {
	if (topic === "collections") return "collections";
	if (!topic.startsWith("collection:")) return null;
	const rest = topic.slice("collection:".length);
	const [name, recordId] = rest.split(":");
	if (!name) return null;
	return recordId ? `${name}/${recordId}` : name;
}

/** The data of one server realtime event. */
interface RealtimeFrame {
	collection?: string;
	action?: string;
	id?: string;
	record?: Record<string, unknown>;
}

/**
 * SSE client for real-time collection subscriptions.
 *
 * Connects to `/api/realtime`, subscribes to the collection topics the SDK uses,
 * and reconnects with exponential backoff. Live row-level security is applied by the
 * server: an event is only sent for a record the subscriber may read.
 */
export class RealtimeService {
	private controller: AbortController | null = null;
	private open = false;
	private closed = false;
	private subscriptions = new Map<string, SubEntry[]>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private maxReconnectDelay = 5000;

	// Callbacks for connection state.
	onReconnect?: () => void;
	onDisconnect?: () => void;
	onError?: (err: unknown) => void;

	private url = "";
	private token: string | undefined;
	private tokenProvider: RealtimeTokenProvider | null = null;

	// Per-client connection id (browser tab / device). Sent as the
	// `X-Connection-Id` header so the server can exclude the *originating*
	// connection from its own broadcasts, while the same user's other
	// tabs/devices still receive them.
	private connectionId: string | undefined;

	/** Whether the stream is currently open. */
	get isOpen(): boolean {
		return this.open;
	}

	/** The most recently used SSE URL (set on {@link connect}/{@link setUrl}). */
	get lastUrl(): string {
		return this.url;
	}

	/** The auth token configured for this connection. */
	get lastToken(): string | undefined {
		return this.token;
	}

	/** Set the per-client connection id (browser tab / device). */
	setConnectionId(id: string): void {
		this.connectionId = id;
	}

	/** Set the stream URL. Useful before subscribing so the SDK auto-connects. */
	setUrl(url: string): void {
		this.url = url;
	}

	/** Register a token provider consulted at every (re)connect. */
	setTokenProvider(provider: RealtimeTokenProvider): void {
		this.tokenProvider = provider;
	}

	/**
	 * Reconnect immediately with the current token, so auth changes
	 * (login/logout/refresh) re-authorize private subscriptions.
	 */
	refresh(): void {
		if (this.closed) return;
		if (!this.open && this.subscriptions.size === 0) return;
		this.reconnectAttempt = 0;
		this.doConnect();
	}

	/** Ensure a connection is open, then subscribe. */
	ensureConnected(): void {
		if (this.open || this.controller || !this.url) return;
		if (this.serverTopics().length === 0) return;
		this.doConnect();
	}

	connect(opts: RealtimeConnectOpts): void {
		this.url = opts.url;
		this.token = opts.token;
		this.closed = false;
		this.reconnectAttempt = 0;
		this.doConnect();
	}

	disconnect(): void {
		this.closed = true;
		this.clearReconnectTimer();
		this.closeStream();
	}

	/**
	 * Subscribe to a topic (`collection:posts`, `collection:posts:ID`, or the
	 * registry topic `collections`).
	 */
	subscribe(
		topic: string,
		callback: (e: RealtimeEvent) => void,
		joinPayload?: Record<string, unknown>,
	): void {
		const subs = this.subscriptions.get(topic) || [];
		subs.push({ topic, callback, joinPayload });
		this.subscriptions.set(topic, subs);
		this.resubscribe();
	}

	/** Remove every subscription under `prefix` (the topic or `prefix:...`). */
	unsubscribeByPrefix(prefix: string): void {
		let changed = false;
		for (const topic of [...this.subscriptions.keys()]) {
			if (topic === prefix || topic.startsWith(prefix + ":")) {
				this.subscriptions.delete(topic);
				changed = true;
			}
		}
		if (changed) this.resubscribe();
	}

	/** Remove a specific callback from a topic, or the whole topic. */
	unsubscribe(topic: string, callback?: (e: RealtimeEvent) => void): void {
		if (!callback) {
			if (this.subscriptions.delete(topic)) this.resubscribe();
			return;
		}
		const subs = this.subscriptions.get(topic)?.filter((s) => s.callback !== callback);
		if (subs && subs.length > 0) {
			this.subscriptions.set(topic, subs);
			return;
		}
		this.subscriptions.delete(topic);
		this.resubscribe();
	}

	// ── Internals ────────────────────────────────────

	/** The distinct server topics the current subscriptions need. */
	private serverTopics(): string[] {
		const topics = new Set<string>();
		for (const topic of this.subscriptions.keys()) {
			const server = serverTopic(topic);
			if (server) topics.add(server);
		}
		return [...topics];
	}

	/**
	 * The subscription set is part of the connection URL, so a change needs a new
	 * connection. Coalesced, because mounting a page subscribes to several
	 * collections in one tick.
	 */
	private resubscribe(): void {
		if (this.resubscribeTimer) clearTimeout(this.resubscribeTimer);
		this.resubscribeTimer = setTimeout(() => {
			this.resubscribeTimer = null;
			if (this.controller) {
				this.doConnect();
			} else {
				this.ensureConnected();
			}
		}, 0);
	}

	private doConnect(): void {
		if (this.closed) return;
		const topics = this.serverTopics();
		if (topics.length === 0 || !this.url) return;

		// Drop any in-flight attempt: its `finally` sees a nulled controller and
		// does not schedule a reconnect of its own.
		this.closeStream();

		const params = new URLSearchParams();
		params.set("subscribe", topics.join(","));
		const url = this.url + (this.url.includes("?") ? "&" : "?") + params.toString();

		const token = this.tokenProvider ? this.tokenProvider() : this.token;
		const headers: Record<string, string> = { Accept: "text/event-stream" };
		if (token) headers.Authorization = `Bearer ${token}`;
		if (this.connectionId) headers["X-Connection-Id"] = this.connectionId;

		const controller = new AbortController();
		this.controller = controller;
		void this.read(url, headers, controller);
	}

	private async read(
		url: string,
		headers: Record<string, string>,
		controller: AbortController,
	): Promise<void> {
		try {
			const response = await fetch(url, { headers, signal: controller.signal });
			if (!response.ok || !response.body) {
				throw new Error(`realtime connection failed (${response.status})`);
			}
			this.open = true;
			this.reconnectAttempt = 0;
			this.onReconnect?.();

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer = (buffer + decoder.decode(value, { stream: true })).replace(
					/\r\n/g,
					"\n",
				);
				let index: number;
				while ((index = buffer.indexOf("\n\n")) >= 0) {
					this.handleFrame(buffer.slice(0, index));
					buffer = buffer.slice(index + 2);
				}
			}
			throw new Error("realtime stream ended");
		} catch (err) {
			if (controller.signal.aborted) return;
			this.onError?.(err);
		} finally {
			if (this.controller === controller) {
				this.open = false;
				this.controller = null;
				this.onDisconnect?.();
				this.scheduleReconnect();
			}
		}
	}

	private handleFrame(frame: string): void {
		const dataLines: string[] = [];
		for (const line of frame.split("\n")) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
			}
		}
		if (dataLines.length === 0) return;

		let data: RealtimeFrame;
		try {
			data = JSON.parse(dataLines.join("\n")) as RealtimeFrame;
		} catch {
			return;
		}
		this.dispatch(data);
	}

	private dispatch(data: RealtimeFrame): void {
		const action = typeof data.action === "string" ? data.action : "update";
		if (data.collection === "collections") {
			this.emit("collections", action, (data.record ?? {}) as Record<string, unknown>);
			return;
		}
		if (!data.collection) return;
		const payload: Record<string, unknown> = { record: data.record ?? {}, action };
		this.emit(`collection:${data.collection}`, action, payload);
		if (data.id) {
			this.emit(`collection:${data.collection}:${data.id}`, action, payload);
		}
	}

	private emit(topic: string, event: string, payload: Record<string, unknown>): void {
		const subs = this.subscriptions.get(topic);
		if (!subs) return;
		const e: RealtimeEvent = { event, topic, payload };
		for (const s of subs) {
			try {
				s.callback(e);
			} catch {
				// swallow callback errors
			}
		}
	}

	private closeStream(): void {
		const controller = this.controller;
		this.controller = null;
		this.open = false;
		controller?.abort();
	}

	private scheduleReconnect(): void {
		if (this.closed) return;
		this.clearReconnectTimer();
		const delay = Math.min(
			1000 * 2 ** this.reconnectAttempt,
			this.maxReconnectDelay,
		);
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.doConnect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}
