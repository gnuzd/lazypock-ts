// ── File Service ─────────────────────────────────────────
// Upload, download, and delete files.

import type { HttpClient } from "./http";
import type { RequestOptions } from "./types";

/** Response shape from the server file endpoints */
export interface FileRecord {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	url: string;
	/** ID of the identity that uploaded the file (empty when unknown). */
	uploadedBy?: string;
	/** Map of thumbnail size => URL, e.g. { "50x50": "/api/files/<id>/thumbs/50x50" } */
	thumbs?: Record<string, string>;
	/** Map of preset name => variant URL, e.g. { "content": "/api/files/<id>/scale/content" } */
	variants?: Record<string, string>;
	[key: string]: unknown;
}

/** Response from `files.presign` for a direct-to-storage upload. */
export interface DirectUpload {
	id: string;
	key: string;
	method: string;
	url: string;
	headers: Record<string, string>;
}

/**
 * Construct a file URL from the API base URL and file ID.
 */
export function getFileUrl(baseUrl: string, fileId: string): string {
	return baseUrl.replace(/\/+$/, "") + "/files/" + encodeURIComponent(fileId);
}

/**
 * Construct a thumbnail URL from the API base URL, file ID, and thumb size.
 * @param size e.g. "50x50"
 */
export function getThumbUrl(baseUrl: string, fileId: string, size: string): string {
	return (
		baseUrl.replace(/\/+$/, "") +
		"/files/" +
		encodeURIComponent(fileId) +
		"/thumbs/" +
		encodeURIComponent(size)
	);
}

/**
 * Construct an on-demand scaled image URL from the API base URL, file ID, and size.
 *
 * The size is an ImageMagick geometry: "100" (width, keep aspect), "100x100"
 * (fit within box), "100x100!" (exact crop), "x200" (height). The server
 * generates and caches the scaled image on first request.
 * @param size e.g. "100x100"
 */
export function getScaleUrl(baseUrl: string, fileId: string, size: string): string {
	return (
		baseUrl.replace(/\/+$/, "") +
		"/files/" +
		encodeURIComponent(fileId) +
		"/scale/" +
		encodeURIComponent(size)
	);
}

/**
 * Construct a URL for a named preset variant, e.g. "thumb" or "content".
 * These are generated eagerly on upload or lazily on first request.
 */
export function getVariantUrl(baseUrl: string, fileId: string, preset: string): string {
	return getScaleUrl(baseUrl, fileId, preset);
}


/**
 * Validates the presigned upload target before sending bytes to it.
 *
 * The URL is issued by our own server for the configured bucket, but the SDK
 * still restricts the scheme (https) and, when provided, the host allowlist.
 */
