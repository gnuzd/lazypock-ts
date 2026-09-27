---
title: Queries
---

# Queries

## `select(...)` — pick the fields you want

`select()` projects list/read responses to the given fields (PocketBase `fields` param). Field names
are **type-checked** when the service is typed:

```typescript
const t = await client.collection('posts').select('id', 'title').getList();
// GET /api/posts?fields=id,title

await client.collection('posts').select('id', 'title').getOne('abc123'); // same
```

- `select('*')` (or no `select()` call) — request all visible fields; hidden fields are excluded
  automatically when a schema is available.
- `select()` with no arguments resets back to the default.
- `select()` returns a **derived service** — the original is untouched, so you can keep one default
  service and project per-request.
- Passing an explicit `fields` option overrides the `select()` preset.

When a schema is known (via `types.schemas` or codegen), hidden fields are **not returned by the
server**: every read sends `fields=<visible fields>` by default, and selecting an unknown field logs
a warning.

## `filter` / `sort` / `expand` — type-checked suggestions

With a typed service, the query options validate field names (and filter operators) at compile time —
your editor suggests valid fields as you type:

```typescript
await postsSvc.getList(1, 20, { sort: '-title' }); // ✓ suggests title/published/…
await postsSvc.getList(1, 20, { sort: '-nope' }); // ✗ compile error

await postsSvc.getList(1, 20, {
  filter: "title ~ 'x' && published = true" // ✓ field + operator checked
});
await postsSvc.getList(1, 20, { filter: 'nope = 1' }); // ✗ compile error

await postsSvc.getList(1, 20, { expand: 'author' }); // ✓ field suggested
await postsSvc.getList(1, 20, { expand: 'author.name,author.email' }); // ✓ expand + select fields
await postsSvc.getOne('abc', { expand: 'author' });
```

- `filter` — `field op value` clauses with `= != ~ !~ > >= < <=` operators, plus the PocketBase
  `?`-prefixed array operators `?= ?!= ?~ ?!~ ?> ?>= ?< ?<=` (see below); `&&`, `||`, `!`, and
  parentheses are allowed after the first clause.
- `sort` — `field`, `-field` (desc), `+field`, or comma-separated.
- `expand` — comma-separated relation field names; non-relation fields warn at runtime when a schema
  is available.
- The **untyped** client (`client.collection('posts')` without `typed<T>()`) still accepts any
  string — suggestions kick in once the service is typed.

### Autocomplete: use the array forms for `sort` / `expand`

A comma-separated string is validated as a whole (template-literal types can't suggest each token).
Pass an **array** instead for per-token autocomplete — elements are field-checked exactly the same:

```typescript
await postsSvc.getList(1, 20, { sort: ['-title', 'published'] }); // editor suggests each
await postsSvc.getList(1, 20, { expand: ['author', 'owner.name'] });

await postsSvc.getList(1, 20, { sort: ['-nope'] });   // ✗ compile error
await postsSvc.getList(1, 20, { expand: ['nope'] });  // ✗ compile error
```

### The typed filter builder

`service.where(field)` starts a type-checked filter expression. The field name is suggested from the
collection's key set and operators are methods, so typos are impossible; values are quoted/escaped
for you (no manual interpolation):

```typescript
const q = postsSvc.where;
q('title').eq('x');             // title = 'x'
q('title').contains('x');       // title ~ 'x'
q('published').eq(true);        // published = true
q('views').gt(100);             // views > 100
q('created').gte('2024-01-01'); // created >= '2024-01-01'
q('title').eq(null);            // title = null  (IS NULL)
q('tags').anyEq('news');        // tags ?= 'news'   (array operator)
q('tags').anyContains('new');   // tags ?~ 'new'
q('id').in(['a', 'b', 'c']);    // (id = 'a' || id = 'b' || id = 'c')  — list membership
q('id').notIn(['a', 'b']);      // (id != 'a' && id != 'b')

// Compose with and() / or() / not():
const filter = q('title').contains('x').and(q('published').eq(true));
await postsSvc.getList(1, 20, { filter });
await postsSvc.getFirstListItem(q('title').eq('x'));
```

Methods: `eq`, `neq`, `contains`, `notContains`, `gt`, `gte`, `lt`, `lte`, the array variants
`anyEq`, `anyNeq`, `anyContains`, `anyNotContains`, `anyGt`, `anyGte`, `anyLt`, `anyLte`, and
`in` / `notIn` for list membership (no hand-written `or()` chains for a list of ids), plus
`and`, `or`, `not`, and `toString()`. Values are checked as filter scalars
(`string | number | boolean | null`) and the server enforces the exact per-field type. The raw
string form stays fully supported for dynamic/advanced expressions.

### Selecting fields of an expanded relation

PocketBase's `expand` parameter only understands **relations**:
`expand=author.name` is silently ignored (and cancels the `author` expansion)
because `name` is not a relation. Lazypock detects a dotted tail that is not a
relation and rewrites the query to the correct PocketBase form, so the
shorthand works:

```typescript
await postsSvc.getFullList({ expand: 'author.name,author.email' });
// → GET /api/posts?expand=author&fields=*,expand.author.name,expand.author.email
// posts[0].expand.author === { name: '…', email: '…' }
```

A dotted path whose segments are all **relations** keeps its nested-expand
meaning (`expand: 'author.user'` expands the `user` relation on the author).
Disambiguation needs the target collection's schema — the codegen
`createClient()` wires it in automatically. Without a schema, two or more
dotted tokens under the same relation are treated as a field selection, while
a lone dotted token stays a nested relation and logs a warning.

An active projection (`select(...)`, the schema default, or an explicit
`fields`) is preserved — the expand entries are merged in, so expanded data is
never silently dropped by the server's strict `fields` filter.

### The `?` operators — any/at-least-one-of

PocketBase array-valued fields (multi-select, multiple relation, multiple file) apply a **match-all**
constraint by default. Prefix the operator with `?` for an **any/at-least-one-of** constraint:

```typescript
// tags is a multi-select field (string[])
await postsSvc.getList(1, 20, { filter: "tags ?= 'news'" }); // has 'news'
await postsSvc.getList(1, 20, { filter: "tags ?!= 'news'" }); // has a tag ≠ 'news'
await postsSvc.getList(1, 20, { filter: "tags ?~ 'new'" }); // a tag contains 'new'
await postsSvc.getList(1, 20, { filter: "tags ?= 'news' && published = true" });
```

| Operator | Meaning |
| --- | --- |
| `?=` | any element equals |
| `?!=` | any element differs |
| `?~` | any element matches (auto-wrapped in `%…%`) |
| `?!~` | any element does not match |
| `?>` / `?>=` / `?<` / `?<=` | any element compares |

The backend compiles `?=` to `= ANY (...)` and `?~` / `?!~` to an `ILIKE` over `unnest(...)`, so the
suggestion types accept these operators wherever the server does.
