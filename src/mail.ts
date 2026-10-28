// ── Mail Service ────────────────────────────────────────
// Send application email through the deployment's SMTP settings, and manage
// the templates it renders (`POST /api/mail`, `/api/mail/templates`).
//
// Access via {@link LazypockClient.mail}.
//
// Sending **queues** a job rather than delivering inline: an SMTP provider that
// is slow or down must not hold a request open, and the queue already retries
// with backoff. The response therefore means "queued", not "delivered" —
// delivery failures surface on the job (`GET /api/logs`).
//
// A template is rendered against the *variables* of a message, and one of the
// built-ins renders a password-reset token. That is why templates are
// superuser-only and deliberately not API-keyable: whoever can write a template
// can mail themselves somebody else's token. Sending an already-defined
// template stays API-keyable.

import type { HttpClient } from "./http";
import type { RequestOptions } from "./types";

/** The three parts a mail template is made of. */
export type MailPart = "subject" | "html" | "text";

/**
 * Which layer a template body came from, newest first.
 *
 * - `database` — saved through the API (or Studio), the one in effect
 * - `file` — a file in the deployment's template directory
 * - `builtin` — shipped with the server
 *
 * Reported because an edit that is in effect and one that is not look identical
 * otherwise.
 */
export type MailTemplateLayer = "database" | "file" | "builtin";

/** The template context handed to a send or a preview. */
export type MailAssigns = Record<string, unknown>;

/** A template as the server resolves it. */
export interface MailTemplate {
	/** The template name, e.g. `verification` or `receipt`. */
	name: string;
	/** The strongest layer across the three parts (`database` wins over `file`). */
	source: MailTemplateLayer;
	/** The layer each part resolved from. */
	parts: Record<MailPart, MailTemplateLayer>;
	/** The subject, as a template. */
	subject: string;
	/** The HTML body. */
	html: string;
	/** The plain-text alternative. */
	text: string;
}

/** The bodies of one template. All three parts are required. */
export interface MailTemplateParts {
	subject: string;
	html: string;
	text: string;
}

/** One message to queue. */
export type MailMessage =
	| {
			/** The recipient's address. */
			to: string;
			/** The recipient's display name, rendered as `name`. */
			toName?: string;
			/** A built-in or deployment-saved template name. */
			template: string;
			/** The template context. */
			assigns?: MailAssigns;
	  }
	| {
			/** The recipient's address. */
			to: string;
			/** The recipient's display name. */
			toName?: string;
			/** A raw subject, instead of a template. */
			subject: string;
			/** The HTML body (required when `text` is omitted). */
			html?: string;
			/** The plain-text body (required when `html` is omitted). Derived from the HTML when omitted. */
			text?: string;
	  };

/** What `send()` answers: the queued job, not a delivery. */
export interface MailSendResult {
	queued: boolean;
	/** The job id — follow it in `GET /api/logs` for delivery failures. */
	id: string;
}

/** A draft to render in place of the stored parts. Nothing is saved or sent. */
export interface MailPreviewDraft {
	/** The template context. `name` and `app_name` are filled in when absent. */
	assigns?: MailAssigns;
	/** The recipient display name that `name` renders as. */
	toName?: string;
	/** A draft subject to render instead of the stored one. */
	subject?: string;
	/** A draft HTML body to render instead of the stored one. */
	html?: string;
	/** A draft text body to render instead of the stored one. */
	text?: string;
}

/** The rendered result of a preview. */
export interface MailPreviewResult {
	name: string;
	subject: string;
	html: string;
	text: string;
}

/** What `deleteTemplate()` answers: how many stored parts went away. */
export interface MailTemplateDeleteResult {
	name: string;
	/** `0` when the template had never been saved (it was already at its default). */
	deleted: number;
}

/** Path for one template, encoding a name so it survives the URL path. */
function templatePath(name: string): string {
	return "/mail/templates/" + encodeURIComponent(name.trim());
}

/**
 * Service for application email.
 * Access via {@link LazypockClient.mail}.
 *
 * @example
 * ```ts
 * await client.mail.send({ to: 'ada@example.com', template: 'verification', assigns: { token: '…' } });
 * ```
 */
export class MailService {
	constructor(private http: HttpClient) {}