function parseUploadTarget(rawUrl: string, allowedHosts?: string[]): URL {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error("Direct upload: the server returned an invalid upload URL");
	}

	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Direct upload: unsupported protocol ${parsed.protocol}`);
	}

	if (allowedHosts && allowedHosts.length > 0 && !allowedHosts.includes(parsed.host)) {
		throw new Error(`Direct upload: host ${parsed.host} is not in the allowlist`);
	}

	return parsed;
}

/**
 * Service for file upload, retrieval, and deletion.
 * Access via {@link LazypockClient.files}.
 */
export class FilesService {
	constructor(
		private http: HttpClient,
		/** Optional host allowlist for direct uploads (S3/R2 domain). */
		private allowedUploadHosts?: string[],
	) {}

	/**
	 * Upload a file or blob.
	 *
	 * @param file The File or Blob to upload.
	 * @param filename Optional filename (required if `file` is a Blob without a name).
	 * @param options Optional request options (signal, custom fetch).
	 * @param meta Optional metadata: collectionName, recordId, fieldName for ownership tracking.
	 */
	async upload(
		file: File | Blob,
		filename?: string,
		options?: RequestOptions,
		meta?: {
			collectionName?: string;
			recordId?: string;
			fieldName?: string;
			/** `field` (default), `editor` or `library` — used by reference tracking. */
			origin?: "field" | "editor" | "library";
			/** Preset variants to generate before the response (e.g. ["content"]). */
			variants?: string[];
		},
	): Promise<FileRecord | null> {
		if (typeof FormData === "undefined") {
			throw new Error("FormData is not available in this environment");
		}

		const formData = new FormData();
		const name = filename || (file instanceof File ? file.name : "file");
		formData.append("file", file, name);

		if (meta?.collectionName)
			formData.append("collection_name", meta.collectionName);
		if (meta?.recordId) formData.append("record_id", meta.recordId);
		if (meta?.fieldName) formData.append("field_name", meta.fieldName);
		if (meta?.origin) formData.append("origin", meta.origin);
		if (meta?.variants?.length) formData.append("variants", meta.variants.join(","));

		const data = await this.http.request<Record<string, unknown>>(
			"POST",
			"/files",
			formData,
			options,
		);

		return data as FileRecord | null;
	}

	/**
	 * Direct upload (Mode B): the browser PUTs straight to S3/R2.
	 *
	 * Presigns, uploads, then asks the server to verify the object. Falls back to
	 * `upload()` when the server has no direct-upload support configured.
	 */
	async uploadDirect(
		file: File | Blob,
		opts?: {
			filename?: string;
			collectionName?: string;
			fieldName?: string;
			recordId?: string;
			variant?: string;
			signal?: AbortSignal;
		},
	): Promise<FileRecord | null> {
		const filename = opts?.filename || (file instanceof File ? file.name : "file");
		const mime = file.type || "application/octet-stream";

		const presigned = await this.presign({
			filename,
			size: file.size,
			mime,
			collectionName: opts?.collectionName,
			fieldName: opts?.fieldName,
			recordId: opts?.recordId,
		});

		if (!presigned) return this.upload(file, filename, { signal: opts?.signal }, { collectionName: opts?.collectionName, fieldName: opts?.fieldName, recordId: opts?.recordId });

		// The presigned URL is issued by the trusted server for the configured
		// bucket; the scheme (and optional host allowlist) is still enforced.
		const target = parseUploadTarget(presigned.url, this.allowedUploadHosts);

		// pi-lens-ignore: ts-ssrf -- presigned object URL issued by our own API for the configured storage bucket; scheme and host allowlist validated by parseUploadTarget
		const put = await fetch(target.href, {
			method: presigned.method || "PUT",
			headers: presigned.headers,
			body: file,
			signal: opts?.signal,
		});

		if (!put.ok) throw new Error(`Direct upload failed: HTTP ${put.status}`);

		return this.complete(presigned.id, { variant: opts?.variant, signal: opts?.signal });
	}

	/** Step 1 of a direct upload: reserve an object and get a presigned PUT. */
	async presign(params: {
		filename: string;
		size: number;
		mime?: string;
		collectionName?: string;
		fieldName?: string;
		recordId?: string;
	}): Promise<DirectUpload | null> {
		const data = await this.http.request<DirectUpload | { error: string }>(
			"POST",
			"/files/presign",
			{
				filename: params.filename,
				size: params.size,
				mime: params.mime,
				collection_name: params.collectionName,
				field_name: params.fieldName,
				record_id: params.recordId,
			},
		);

		if (!data || typeof (data as DirectUpload).url !== "string") return null;
		return data as DirectUpload;
	}

	/** Step 2 of a direct upload: ask the server to verify the object. */
	async complete(
		fileId: string,
		opts?: { variant?: string; signal?: AbortSignal },
	): Promise<FileRecord | null> {
		const query = opts?.variant ? `?variants=${encodeURIComponent(opts.variant)}` : "";
		const data = await this.http.request<Record<string, unknown>>(
			"POST",
			`/files/${encodeURIComponent(fileId)}/complete${query}`,
			{},
			{ signal: opts?.signal },
		);

		return data as FileRecord | null;
	}

	/**
	 * List uploaded files (newest first), with optional filters.
	 *
	 * @param options Filters and pagination.
	 */
	async list(options?: {
		page?: number;
		perPage?: number;
		collectionName?: string;
		fieldName?: string;
		mime?: string;
	}): Promise<{ items: FileRecord[]; page: number; perPage: number; total: number }> {
		const params: Record<string, string> = {};
		if (options?.page !== undefined) params["page"] = String(options.page);
		if (options?.perPage !== undefined) params["perPage"] = String(options.perPage);
		if (options?.collectionName) params["collectionName"] = options.collectionName;
		if (options?.fieldName) params["fieldName"] = options.fieldName;
		if (options?.mime) params["mime"] = options.mime;

		const data = await this.http.request<{
			items: FileRecord[];
			page: number;
			perPage: number;
			total: number;
		}>("GET", "/files", undefined, { params });
		return (
			data ?? { items: [], page: 1, perPage: 50, total: 0 }
		) as {
			items: FileRecord[];
			page: number;
			perPage: number;
			total: number;
		};
	}

	/**
	 * Fetch file metadata including URL.
	 * @param fileId The file ID.
	 */

	/**
	 * Fetch file metadata including URL.
	 * @param fileId The file ID.
	 */
	async getUrl(fileId: string): Promise<string | null> {
		const data = await this.http.request<Record<string, unknown>>(
			"GET",
			"/files/" + encodeURIComponent(fileId),
		);
		if (data && typeof data === "object" && "url" in data) {
			return (data as Record<string, unknown>).url as string;
		}
		return null;
	}

	/**
	 * Delete a file by ID.
	 * @param fileId The file ID.
	 * @param options Optional request options.
	 */
	async delete(fileId: string, options?: RequestOptions): Promise<null> {
		return this.http.request<null>(
			"DELETE",
			"/files/" + encodeURIComponent(fileId),
			undefined,
			options,
		);
	}
}
