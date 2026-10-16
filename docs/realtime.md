---
title: Realtime
---

# Realtime

Subscribe to live record changes — PocketBase-style, callback-first.

Realtime is **Server-Sent Events (SSE)** over ordinary HTTP, not a WebSocket. The client streams
from `/api/realtime`, authenticated with the same bearer token as the REST calls, so collection
rules apply to subscriptions exactly as they do to reads. (It uses `fetch` rather than the browser's
`EventSource` because `EventSource` can send neither an `Authorization` header nor the connection id
that suppresses a client's own echo.)

```typescript
// Subscribe to all changes in a collection
const off = client.collection('posts').subscribe((event) => {
  console.log(event.action); // 'create' | 'update' | 'delete'
  console.log(event.record);
});

// Subscribe to a specific record only
client.collection('posts').subscribe((event) => { /* ... */ }, 'abc123');

// Unsubscribe
client.collection('posts').unsubscribe();

// ...or call the returned unsubscribe function for one-shot listeners:
off();
```

## Anonymous / rule-based realtime

Realtime subscriptions honor your API **and list rules** — matching PocketBase behavior. This means
**non-logged-in users can subscribe** to collections whose list rules are public (empty `""` string)
or anon-friendly (`@request.auth.*` filters). The SDK opens the stream automatically on first use, so
no token is required to receive public change events:

```typescript
// Works without logging in, as long as the collection's list rule allows it
const off = client.collection('public_feed').subscribe((e) => {
  console.log(e.action, e.record);
});
```

## Reconnecting

The stream reconnects on its own after a drop, and every subscription is re-established. Because the
auth token is read from a provider at each connect, a re-login is picked up without any manual stream
management — the `LazypockClient` wires this for you:

```typescript
await client.login('user@example.com', 'password');
// The stream reconnects with the new token; existing subscriptions re-subscribe.

client.realtime.setTokenProvider(() => myTokenStore.token); // if you manage tokens yourself
```

The server numbers its events, so a client that reconnects with a `Last-Event-ID` header resumes from
where it left off instead of silently missing changes.

## Low-level realtime service

For advanced use cases you can talk to the underlying service directly:

- `realtime.connect({ url, token })` — Open the SSE stream (normally on demand)
- `realtime.disconnect()` — Close it
- `realtime.refresh()` — Reconnect with the current auth token (auto-called on auth change)
- `realtime.setUrl(url)` — Point the service at a different stream URL
- `realtime.setTokenProvider(fn)` — Register a token provider consulted at every connect
- `realtime.setConnectionId(id)` — Set the connection id the server uses to suppress self-echo
- `realtime.subscribe(topic, callback, joinPayload?)` — Low-level subscribe (topic like `collection:posts`)
- `realtime.unsubscribe(topic, callback?)` — Low-level unsubscribe
- `realtime.unsubscribeByPrefix(prefix)` — Remove every subscription under a topic prefix

Topics keep PocketBase's names: `collection:posts`, `collection:posts:RECORD_ID`, and the registry
topic `collections`, which the server maps to its own subscribe specifier.

`joinPayload` and `headers` are accepted for PocketBase signature compatibility, but SSE has no join
payload — they are not sent.

## URL helpers

- `sseUrlFromBaseUrl(baseUrl)` — derive the stream URL from an HTTP base URL
  (`http://localhost:4000/api` → `http://localhost:4000/api/realtime`)
- `wsUrlFromBaseUrl(baseUrl)` — **deprecated**; returns the SSE URL. Kept so an existing import keeps
  compiling.
