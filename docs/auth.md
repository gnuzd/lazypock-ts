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
opens a popup, waits for the backend's redirect result (delivered via
`postMessage`), and populates the auth store — the same result shape as
`authWithPassword`.

Options:

- `provider` (required) — the provider name, e.g. `'google'`
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

- The provider's `code`/`state`/PKCE `codeVerifier` are handled by the backend —
  the SDK never touches them in the popup flow.
- `createData` on `authWithOAuth2` is accepted for PocketBase parity but is not
  forwarded by the popup redirect flow; use `authWithOAuth2Code` for that.

## AuthStore

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

### Auto token refresh

The SDK automatically refreshes expired auth tokens. When a token expires, the next API call triggers
a transparent refresh via the `auth-refresh` endpoint. No manual intervention needed.
