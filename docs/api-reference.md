---
title: API Reference
---

# API Reference

## LazypockClient

The main client class.

### Constructor Options

| Option      | Type           | Default        | Description                                                             |
| ----------- | -------------- | -------------- | ----------------------------------------------------------------------- |
| `baseUrl`   | `string`       | required       | API base URL (e.g. `http://localhost:4000/api`)                         |
| `storage`   | `StorageAdapter` | `memoryStorage` | Custom storage adapter for token persistence                            |
| `authStore` | `AuthStore`    | auto-created   | Explicit auth store instance                                            |
| `realtime`  | `RealtimeService` | auto-created | Real-time service for WebSocket subscriptions                           |

## Collections Service (`client.collections`)

PocketBase-style service for the collections themselves (admin):

- `collections.getList(params?)` — Paginated list of collections
- `collections.getFullList(options?)` — Fetch all collections (auto-paginates)
- `collections.getOne(id, options?)` — Get collection by ID/name
- `collections.create(data, options?)` — Create collection
- `collections.update(id, data, options?)` — Update collection
- `collections.delete(id, options?)` — Delete collection
- `collections.subscribe(cb)` — Subscribe to collection create/update/delete events (returns unsubscribe fn)
- `collections.unsubscribe()` — Unsubscribe from registry events

## CollectionService

Returned by `client.collection(name)`. All reads accept typed query options —
see [Queries](/sdk/typescript/queries) for the full guide.

- `where(field)` — start a **typed filter clause** (see below)
- `select(...fields)` — Project reads to the given fields (see [Queries](/sdk/typescript/queries));
  `select('*')` restores the all-visible default
- `getList(page, perPage, options?)` — Paginated list of records (typed `filter`/`sort`/`expand`/`fields`)
- `getFullList(options?)` — Fetch all records (auto-paginates)
- `getFirstListItem(filter, options?)` — Fetch first record matching filter; `filter` may be a string or a `FilterExpr`
- `getOne(id, options?)` — Get record by ID
- `expandFields(options?)` — List the collection's relation fields (for building `expand`)
- `create(data, options?)` — Create record
- `update(id, data, options?)` — Update record
- `delete(id, options?)` — Delete record
- `subscribe(callback, recordId?)` — Subscribe to record changes (PocketBase-style)
- `unsubscribe(recordId?)` — Unsubscribe
- `typed<T>()` — Cast this service to a record shape (compile-time only)
- `withSchema(schema)` — Bind a schema explicitly (hidden-field exclusion + query checking)
- `authWithPassword(identity, password, options?)` — Login to this auth collection
- `authRefresh(options?)` — Refresh token for this auth collection
- `authMethods(options?)` — Get available auth methods

### Query options

| Option | Type | Description |
| --- | --- | --- |
| `filter` | `string \| FilterExpr` | PocketBase filter expression, or a builder expression |
| `sort` | `string \| string[]` | Field(s) to sort by; `-field` = descending |
| `expand` | `string \| string[]` | Relation field(s) to expand (`author`, `author.name`, `author.profile`) |
| `fields` | `string` | Explicit field projection for this call (overrides `select()`) |
| `requestKey` | `string \| null` | Override/disable auto-cancellation for this request |
| `singleFlight` | `boolean` | Coalesce concurrent identical requests |
| `fetch` | `typeof fetch` | Custom fetch (tests / React Native) |
| `signal` | `AbortSignal` | Abort signal |
| `headers` | `Record<string, string>` | Extra request headers |

Use the **array** form of `sort`/`expand` to get per-field autocomplete; the
string form works identically but is validated as a whole.

### Filter builder

`client.collection('posts').where('title')` returns a `FilterBuilder`. Field
names are checked/suggested against the collection and values are escaped.

```typescript
const q = client.collection('posts').where;

q('title').eq('x');                          // title = 'x'
q('title').contains('x');                    // title ~ 'x'
q('views').gte(100);                         // views >= 100
q('id').in(['a', 'b', 'c']);                 // (id = 'a' || id = 'b' || id = 'c')
q('id').notIn(['a', 'b']);                   // (id != 'a' && id != 'b')
q('author.email').eq('ada@example.com');     // relation dot-path
q('title').eq('x').and(q('published').eq(true));
q('a').eq(1).or(q('b').eq(2)).not();
```

