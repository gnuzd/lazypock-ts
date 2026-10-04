---
title: Auth
---

# Auth

## Authentication methods

- `login(email, password, collection?)` — Login as superuser or auth collection user
- `authWithPassword(collection, identity, password, options?)` — Auth collection login
- `authRefresh(collection, options?)` — Refresh auth token
- `checkSuperuser()` — Check if any superuser exists
- `setup(email, password)` — Create initial superuser
- `logout()` — Clear auth state
- `me(options?)` — Get current superuser profile

## Auth collections

Collections can be **base** (`type: "base"`, plain records) or **auth** (`type: "auth"`, accounts —
the built-in `users` collection is an auth collection). Auth collections have an email field and a
write-only password field, plus system fields (`verified`, `emailVisibility`).

The `password` field is **write-only**:

- **Hidden** — never returned by the server, never shown in the Studio record browser, and omitted
  from the generated **read model** (`UsersRecord`).
- **Optional** — accounts may exist without a password (e.g. OAuth-only users or invite flows), so
  `create()` typechecks without it.

```typescript
// Create a user (password optional + write-only)
const user = await client.collection('users').create({
  email: 'ada@example.com',
  password: 'correct-horse-battery' // hashed server-side, never returned
});

// Login to an auth collection
const session = await client.authWithPassword('users', 'ada@example.com', 'correct-horse-battery');
// session.token — stored in client.authStore for subsequent requests
```

## OAuth2

Sign in with an OAuth2 provider (Google, GitHub, Apple, …) on an auth collection.

### Popup flow (web)

```typescript
const auth = await client.collection('users').authWithOAuth2({ provider: 'google' });
// auth.token + auth.record + auth.meta (isNew, email, avatarURL, …)
// client.authStore is populated when the promise resolves
```

One call handles the whole flow: it fetches the provider's authorization URL,
opens a popup, receives the single-use authorization `code` the backend relays
via `postMessage`, exchanges it, and populates the auth store — the same result
shape as `authWithPassword`. `createData` is forwarded on first sign-up.

Options:

- `provider` (required) — the provider name, e.g. `'google'`
- `createData` — extra fields merged into the record on first sign-up
- `urlCallback(url)` — called with the authorization URL instead of opening a
  popup (the presented window must preserve `window.opener`)
- `popup: { width, height }` — popup geometry (default 500×700)
- `timeoutMs` — abandon after this long (default 120000)

### Direct code exchange (mobile / non-browser)

The popup flow depends on `window.postMessage`, so on React Native (or when you
present the URL yourself), capture the `code` from your redirect and exchange it:

```typescript
const methods = await client.collection('users').listAuthMethods();
const google = methods?.oauth2.providers.find((p) => p.name === 'google');
// …present google.authURL (expo-web-browser, ASWebAuthenticationSession, …)
// …capture the redirect `code` via your deep link, then:
const auth = await client.collection('users').authWithOAuth2Code({
  provider: 'google',
  code,
  codeVerifier: google.codeVerifier,
  createData: { /* extra fields on first sign-up */ },
});
```

### Available providers

```typescript
const methods = await client.collection('users').listAuthMethods();
// methods.oauth2.providers → [{ name, authURL, state, codeVerifier }]
```

### Notes

- The backend creates the PKCE `state`/`codeVerifier` and validates the pending
  session on the redirect. The popup page relays **only the single-use
  authorization `code`** (never a token or user record); the SDK then exchanges
  it via `authWithOAuth2Code`.
- The `codeVerifier` returned by `listAuthMethods()` is the PKCE verifier, not a
  provider secret — `client_secret` never leaves the backend.
- The popup flow posts the result back to the origin that started it, so it also
  works when the API and the app are on different origins (as long as the app's
  origin is in the server's allowed origins / `LAZYPOCK_CORS_ORIGINS`).

## AuthStore

Handles token persistence and auto-refresh.

- `token` — Current JWT token
- `model` — Current auth model (user record or null)
- `isValid` — Whether a token exists
- `isExpired` — Whether the current token has expired (with 30s buffer)
- `collectionName` — Name of the auth collection for this session (`null` for superuser sessions)
- `set(token, model)` — Update token and model
- `setCollectionName(name)` — Set the auth collection name for token refresh
- `clear()` — Clear all auth state
- `onChange(callback)` — Listen for auth changes (returns unsubscribe function)
- `init()` — Restore persisted auth from storage

`collectionName` is **persisted with the token and model**, so it survives a page reload: signing in
with an auth collection, calling `client.authStore.init()` on startup and reading
`client.authStore.collectionName` always gives the collection (e.g. `"users"`). It is derived from
`record.collectionName` when the server includes it, so sessions stored by older versions recover it
too. Superuser sessions have `collectionName === null` by design.

### Changing the current user's password

```typescript
// Which collection is this session for? (`null` for superuser sessions)
const collection = client.authStore.collectionName;
const userId = client.authStore.model?.id;

if (!collection || !userId) throw new Error('Not signed in with an auth collection');

await client.collection(collection).update(userId, {
  password: 'new-secret',
  passwordConfirm: 'new-secret'
});
```

The record-update rule of the collection must allow the user to update their own record (or the
caller must be a superuser). For the emailed-token flow use
`client.collection(name).requestPasswordReset(email)` and
`confirmPasswordReset(token, password, passwordConfirm)`.

> **Note:** the server does not currently require `oldPassword` for a self-service password change
> (PocketBase does). Until that is enforced server-side, ask for the current password in your UI and
> re-authenticate (`authWithPassword`) before updating if you need that guarantee.

### Auto token refresh

The SDK automatically refreshes expired auth tokens. When a token expires, the next API call triggers
a transparent refresh via the `auth-refresh` endpoint. No manual intervention needed. This relies on
`authStore.collectionName`, which is why it is persisted with the session.
