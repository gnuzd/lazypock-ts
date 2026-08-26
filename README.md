# Lazypock — TypeScript SDK

TypeScript client library for [Lazypock](https://github.com/gnuzd/lazypock), an open-source PocketBase-compatible backend.

## Installation

```bash
npm install lazypock
```

## Quick Start

```typescript
import { LazypockClient } from 'lazypock';

const client = new LazypockClient({ baseUrl: 'http://localhost:4000/api' });

// Superuser login
await client.login('admin@example.com', 'password');

// Or auth collection login
await client.login('user@example.com', 'password', 'users');
// Or using the explicit method:
await client.authWithPassword('users', 'user@example.com', 'password');

// List records
const posts = await client.collection('posts').getList(1, 30);
// or fetch all pages:
const all = await client.collection('posts').getFullList();

// Create a record
const newPost = await client.collection('posts').create({ title: 'Hello', published: true });

// Auth collections — create a user (password is optional + write-only)
const user = await client.collection('users').create({
  email: 'ada@example.com',
  password: 'correct-horse-battery', // hashed server-side, never returned
});
const session = await client.authWithPassword('users', 'ada@example.com', 'correct-horse-battery');
// session.token — stored in client.authStore for subsequent requests

// File upload
const file = await client.files.upload(fileInput.files[0]);

// Real-time subscriptions (PocketBase-style: callback-first)
client.collection('posts').subscribe((e) => console.log(e.action, e.record));
```

## Type Safety

The SDK offers three levels of type safety — pick what fits your project.

### 1. Fully typed via codegen (recommended)

Connect to your API once and generate a typed client — every collection becomes
an interface with the exact field types from your schema (selects become string
unions, relations become record IDs, etc.).

```bash
# In your app, after installing lazypock:
npx lazypock-gen \
  --url http://localhost:4000/api \
  --email admin@example.com \
  --password your-password
# writes ./lazypock.types.ts
```

> `lazypock-gen` remains as a deprecated alias for backwards compatibility —
> the canonical command is now simply `lazypock`:
>
> ```bash
> npx lazypock --url http://localhost:4000/api --email admin@example.com --password your-password
> ```
>
> **Use an API key instead of a password** (recommended). Generate one from the
> Studio **Settings → API Keys** dashboard, then:
>
> ```bash
> npx lazypock --url http://localhost:4000/api --apikey lazypock_xxxxxxxx
> # or via env: LAZYPOCK_URL=... LAZYPOCK_API_KEY=... npx lazypock
> ```
>
> API keys are stored as a SHA-256 hash (raw value shown once at generation) and
> are scoped to collection listing — ideal for codegen (they can `GET /collections`
> without a login round-trip, and cannot read or mutate your records).

Then in your app:

```typescript
import { createClient } from './lazypock.types';

const client = createClient({ baseUrl: 'http://localhost:4000/api' });
await client.login('admin@example.com', 'password');

// Collection access is fully type-checked:
const post = await client.collection('posts').getOne('abc123');
// post.title — string, post.published — boolean, …

await client.collection('posts').create({ title: 'x' });      // ✓
await client.collection('posts').create({ nope: 1 });          // ✗ compile error
```

> **Dynamic collection names are fully supported.** The typed client accepts any
> runtime string for `collection(name)` and still returns the typed service for
> known collection names. So route params and dynamic lookups work naturally:
>
> ```typescript
> function load(name: string) {
>  return client.collection(name).getList(); // ✓ works for any string
> }
> ```

### 2. Hand-written generics (no codegen)

Pass a record interface to `collection<T>()` or use `.typed<T>()`:

```typescript
interface Post {
  id: string;
  title: string;
  published: boolean;
}

const postsSvc = client.collection('posts').typed<Post>();
const post = await postsSvc.getOne('abc123'); // post.title: string

await postsSvc.create({ title: 'Hi', published: true }); // ✓
await postsSvc.create({ title: 'Hi', nope: 1 });          // ✗ compile error
```

### 3. Runtime schema types (experimental)

Fetch schemas at runtime and let the client derive field types:

```typescript
const res = await fetch('http://localhost:4000/api/collections', {
  headers: { Authorization: 'Bearer ' + token },
});
const { items } = await res.json(); // CollectionSchema[]

const client = new LazypockClient({
  baseUrl: 'http://localhost:4000/api',
  types: { schemas: items },
});

const code = client.generateTypes(); // string — write to lazypock.types.ts
```

> The codegen CLI emits a `lazypockSchema` snapshot next to the types, and the
> generated `createClient()` wires it in automatically — so the schema-driven
> behaviour below (hidden-field exclusion, query validation) works out of the box.

### Field projection (`select`) & query suggestions

#### `.select(...)` — pick the fields you want

`select()` projects list/read responses to the given fields (PocketBase `fields`
param). Field names are **type-checked** when the service is typed:

```typescript
const t = await client.collection('posts').select('id', 'title').getList();
// GET /api/posts?fields=id,title

await client.collection('posts').select('id', 'title').getOne('abc123'); // same
```

- `select('*')` (or no `select()` call) — request **all visible fields**; hidden
  fields are excluded automatically when a schema is available.
- `select()` with no arguments resets back to the default.
- `select()` returns a **derived service** — the original is untouched, so you
  can keep one default service and project per-request.
- Passing an explicit `fields` option overrides the `select()` preset.

When a schema is known (via `types.schemas` or codegen), hidden fields are
**not returned by the server**: every read sends `fields=<visible fields>` by
default, and selecting an unknown field logs a warning.

#### Creating records in auth collections (write-only `password`)

Collections can be **base** (`type: "base"`, plain records) or **auth**
(`type: "auth"`, accounts — the built-in `users` collection is an auth
collection). Auth collections have an email field and a write-only password
field, plus system fields (`verified`, `emailVisibility`).

The `password` field is **write-only**:

- **Hidden** — never returned by the server, never shown in the Studio record
  browser, and omitted from the generated **read model** (`UsersRecord`).
- **Optional** — accounts may exist without a password (e.g. OAuth-only
  users or invite flows), so `create()` typechecks without it.
- Hashed — the server bcrypt-hashes the value before storing it (as
  `password_hash` in the database) and strips it from every response.

Because of this, `password` **is** part of the generated **create data**
(`UsersCreateData`), so creating a user is fully type-safe — including when
the password field is marked **hidden** in the collection schema:

```typescript
// Create a user (password optional, write-only)
const user = await client.collection('users').create({
  email: 'ada@example.com',
  password: 'correct-horse-battery', // ✓ typed — write-only, never returned
});

// OAuth-only / invite flow — no password at all
const ghost = await client.collection('users').create({ email: 'ghost@example.com' });

// Change a password later
await client.collection('users').update(user.id, { password: 'new-pw' }); // ✓
```

> **Backward compatibility:** the raw database field name (`password_hash`)
> remains accepted as an alias in generated create data, but `password` is the
> canonical key (matching PocketBase).

Once created, log the user in with `authWithPassword` (see below) — the same
endpoint the client uses internally for `login()`.

```typescript
const session = await client.authWithPassword('users', 'ada@example.com', 'correct-horse-battery');
// session.token + session.record (password stripped); stored in client.authStore
const whoami = await client.me(); // fresh record via GET /api/me
```

#### `filter` / `sort` / `expand` — type-checked suggestions

With a typed service, the query options validate field names (and filter
operators) at compile time — your editor suggests valid fields as you type:

```typescript
await postsSvc.getList(1, 20, { sort: '-title' });        // ✓ suggests title/published/…
await postsSvc.getList(1, 20, { sort: '-nope' });         // ✗ compile error

await postsSvc.getList(1, 20, {
  filter: "title ~ 'x' && published = true", // ✓ field + operator checked
});
await postsSvc.getList(1, 20, { filter: `title=${search}` }); // ✓ spaces optional
await postsSvc.getList(1, 20, { filter: "(title = 'a' || title = 'b')" }); // ✓ parens
await postsSvc.getList(1, 20, { filter: "author.email = 'x'" }); // ✓ relation dot-path
await postsSvc.getList(1, 20, { filter: 'nope = 1' });    // ✗ compile error

await postsSvc.getList(1, 20, { expand: 'author' });      // ✓ field suggested
await postsSvc.getList(1, 20, { expand: 'author.user' }); // ✓ nested dot-path
await postsSvc.getOne('abc', { expand: 'author' });
```

- `filter` — `field op value` clauses with `= != ~ !~ > >= < <=` operators
  (spaces around the operator optional); `&&`, `||`, `!`, and parentheses are
  allowed before or after the first clause; relation dot-paths like
  `author.email = 'x'` typecheck. Field names and operators are suggested as
  you type.
- `sort` — `field`, `-field` (desc), `+field`, or comma-separated.
- `expand` — comma-separated relation field names, including nested dot-paths
  (`author.user`); non-relation fields warn at runtime when a schema is
  available.
- The **untyped** client (`client.collection('posts')` without `typed<T>()`)
  still accepts any string — suggestions kick in once the service is typed.

### CLI reference

```bash
lazypock [options]

Options:
  --url <url>        API base URL (or LAZYPOCK_URL)
  --apikey <key>    API key (or LAZYPOCK_API_KEY) — recommended, no login round-trip
  --api-key <key>   Deprecated alias for --apikey
  --email <email>    Superuser email (or LAZYPOCK_EMAIL)
  --password <pw>    Superuser password (or LAZYPOCK_PASSWORD)
  --output <file>   Output file (default: lazypock.types.ts)
  --out <file>      Deprecated alias for --output
  --package <name>   Package name to import (default: lazypock)
  --skip-system      Skip system collections
```

> **Note:** `lazypock-gen` is still available as a deprecated alias.

You must provide credentials one of two ways (or via the matching env vars):

1. `--apikey` / `LAZYPOCK_API_KEY` — scoped to collection listing, no login.
2. `--email` + `--password` / `LAZYPOCK_EMAIL` + `LAZYPOCK_PASSWORD` — superuser login.

```


## API Reference

### LazypockClient

The main client class.

#### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | required | API base URL (e.g. `http://localhost:4000/api`) |
| `storage` | `StorageAdapter` | `memoryStorage` | Custom storage adapter for token persistence |
| `authStore` | `AuthStore` | auto-created | Explicit auth store instance |
| `realtime` | `RealtimeService` | auto-created | Real-time service for WebSocket subscriptions |

#### Auto-Cancellation Methods

- `autoCancellation(enable)` — Globally enable/disable auto-cancellation of duplicated pending requests
- `cancelRequest(requestKey)` — Abort a single pending request by key (default `HTTP_METHOD + path`)
- `cancelAllRequests()` — Abort all pending requests

#### Authentication Methods

- `login(email, password, collection?)` — Login as superuser or auth collection user
- `authWithPassword(collection, identity, password, options?)` — Auth collection login
- `authRefresh(collection, options?)` — Refresh auth token
- `checkSuperuser()` — Check if any superuser exists
- `setup(email, password)` — Create initial superuser
- `logout()` — Clear auth state
- `me(options?)` — Get current superuser profile

#### Collections Service (`client.collections`)

PocketBase-style service for the collections themselves (admin):

- `collections.getList(params?)` — Paginated list of collections
- `collections.getFullList(options?)` — Fetch all collections (auto-paginates)
- `collections.getOne(id, options?)` — Get collection by ID/name
- `collections.create(data, options?)` — Create collection
- `collections.update(id, data, options?)` — Update collection
- `collections.delete(id, options?)` — Delete collection
- `collections.subscribe(cb)` — Subscribe to collection create/update/delete events (returns unsubscribe fn)
- `collections.unsubscribe()` — Unsubscribe from registry events
#### File Operations

- `files.upload(file, filename?, options?, meta?)` — Upload a file
- `files.getUrl(fileId)` — Get file metadata
- `files.delete(fileId, options?)` — Delete a file
- `getFileUrl(baseUrl, fileId)` — Construct a file URL from base URL and file ID (utility)

#### Realtime

- `realtime.connect(opts)` — Connect to WebSocket
- `realtime.disconnect()` — Disconnect
- `realtime.refresh()` — Reconnect with the current auth token (auto-called on auth change)
- `realtime.setTokenProvider(fn)` — Register a token provider consulted at every connect
- `realtime.subscribe(topic, callback, joinPayload?)` — Low-level subscribe (any topic, e.g. `collection:posts` or custom `chat:room1`)
- `realtime.unsubscribe(topic, callback?)` — Low-level unsubscribe
- `realtime.unsubscribeByPrefix(prefix)` — Remove all subscriptions under a topic prefix
- `collection(name).subscribe(topicOrCallback?, callback?, options?)` — PocketBase-style record subscription; callback receives `{ action, record }` (full record); returns unsubscribe fn
- `collection(name).unsubscribe(topic?)` — Unsubscribe `'*'`, a record id, or all subscriptions

### CollectionService

Returned by `client.collection(name)`.

- `select(...fields)` — Project reads to the given fields (see [Field projection](#field-projection-select--query-suggestions)); `select('*')` restores the all-visible default
- `getList(page, perPage, options?)` — Paginated list of records (typed `filter`/`sort`/`expand`/`fields`)
- `getFullList(options?)` — Fetch all records (auto-paginates)
- `getFirstListItem(filter, options?)` — Fetch first record matching filter
- `getOne(id, options?)` — Get record by ID
- `create(data, options?)` — Create record
- `update(id, data, options?)` — Update record
- `delete(id, options?)` — Delete record
- `subscribe(topicOrCallback?, callback?, options?)` — PocketBase-style: `subscribe(cb)`, `subscribe('*', cb)`, `subscribe('id', cb)`, or with `{ expand }` options (legacy `subscribe(cb, recordId)` still works)
- `unsubscribe(topic?)` — `unsubscribe('*')` / `unsubscribe('id')` / `unsubscribe()` (all)
- `authWithPassword(identity, password, options?)` — Login to this auth collection
- `authRefresh(options?)` — Refresh token for this auth collection
- `authMethods(options?)` — Get available auth methods

### AuthStore

Handles token persistence and auto-refresh.

- `token` — Current JWT token
- `model` — Current auth model (user record or null)
- `isValid` — Whether a token exists
- `isExpired` — Whether the current token has expired (with 30s buffer)
- `collectionName` — Name of the auth collection used for token refresh
- `set(token, model)` — Update token and model
- `setCollectionName(name)` — Set the auth collection name for token refresh
- `clear()` — Clear all auth state
- `onChange(callback)` — Listen for auth changes (returns unsubscribe function)
- `init()` — Restore persisted auth from storage

### Types

```typescript
interface ApiRecord {
  id: string;
  collectionId: string;
  collectionName: string;
  created: string;
  updated: string;
  [key: string]: unknown;
}

interface ListResult<T> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

interface AuthModel {
  id: string;
  [key: string]: unknown;
}

interface FileRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  [key: string]: unknown;
}

interface RequestOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}
```

## Auto Cancellation

The SDK auto-cancels duplicated pending requests for you (PocketBase-compatible
behaviour). When a new request is issued with the same request key as a
still-pending request, the previous one is aborted — only the last request
executes:

```typescript
// Only the last call will execute; the first two are auto-cancelled
await client.collection('posts').getList(1, 20); // cancelled
await client.collection('posts').getList(2, 20); // cancelled
await client.collection('posts').getList(3, 20); // executed
```

By default the request key is `HTTP_METHOD + path` (e.g. `"GET /api/posts?page=1"`), so
duplicate calls with identical URLs cancel each other. Cancelled requests reject
with an `ApiError` whose `isAbort` is `true`:

```typescript
try {
  await client.collection('posts').getList(1, 20);
} catch (err) {
  if (err instanceof ApiError && err.isAbort) {
    // superseded by a newer request — safe to ignore
  }
}
```

#### Per-request control

Pass `requestKey` in the request options to customize the key, or disable
auto-cancellation for a specific request:

```typescript
await client.collection('posts').getList(1, 20, { requestKey: 'my-list' }); // cancelled
await client.collection('posts').getList(1, 20, { requestKey: 'my-list' }); // executed

await client.collection('posts').getList(1, 20, { requestKey: null });   // executed
await client.collection('posts').getList(1, 20, { requestKey: null });   // executed
```

#### Global control

```typescript
// Disable auto-cancellation globally
client.autoCancellation(false);

// Manually cancel pending requests
client.cancelRequest('GET /api/posts?page=1');
client.cancelAllRequests();
```

#### Single-flight dedup (`getFullList`)

`getFullList()` (and `collections.getFullList()`) are **single-flight**: concurrent
calls with the same effective options share one in-flight request instead of
firing duplicates. This means the common pattern below results in **one**
network request, and **both** callers resolve with the same data — no abort
rejection:

```typescript
const [a, b] = await Promise.all([
  client.collection('posts').getFullList(),
  client.collection('posts').getFullList(),
]);
// one GET fired; a === b
```

Calls with **different** options (e.g. different `sort`/`filter`) are still
distinct requests. Multi-page fetches continue to work normally — each page
request is unique (page number is part of the URL), so pages never cancel each
other.

The underlying `singleFlight` option is also available on any request when you
want to coalesce concurrent identical calls yourself:

```typescript
await client.collection('posts').getList(1, 20, { singleFlight: true });
```

## Error Handling

The SDK throws `ApiError` on non-2xx responses:

```typescript
import { LazypockClient, ApiError } from 'lazypock';

try {
  await client.collection('posts').create({ title: 'My Post' });
} catch (err) {
  if (err instanceof ApiError) {
    console.log(err.status);    // HTTP status code
    console.log(err.message);   // Error message
    console.log(err.data);      // Full response data
  }
}
```

## Configuration

### Storage Adapter

By default, the SDK uses `localStorage` for token persistence. You can provide a custom adapter:

```typescript
import { LazypockClient, AuthStore } from 'lazypock';

const customStorage = {
  get: async (key) => await AsyncStorage.getItem(key),
  set: async (key, value) => await AsyncStorage.setItem(key, value),
  remove: async (key) => await AsyncStorage.removeItem(key),
};

const client = new LazypockClient({
  baseUrl: 'http://localhost:4000/api',
  storage: customStorage,
});
```

### Auto Token Refresh

The SDK automatically refreshes expired auth tokens. When a token expires, the next API call triggers a transparent refresh via the `auth-refresh` endpoint. No manual intervention needed.

## Real-time Subscriptions

### PocketBase-style `subscribe` / `unsubscribe`

Collection subscriptions use the same argument order as PocketBase. The
callback always receives the **full record** (all fields) — `select()`
projections only affect `getList`/`getOne`, never subscriptions:

```typescript
// Subscribe to all records (three equivalent forms)
const off = client.collection('posts').subscribe((event) => {
  console.log(event.action); // 'create' | 'update' | 'delete'
  console.log(event.record); // full record — all fields
});
client.collection('posts').subscribe('*', (event) => { ... });

// Subscribe to a single record
client.collection('posts').subscribe('RECORD_ID', (event) => { ... });

// With options — forwarded to the server channel join payload
// (available to onRealtimeSubscribeRequest hooks)
client.collection('posts').subscribe('*', (event) => { ... }, {
  expand: 'author',
  customKey: 'any extra key is forwarded',
});

// Unsubscribe
client.collection('posts').unsubscribe('*'); // wildcard only
client.collection('posts').unsubscribe('RECORD_ID'); // one record
client.collection('posts').unsubscribe(); // everything in this collection

// ...or call the returned unsubscribe function for one-shot listeners:
off();
```

The legacy callback-first form (`subscribe(cb, recordId)`) still works.
`headers` in the options object is accepted for PocketBase signature
compatibility but is not sent over the WebSocket.

### Auth tokens are attached automatically

The WebSocket automatically uses the current auth token (`authStore.token`)
and **reconnects when auth changes** (login / logout / token refresh) — so
subscriptions to rule-protected collections and admin channels work without
any manual socket management:

```typescript
await client.login('admin@example.com', 'secret');
// The socket reconnects with the new token; existing subscriptions re-join.
client.collection('private_feed').subscribe('*', (e) => { ... });
```

### Anonymous / rule-based realtime

Realtime subscriptions honor your API **and list rules** — matching PocketBase
behavior. This means **non-logged-in users can subscribe** to collections whose
list rules are public (empty `""` string) or anon-friendly
(`@request.auth.*` filters). The SDK auto-connects the WebSocket on first use,
so no token is required to receive public change events:

```typescript
// Works without logging in, as long as the collection's list rule allows it
const off = client.collection('public_feed').subscribe((e) => {
  console.log(e.action, e.record);
});
```

### Custom channels

Any topic string can be subscribed to via the low-level realtime service
(PocketBase behavior — anonymous joins allowed, broadcasts come from the
server side):

```typescript
// Subscribe to an arbitrary topic
const off = client.realtime.subscribe('chat:room1', (event) => {
  console.log(event.event, event.payload);
});
off(); // or client.realtime.unsubscribe('chat:room1');
```


## Releasing (automatic)

Releases are fully automatic via [release-please](https://github.com/googleapis/release-please):

1. Push a feature/fix to `main` with a conventional commit message
   (`fix(...)`, `feat(...)`, `chore(...)`). Release Please opens a
   **release PR** — `chore(main): release vX.Y.Z` — with the version bump
   and generated `CHANGELOG.md`.
2. **Merge the release PR** (review it first — it's the human gate). That
   merge creates the `vX.Y.Z` GitHub Release and tag, then the same workflow
   run builds, typechecks, runs the smoke tests, and publishes the package
   to npm.

There is no manual `workflow_dispatch` step and no local `npm publish`.

### Version selection

- `fix(...)` commits → patch (`0.8.2` → `0.8.3`)
- `feat(...)` commits → minor (`0.8.2` → `0.9.0`)
- a `BREAKING CHANGE:` footer in any commit body → major (`0.8.2` → `1.0.0`)

### One-time setup

- Add an npm access token (Automation or Publish scope, from
  <https://www.npmjs.com/settings/<you>/tokens>) as the repo secret
  **`NPM_TOKEN`** under Settings → Secrets and variables → Actions.

## License

[MIT](LICENSE) © 2024-2025 Chris Nguyen (gnuzd)