| Method | Emits | | Method | Emits |
| --- | --- | --- | --- | --- |
| `eq(v)` | `field = v` | | `anyEq(v)` | `field ?= v` |
| `neq(v)` | `field != v` | | `anyNeq(v)` | `field ?!= v` |
| `contains(v)` | `field ~ v` | | `anyContains(v)` | `field ?~ v` |
| `notContains(v)` | `field !~ v` | | `anyNotContains(v)` | `field ?!~ v` |
| `gt(v)` / `gte(v)` | `field > v` / `field >= v` | | `anyGt(v)` / `anyGte(v)` | `field ?> v` / `field ?>= v` |
| `lt(v)` / `lte(v)` | `field < v` / `field <= v` | | `anyLt(v)` / `anyLte(v)` | `field ?< v` / `field ?<= v` |
| `in(values)` | `(field = a \|\| field = b \|\| …)` | | `and(other)` | `(a && b)` |
| `notIn(values)` | `(field != a && field != b && …)` | | `or(other)` / `not()` | `(a \|\| b)` / `!(a)` |

Values may be `string | number | boolean | null`; the server enforces the
exact per-field type. The raw string form remains available for dynamic or
advanced expressions.

## Types

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

The SDK auto-cancels duplicated pending requests for you (PocketBase-compatible behaviour). When a new
request is issued with the same request key as a still-pending request, the previous one is aborted —
only the last request executes:

```typescript
// Only the last call will execute; the first two are auto-cancelled
await client.collection('posts').getList(1, 20); // cancelled
await client.collection('posts').getList(2, 20); // cancelled
await client.collection('posts').getList(3, 20); // executed
```

By default the request key is `HTTP_METHOD + path` (e.g. `"GET /api/posts?page=1"`), so duplicate
calls with identical URLs cancel each other. Cancelled requests reject with an `ApiError` whose
`isAbort` is `true`:

```typescript
try {
  await client.collection('posts').getList(1, 20);
} catch (err) {
  if (err instanceof ApiError && err.isAbort) {
    // superseded by a newer request — safe to ignore
  }
}
```

### Per-request control

Pass `requestKey` in the request options to customize the key, or disable auto-cancellation for a
specific request:

```typescript
await client.collection('posts').getList(1, 20, { requestKey: 'my-list' }); // cancelled
await client.collection('posts').getList(1, 20, { requestKey: 'my-list' }); // executed

await client.collection('posts').getList(1, 20, { requestKey: null }); // executed
await client.collection('posts').getList(1, 20, { requestKey: null }); // executed
```

### Global control

```typescript
// Disable auto-cancellation globally
client.autoCancellation(false);

// Manually cancel pending requests
client.cancelRequest('GET /api/posts?page=1');
client.cancelAllRequests();
```

### Single-flight dedup (getFullList)

`getFullList()` (and `collections.getFullList()`) are **single-flight**: concurrent calls with the
same effective options share one in-flight request instead of firing duplicates. This means the
common pattern below results in **one** network request, and **both** callers resolve with the same
data — no abort rejection:

```typescript
const [a, b] = await Promise.all([
  client.collection('posts').getFullList(),
  client.collection('posts').getFullList()
]);
// one GET fired; a === b
```

Calls with **different** options (e.g. different `sort`/`filter`) are still distinct requests.
Multi-page fetches continue to work normally — each page request is unique (page number is part of
the URL), so pages never cancel each other.

The underlying `singleFlight` option is also available on any request when you want to coalesce
concurrent identical calls yourself:

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
    console.log(err.status); // HTTP status code
    console.log(err.message); // Error message
    console.log(err.data); // Full response data
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
  remove: async (key) => await AsyncStorage.removeItem(key)
};

const client = new LazypockClient({
  baseUrl: 'http://localhost:4000/api',
  storage: customStorage
});
```

### Auto Token Refresh

The SDK automatically refreshes expired auth tokens. When a token expires, the next API call triggers
a transparent refresh via the `auth-refresh` endpoint. No manual intervention needed.