	/**
	 * Queue one message for delivery.
	 *
	 * Either a `template` or a `subject` with a body. The type requires one of
	 * them — a message with neither does not compile — while the server refuses a
	 * message that carries both, and a template with a raw body.
	 *
	 * The address is shape-checked server-side; the SMTP server remains the
	 * authority on whether it exists.
	 *
	 * @param message The template or raw message to send.
	 * @param options Optional request options (signal, custom fetch).
	 * @returns The queued job (`{ queued: true, id }`).
	 *
	 * @example
	 * ```ts
	 * // A template
	 * await client.mail.send({ to: 'ada@example.com', template: 'receipt', assigns: { total: 42 } });
	 *
	 * // A raw message
	 * await client.mail.send({ to: 'ada@example.com', subject: 'Hello', text: 'Hi there' });
	 * ```
	 */
	async send(message: MailMessage, options?: RequestOptions): Promise<MailSendResult> {
		const body =
			"template" in message
				? {
						to: message.to,
						toName: message.toName,
						template: message.template,
						assigns: message.assigns,
					}
				: {
						to: message.to,
						toName: message.toName,
						subject: message.subject,
						html: message.html,
						text: message.text,
					};
		const data = await this.http.request<MailSendResult>("POST", "/mail", body, options);
		return (data ?? { queued: false, id: "" }) as MailSendResult;
	}

	/**
	 * List every template the server can send, with the body each part
	 * currently resolves to and the layer it came from (superuser).
	 *
	 * Unpaginated: there are as many templates as the deployment defined, not
	 * as many as it has sent.
	 */
	async listTemplates(options?: RequestOptions): Promise<MailTemplate[]> {
		const data = await this.http.request<{ items: MailTemplate[] }>(
			"GET",
			"/mail/templates",
			undefined,
			options,
		);
		return data?.items ?? [];
	}

	/** Fetch one template by name (superuser). */
	async getTemplate(name: string, options?: RequestOptions): Promise<MailTemplate> {
		const data = await this.http.request<MailTemplate>(
			"GET",
			templatePath(name),
			undefined,
			options,
		);
		return data as MailTemplate;
	}

	/**
	 * Save all three parts of a template, replacing whatever was stored for them.
	 *
	 * All three at once rather than one at a time: a template is only allowed to
	 * exist once it is complete, so a part-at-a-time write could leave a subject
	 * saved against a body that does not parse. The server parses the bodies
	 * before storing them, so a syntax error is a rejected save rather than a
	 * queued email that fails where nobody is watching (superuser).
	 */
	async saveTemplate(
		name: string,
		parts: MailTemplateParts,
		options?: RequestOptions,
	): Promise<MailTemplate> {
		const data = await this.http.put<MailTemplate>(
			templatePath(name),
			{ subject: parts.subject, html: parts.html, text: parts.text },
			options,
		);
		return data as MailTemplate;
	}

	/**
	 * Remove the stored bodies, so the template falls back to its file or its
	 * built-in (superuser).
	 *
	 * Deleting one that was never saved succeeds with `deleted: 0` — it is
	 * already at its default — but an unknown *name* is a 404, so a typo cannot
	 * look like a reset that worked.
	 */
	async deleteTemplate(
		name: string,
		options?: RequestOptions,
	): Promise<MailTemplateDeleteResult> {
		const data = await this.http.request<MailTemplateDeleteResult>(
			"DELETE",
			templatePath(name),
			undefined,
			options,
		);
		return (data ?? { name: name.trim(), deleted: 0 }) as MailTemplateDeleteResult;
	}

	/**
	 * Render a template the way a send would, without storing or sending
	 * anything (superuser).
	 *
	 * Any of `subject`/`html`/`text` given in `draft` is rendered in place of the
	 * stored part, which is what makes this useful while a body is still being
	 * written. A draft over a name the server does not know is previewed as the
	 * new template it is being written as, so such a draft has to arrive
	 * complete (all three parts).
	 *
	 * Previews share one auto-cancellation key (`POST /mail/templates/<name>/preview`),
	 * so a newer preview aborts an older one: the older promise rejects with an
	 * `ApiError` whose `isAbort` is `true`. That is what an editor wants when a
	 * keystroke supersedes the last render, but pass `{ requestKey: null }` to
	 * keep every preview if you would rather have them all.
	 */
	async preview(
		name: string,
		draft?: MailPreviewDraft,
		options?: RequestOptions,
	): Promise<MailPreviewResult> {
		const body = {
			assigns: draft?.assigns,
			toName: draft?.toName,
			subject: draft?.subject,
			html: draft?.html,
			text: draft?.text,
		};
		const data = await this.http.request<MailPreviewResult>(
			"POST",
			templatePath(name) + "/preview",
			body,
			options,
		);
		return data as MailPreviewResult;
	}
}
