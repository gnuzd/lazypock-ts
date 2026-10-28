---
title: Mail
---

# Mail

Send email through the deployment's SMTP settings, and manage the templates it renders.

Sending **queues** a job; it does not deliver inline. A provider that is slow or down must not hold a
request open, and the queue already retries with backoff — so the response means "queued", not
"delivered". Follow `id` in `GET /api/logs` for a send that failed.

```typescript
// A template: the server renders it and sends the result
await client.mail.send({
  to: 'ada@example.com',
  toName: 'Ada',
  template: 'receipt',
  assigns: { total: 42, currency: 'USD' }
});

// A raw message
await client.mail.send({
  to: 'ada@example.com',
  subject: 'Your export is ready',
  text: 'Download it here: https://…'
});
```

## Sending

| Method | Description |
| --- | --- |
| `send({ to, template, assigns? }, options?)` | Queue a message from a template |
| `send({ to, subject, html?, text? }, options?)` | Queue a raw message (`html` and/or `text`) |

`to` is shape-checked (one `@`, no whitespace or control characters, at most 254 characters); the
SMTP server is still the authority on whether the address exists. A message needs either a `template`
or a `subject`, and the type requires one of them — sending both is refused by the server, as is a
template with a raw body.

## Templates

A template has three parts — `subject`, `html`, `text` — and resolves three layers, newest first:

| Layer | Meaning |
| --- | --- |
| `database` | Saved through this API (or Studio). The one in effect. |
| `file` | A file in the deployment's template directory. |
| `builtin` | Shipped with the server. |

Every response reports the layer each part resolved from, because an edit that is in effect and one
that is not look identical otherwise. To go back to the file or the built-in, delete the stored parts.

```typescript
const templates = await client.mail.listTemplates();
for (const template of templates) {
  console.log(template.name, template.source);      // strongest layer
  console.log(template.parts.html);                 // per-part layer: database | file | builtin
}

// Edit: all three parts at once
await client.mail.saveTemplate('receipt', {
  subject: 'Your receipt ({{ total }})',
  html: '<p>Thanks! Total: {{ total }}</p>',
  text: 'Thanks! Total: {{ total }}'
});

// Reset: back to the file, or the built-in
await client.mail.deleteTemplate('receipt'); // { name, deleted }
```

| Method | Description |
| --- | --- |
| `listTemplates(options?)` | Every template the server can send, with resolved bodies and layers |
| `getTemplate(name, options?)` | One template |
| `saveTemplate(name, parts, options?)` | Replace all three parts (parsed before it is stored) |
| `deleteTemplate(name, options?)` | Remove the stored parts (`deleted: 0` if never saved) |
| `preview(name, draft?, options?)` | Render without storing or sending |

## Previewing a draft

A preview renders the template exactly as a send would, with any of `subject`/`html`/`text` in `draft`
used in place of the stored part. Nothing is saved, so a body can be rendered while it is still being
written.

```typescript
const rendered = await client.mail.preview('receipt', {
  assigns: { total: 42 },
  html: '<p>Draft: {{ total }}</p>'   // only the draft part is substituted
});

if (rendered) {
  iframe.srcdoc = rendered.html;      // render in a sandboxed iframe, never innerHTML
}
```

A draft over a name the server does not know is previewed as the new template it is being written as,
so such a draft has to arrive complete — all three parts.

Previews share one auto-cancellation key (`POST /mail/templates/<name>/preview`), so a newer preview
aborts an older one and the older promise rejects with an `ApiError` whose `isAbort` is `true`. Pass
`{ requestKey: null }` to keep every preview instead.

## Permissions

Sending an already-defined template is **API-keyable** — an application server should not need a
superuser's password to send mail. Defining, listing, previewing or deleting a template is
**superuser-only, and deliberately not API-keyable**: a template is rendered with the variables of an
auth email (a verification or password-reset token, the recipient's address), so whoever can write one
can mail themselves somebody else's token.

## Limits

| Field | Limit |
| --- | --- |
| `subject` (raw message) | 300 characters, no control characters |
| `html` / `text` (raw message) | 256 KiB each |
| `assigns` | 64 KiB serialized |
| Template part | 64 KiB each |
| Template name | 64 characters, no whitespace or control characters |
