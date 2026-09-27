---
title: Queries
---

# Queries

Everything you can pass to `getList`, `getFullList`, `getFirstListItem`, and
`getOne`: **sorting**, **filtering**, **relation expansion**, and **field
projection**. Each section starts with the simplest form and ends with the
typed helpers.

> **New here?** Use the [recipes](#recipes) at the bottom for the most common
> tasks (fetch by ids, search, filter by relation, …).

## Quick reference

Throughout this guide `q` is the typed filter builder:

```typescript
const q = postsSvc.where;
```

| I want to… | Do this |
| --- | --- |
| Sort newest first | `getFullList({ sort: ['-created'] })` |
| Sort by two fields | `getList(1, 20, { sort: ['-published', 'title'] })` |
| Filter by a list of ids | `getFullList({ filter: q('id').in(ids) })` |
| Search a text field | `getList(1, 20, { filter: q('title').contains(term) })` |
| Filter by relation id | `getFullList({ filter: q('author').eq(userId) })` |
| Combine conditions (AND) | `q('published').eq(true).and(q('views').gt(100))` |
| Either of two conditions (OR) | `q('a').eq(1).or(q('b').eq(2))` |
| Negate a condition | `q('archived').eq(true).not()` |
| Also fetch the related record | `getList(1, 20, { expand: ['author'] })` |
| Only some fields of the related record | `getList(1, 20, { expand: ['author.name', 'author.email'] })` |
| Return only some fields | `client.collection('posts').select('id', 'title').getList()` |

Every option works with the raw string form too — the builder is a
convenience that checks field names and escapes values for you.

---

## Sorting

`sort` accepts a comma-separated string or an **array**. `-` means descending,
a bare field (or `+field`) means ascending.

```typescript
// String form
await postsSvc.getList(1, 20, { sort: '-created' });
await postsSvc.getList(1, 20, { sort: 'title,-published' });

// Array form — one entry per field (recommended: the editor suggests each one)
await postsSvc.getList(1, 20, { sort: ['-created'] });
await postsSvc.getList(1, 20, { sort: ['title', '-published'] });
```

| Form | Editor suggests fields? | Validated? |
| --- | --- | --- |
| `sort: '-title,published'` (string) | No (only the whole string) | ✅ every token |
| `sort: ['-title', 'published']` (array) | ✅ each entry | ✅ each entry |

Unknown fields are a **compile error** on a typed service:

```typescript
await postsSvc.getList(1, 20, { sort: ['-nope'] }); // ✗ compile error
```

---

## Filtering

There are two ways to build a filter:

1. **Filter expression string** — full PocketBase syntax, validated at compile
   time on typed services. Best for dynamic strings and advanced expressions.
2. **Typed builder** (`service.where(field)`) — field names are suggested,
   operators are methods, and values are escaped automatically. Best for
   hand-written queries.

Both produce the same thing and can be mixed: pass either as `filter`.

### Filter expressions (string)

The syntax is `field operator value`, combined with `&&` (and), `||` (or),
`!` (not), and parentheses.

```typescript
await postsSvc.getList(1, 20, { filter: "title ~ 'hello'" });
await postsSvc.getList(1, 20, { filter: "published = true" });
await postsSvc.getList(1, 20, { filter: "views >= 100" });
await postsSvc.getList(1, 20, { filter: "title ~ 'a' && published = true" });
await postsSvc.getList(1, 20, { filter: "(title = 'a' || title = 'b')" });
```

> **Filter fields are top-level collection fields.** To filter by a relation,
> compare the relation field with the related record's id
> (`author = 'USER_ID'`). Relation *dot-paths* (`author.email = 'x'`) are part
> of PocketBase's syntax but the LazyPock filter engine does not compile them
> (it returns `400 Invalid filter expression`), so avoid them.

#### Operators

| Operator | Meaning | Example |
| --- | --- | --- |
| `=` | equal | `status = 'open'` |
| `!=` | not equal | `status != 'closed'` |
| `~` | contains (LIKE) | `title ~ 'hello'` |
| `!~` | does not contain | `title !~ 'draft'` |
| `>` `>=` `<` `<=` | comparisons | `views >= 100` |
| `?=` | any array element equals | `tags ?= 'news'` |
| `?!=` | any array element differs | `tags ?!= 'news'` |
| `?~` | any array element contains | `tags ?~ 'new'` |
| `?!~` | any array element does not contain | `tags ?!~ 'new'` |
| `?>` `?>=` `?<` `?<=` | any array element compares | `scores ?> 10` |

Strings use single or double quotes. Values containing `&&`, `||`, or quotes
must be quoted (`title ~ 'a && b'`). On a typed service **every clause** is
checked — a typo in any field or operator is a compile error:

```typescript
await postsSvc.getList(1, 20, { filter: "title = 'a' && nope = 'b'" }); // ✗ compile error
```

### The typed filter builder

Start a clause with `service.where(field)`, pick an operator method, then
combine expressions. Field names are suggested from the collection's schema,
and values are quoted/escaped by the builder.

```typescript
const q = postsSvc.where;

// one clause
await postsSvc.getList(1, 20, { filter: q('title').contains('hello') });

// combine
await postsSvc.getList(1, 20, {
  filter: q('title').contains('hello').and(q('published').eq(true)),
});
```

#### Comparison methods

| Method | Emits | Notes |
| --- | --- | --- |
| `eq(v)` | `field = v` | use `eq(null)` for *is empty* |
| `neq(v)` | `field != v` | |
| `contains(v)` | `field ~ v` | text search |
| `notContains(v)` | `field !~ v` | |
| `gt(v)` / `gte(v)` | `field > v` / `field >= v` | |
| `lt(v)` / `lte(v)` | `field < v` / `field <= v` | |
| `in(values)` | `(field = a \|\| field = b \|\| …)` | **list membership** |
| `notIn(values)` | `(field != a && field != b && …)` | |

#### Array ("any element") methods

For multi-select / multiple-relation / multiple-file fields, prefix with `any`:

| Method | Emits |
| --- | --- |
| `anyEq(v)` | `field ?= v` |
| `anyNeq(v)` | `field ?!= v` |
| `anyContains(v)` | `field ?~ v` |
| `anyNotContains(v)` | `field ?!~ v` |
| `anyGt(v)` / `anyGte(v)` | `field ?> v` / `field ?>= v` |
| `anyLt(v)` / `anyLte(v)` | `field ?< v` / `field ?<= v` |

#### Combining expressions

| Method | Emits | Meaning |
| --- | --- | --- |
| `.and(other)` | `(a && b)` | both must match |
| `.or(other)` | `(a \|\| b)` | either may match |
| `.not()` | `!(a)` | invert |
| `.toString()` | — | the raw filter string |

Combinations are parenthesised, so chaining never introduces precedence
surprises:

```typescript
const filter = q('title').contains('x').and(q('published').eq(true));
// → (title ~ 'x' && published = true)

await postsSvc.getList(1, 20, {
  filter: q('status').eq('open').or(q('status').eq('pending')).not(),
});
// → !((status = 'open' || status = 'pending'))
```

#### Values and escaping

Values may be `string`, `number`, `boolean`, or `null`. Strings are
single-quoted and escaped for you, so inputs like `it's` are safe:

```typescript
q('title').eq("it's"); // → title = 'it\'s'
```

The builder checks values as filter scalars; the server enforces the exact
per-field type. An empty `in([])` / `notIn([])` throws (it can never match —
that is usually a bug).

#### Mixing builder and string

A builder expression can be passed wherever a filter string is accepted, and
you can still use the raw string for advanced cases:

```typescript
await postsSvc.getFirstListItem(q('slug').eq('hello-world'));
await postsSvc.getList(1, 20, { filter: "title ~ 'x' && published = true" });
```

---

## Expanding relations

`expand` fetches the referenced records and attaches them under
`record.expand` instead of leaving just the id. It accepts a comma-separated
string or an array.

```typescript
const post = await postsSvc.getOne('abc123', { expand: 'author' });
post.expand?.author?.email; // the full related record

// array form (per-token autocomplete)
const posts = await postsSvc.getFullList({ expand: ['author', 'category'] });
```

`record.author` stays the relation id; the related record is on
`record.expand.author`.

### Nested relations

Use a dot-path to expand a relation *of* a relation:

```typescript
await postsSvc.getFullList({ expand: ['author.profile'] });
// post.expand.author.expand.profile
```

### Only some fields of the expanded record

Add the field(s) after the relation:

```typescript
await postsSvc.getFullList({ expand: ['author.name', 'author.email'] });
// post.expand.author === { name: '…', email: '…' }  (no other fields)

// combine a full expansion with a narrowed one
await postsSvc.getFullList({ expand: ['author', 'category.name'] });
```

The SDK applies this selection itself, so it works the same against every
server: PocketBase narrows it server-side, the LazyPock server returns the
full related record and the SDK keeps only the requested fields.

> **How this works:** `expand` only understands *relations* —
> `expand=author.name` on its own is ignored. The SDK detects that `name` is
> not a relation, asks for the `author` relation instead, and then keeps only
> the requested fields.
>
> Distinguishing "field on the relation" from "nested relation" needs the
> target collection's schema. The codegen `createClient()` wires schemas in
> automatically; with a hand-written client, pass `types.schemas`. Without a
> schema, two or more dotted tokens under one relation are treated as a field
> selection, and a lone dotted token stays a nested relation (with a warning).

### Typed results

With a codegen/typed service, `record.expand.author` is typed as the target
collection's record, so `post.expand?.author?.email` autocompletes instead of
being `unknown`.

### Expanded records are never dropped

If you also project fields (`select(...)` or an explicit `fields`), the
`expand.*` entries are merged into the projection, so the server's strict
`fields` filter can't silently remove the expanded data.

---

## Projecting fields

`select(...)` limits the fields returned by reads (PocketBase `fields`). It
returns a derived service — the original is untouched.

```typescript
const slim = client.collection('posts').select('id', 'title');
const list = await slim.getList(1, 20);
// GET /api/posts?fields=id,title

await slim.getOne('abc123');
```

- `select('*')` (or no `select()` call) requests all visible fields.
- `select()` with no arguments resets to the default.
- When a schema is known, hidden fields are excluded from responses.
- An explicit `fields` option overrides the `select()` preset for that call.

---

## Recipes

### Fetch records by a list of ids

```typescript
const q = postsSvc.where;
const posts = await postsSvc.getFullList({ filter: q('id').in(ids) });
```

`in()` builds the `(id = 'a' || id = 'b' || …)` expression PocketBase needs.

### Search a text field

```typescript
const q = postsSvc.where;
await postsSvc.getFullList({ filter: q('title').contains(search) });
// or: filter: `title ~ '${search.replaceAll("'", "\\'")}'`  — the builder escapes for you
```

### Filter by relation, and show the related record

```typescript
const q = postsSvc.where;
const posts = await postsSvc.getFullList({
  filter: q('author').eq(userId),
  expand: ['author.name'],
});
```

> To filter on a field *of* the related record, resolve the related id first
> and filter by the relation (`q('author').eq(userId)`), or filter against a
> denormalized copy of that field. The LazyPock filter engine compiles
> top-level fields only — relation dot-paths (`author.email = 'x'`) return
> `400`.

### Filter by status, newest first, expand the author

```typescript
const q = postsSvc.where;
await postsSvc.getList(1, 20, {
  filter: q('status').eq('published').and(q('views').gte(100)),
  sort: ['-created'],
  expand: ['author.name'],
});
```

### Unpublished drafts, excluding archived

```typescript
const q = postsSvc.where;
await postsSvc.getFullList({
  filter: q('published').eq(false).and(q('archived').eq(true).not()),
});
```

### Any tag matches

```typescript
await postsSvc.getList(1, 20, { filter: "tags ?= 'news'" });
// or with the builder:
await postsSvc.getList(1, 20, { filter: postsSvc.where('tags').anyEq('news') });
```
