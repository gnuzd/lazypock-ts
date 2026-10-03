---
title: Files
---

# Files

Upload, list, delete and build URLs for file records. Richtext/Markdown fields store plain URLs, so
the same helpers work for images embedded in content.

```typescript
// Upload a file (through the app)
const file = await client.files.upload(input.files[0], undefined, undefined, {
  collectionName: 'posts',
  fieldName: 'cover',
  origin: 'library', // field | editor | library
  variants: ['content'] // generate this preset before the response
});

// Direct-to-bucket upload (S3/R2): presign → PUT → verify
const direct = await client.files.uploadDirect(input.files[0], {
  collectionName: 'posts',
  fieldName: 'cover'
});

// List the library (superuser)
const { items, total } = await client.files.list({ mime: 'image/', q: 'sunset', page: 1 });

// Delete one
await client.files.delete(file!.id);
```

## Upload methods

| Method | Description |
| --- | --- |
| `upload(file, filename?, options?, meta?)` | Multipart upload through the app. `meta` accepts `collectionName`, `recordId`, `fieldName`, `origin` (`field` \| `editor` \| `library`) and `variants` |
| `uploadDirect(file, opts?)` | Presign → `PUT` straight to the bucket → verify. Falls back to `upload()` when the server has no direct upload |
| `presign({ filename, size, mime, ... })` | Step 1 on its own: returns `{ id, key, method, url, headers }` |
| `complete(fileId, { variant? })` | Step 2 on its own: verify the uploaded object |
| `list({ mime?, q?, page?, perPage? })` | Library listing (superuser) |
| `delete(fileId)` | Delete the file and its variants (superuser) |

## URLs

| Helper | Result |
| --- | --- |
| `getFileUrl(baseUrl, fileId)` | The original: `/api/files/<id>` |
| `getThumbUrl(baseUrl, fileId, size)` | Legacy thumbnail: `/thumbs/<size>` |
| `getScaleUrl(baseUrl, fileId, size)` | Arbitrary size: `/scale/300x200` |
| `getVariantUrl(baseUrl, fileId, preset)` | Named preset: `/scale/content` |

## File records

A `FileRecord` carries ready-made URLs, so you rarely build them by hand:

```json
{
  "id": "1f0c…",
  "filename": "sunset.png",
  "mimeType": "image/png",
  "size": 482913,
  "url": "/api/files/1f0c…",
  "thumbs": { "100x100": "/api/files/1f0c…/thumbs/100x100" },
  "variants": {
    "thumb": "/api/files/1f0c…/scale/thumb",
    "content": "https://cdn.example.com/lazypock/1f0c…/content.webp"
  }
}
```

> Embedded images should use the `content` variant (`getVariantUrl(url, id, 'content')`), never the
> original — that is what the Studio editor inserts. See
> [File storage & images](https://lazypock.gnuzd.dev/files) for presets, storage backends and
> presigned uploads.

## Utilities

- `getFileUrl(baseUrl, fileId)` — Construct a file URL from base URL and file ID (utility).
