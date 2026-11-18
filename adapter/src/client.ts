import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
  parseRetryAfter,
} from "@chat-adapter/shared";
import type { WatiApiMessage, WatiCredential } from "./types";

const ADAPTER = "wati";
const V3 = "/api/ext/v3";

/** Resolve a string-or-function credential. Called on every request. */
export async function resolveCredential(
  value: WatiCredential | undefined,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const resolved = typeof value === "function" ? await value() : value;
  return resolved;
}

/**
 * Reduce an API endpoint to its origin. The Wati dashboard shows the endpoint
 * with the tenant ID appended (`https://live-mt-server.wati.io/123456`), but
 * V3 routes take no tenant ID, so any path is dropped.
 */
export function normalizeApiEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export interface InteractiveButtonsPayload {
  header?: {
    /** Case-sensitive: Wati rejects lowercase values with "Invalid Header Type". */
    type: "Text" | "Image" | "Video" | "Document";
    text?: string;
    media?: { url: string; file_name?: string };
  };
  body: string;
  footer?: string;
  buttons: { text: string }[];
}

export interface InteractiveListPayload {
  header?: string;
  body: string;
  footer?: string;
  button_text: string;
  sections: {
    title: string;
    rows: { title: string; description?: string }[];
  }[];
}

export interface SendMessageResponse {
  message?: WatiApiMessage;
  [key: string]: unknown;
}

export interface MessageListResponse {
  message_list?: WatiApiMessage[] | null;
  page_number?: number;
  page_size?: number;
  channel_id?: string | null;
}

export interface SendTemplateResponse {
  success?: boolean;
  broadcast_id?: string;
  error?: unknown;
  recipients?: { phone_number?: string; errors?: unknown[] }[];
  [key: string]: unknown;
}

export interface WatiClientOptions {
  apiEndpoint: string;
  accessToken: WatiCredential;
  fetch?: typeof fetch;
}

/** Thin client for the Wati V3 REST API. */
export class WatiClient {
  private readonly apiEndpoint: string;
  private readonly accessToken: WatiCredential;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WatiClientOptions) {
    this.apiEndpoint = normalizeApiEndpoint(options.apiEndpoint);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  sendText(target: string, text: string): Promise<SendMessageResponse> {
    return this.json("POST", "/conversations/messages/text", { target, text });
  }

  sendFileViaUrl(
    target: string,
    fileUrl: string,
    caption?: string,
  ): Promise<SendMessageResponse> {
    return this.json("POST", "/conversations/messages/fileViaUrl", {
      target,
      file_url: fileUrl,
      ...(caption ? { caption } : {}),
    });
  }

  async sendFile(
    target: string,
    file: { data: Buffer; filename: string; mimeType?: string },
    caption?: string,
  ): Promise<SendMessageResponse> {
    const form = new FormData();
    form.set("target", target);
    const bytes = new Uint8Array(file.data);
    form.set(
      "file",
      new Blob([bytes], { type: file.mimeType ?? "application/octet-stream" }),
      file.filename,
    );
    if (caption) form.set("caption", caption);
    const response = await this.request("POST", "/conversations/messages/file", {
      body: form,
    });
    return (await readJson(response)) as SendMessageResponse;
  }

  sendInteractiveButtons(
    target: string,
    buttonMessage: InteractiveButtonsPayload,
  ): Promise<SendMessageResponse> {
    return this.json("POST", "/conversations/messages/interactive", {
      target,
      type: "buttons",
      button_message: buttonMessage,
    });
  }

  sendInteractiveList(
    target: string,
    listMessage: InteractiveListPayload,
  ): Promise<SendMessageResponse> {
    return this.json("POST", "/conversations/messages/interactive", {
      target,
      type: "list",
      list_message: listMessage,
    });
  }

  sendTypingIndicator(target: string): Promise<{ success?: boolean }> {
    return this.json("POST", "/conversations/typingIndicator", { target });
  }

  getMessages(
    target: string,
    pageNumber: number,
    pageSize: number,
  ): Promise<MessageListResponse> {
    const query = new URLSearchParams({
      page_number: String(pageNumber),
      page_size: String(pageSize),
    });
    return this.json(
      "GET",
      `/conversations/${encodeURIComponent(target)}/messages?${query}`,
    );
  }

  async getMediaFile(messageId: string): Promise<Buffer> {
    const response = await this.request(
      "GET",
      `/conversations/messages/file/${encodeURIComponent(messageId)}`,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  getContact(target: string): Promise<Record<string, unknown>> {
    return this.json("GET", `/contacts/${encodeURIComponent(target)}`);
  }

  sendTemplate(body: {
    template_name: string;
    broadcast_name: string;
    channel?: string;
    recipients: {
      phone_number: string;
      custom_params?: { name: string; value: string }[];
    }[];
  }): Promise<SendTemplateResponse> {
    return this.json("POST", "/messageTemplates/send", body);
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request(method, path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
    });
    return (await readJson(response)) as T;
  }

  private async request(
    method: string,
    path: string,
    init: { body?: BodyInit; contentType?: string } = {},
  ): Promise<Response> {
    const token = await resolveCredential(this.accessToken);
    if (!token) {
      throw new AuthenticationError(ADAPTER, "Wati access token is empty.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}`,
      Accept: "application/json",
    };
    if (init.contentType) headers["Content-Type"] = init.contentType;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiEndpoint}${V3}${path}`, {
        method,
        headers,
        body: init.body,
      });
    } catch (error) {
      throw new NetworkError(
        ADAPTER,
        `Request to Wati failed: ${method} ${path}`,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      throw await toAdapterError(response, method, path);
    }
    return response;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function toAdapterError(
  response: Response,
  method: string,
  path: string,
): Promise<AdapterError> {
  const detail = await errorDetail(response);
  const where = `${method} ${stripQuery(path)}`;
  switch (response.status) {
    case 400:
    case 422:
      return new ValidationError(
        ADAPTER,
        `Wati rejected ${where}: ${detail ?? response.statusText}`,
      );
    case 401:
      return new AuthenticationError(
        ADAPTER,
        `Wati returned 401 for ${where}. Check the access token and API endpoint region.`,
      );
    case 403:
      return new PermissionError(ADAPTER, where, detail ?? undefined);
    case 404:
      return new ResourceNotFoundError(ADAPTER, "resource", where);
    case 429:
      return new AdapterRateLimitError(
        ADAPTER,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    default:
      return new NetworkError(
        ADAPTER,
        `Wati returned ${response.status} for ${where}${detail ? `: ${detail}` : ""}`,
      );
  }
}

async function errorDetail(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const message = parsed.message ?? parsed.error ?? parsed.title;
      return typeof message === "string" ? message : text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return null;
  }
}

function stripQuery(path: string): string {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
}
