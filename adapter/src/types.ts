import type { LogLevel, Logger, RawMessage } from "chat";

/**
 * A credential value. Pass a plain string, or a function that returns the
 * current value. Functions are resolved on every outbound API call, so
 * rotating or short-lived tokens work without recreating the adapter.
 */
export type WatiCredential = string | (() => string | Promise<string>);

/** Decoded components of a Wati thread ID (`wati:{channel}:{waId}`). */
export interface WatiThreadId {
  /**
   * The WhatsApp Business number (channel) the conversation runs on, digits
   * only, for example `"14155550100"`. Empty when the workspace has a single
   * channel and none was given; Wati then sends from the default channel.
   */
  channelPhoneNumber: string;
  /** The customer's WhatsApp ID: their phone number with country code, or a BSUID. */
  waId: string;
}

/** Configuration for {@link WatiAdapter}. */
export interface WatiAdapterConfig {
  /**
   * Wati REST API host for your workspace, for example
   * `https://live-mt-server.wati.io`. Use the host shown under API Docs in
   * your Wati dashboard. Do not include the tenant ID or `/api`.
   * Defaults to the `WATI_API_ENDPOINT` env var.
   */
  apiEndpoint?: string;
  /**
   * Wati API access token, without the `Bearer ` prefix (a prefix is
   * stripped if present). Defaults to the `WATI_ACCESS_TOKEN` env var.
   */
  accessToken?: WatiCredential;
  /**
   * Shared secret that every webhook delivery must carry, either as the
   * `token` query parameter of the webhook URL you register in Wati, or in an
   * `x-wati-webhook-secret` header. Defaults to the `WATI_WEBHOOK_SECRET`
   * env var. Required unless `verifyWebhooks` is `false`.
   */
  webhookSecret?: WatiCredential;
  /**
   * Reject webhook deliveries that do not carry `webhookSecret`.
   * Defaults to `true`. Only turn this off for local development.
   */
  verifyWebhooks?: boolean;
  /**
   * Default WhatsApp Business number to send from in {@link WatiAdapter.openDM}.
   * Defaults to the `WATI_CHANNEL_PHONE_NUMBER` env var.
   */
  channelPhoneNumber?: string;
  /** Bot display name. Defaults to `WATI_BOT_USERNAME`, then the Chat instance's userName. */
  userName?: string;
  /** Logger. Defaults to the Chat instance's logger once initialized. */
  logger?: Logger;
  /** Console log level used before a logger is available. Defaults to `"info"`. */
  logLevel?: LogLevel;
  /**
   * How long to remember which action a reply button or list row maps to,
   * in milliseconds. WhatsApp replies from Wati carry only the button's
   * label, so the adapter stores label → action in the Chat state adapter.
   * Defaults to 30 days.
   */
  actionMappingTtlMs?: number;
  /** Custom `fetch`, for tests or proxies. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Incoming Wati webhook payload (`message` event, also used for other
 * message-family events). Field names follow the Wati webhook reference:
 * https://docs.wati.io/reference/message-received
 */
export interface WatiWebhookMessage {
  /** Wati message record ID. */
  id: string;
  /** ISO 8601 creation time in Wati. */
  created?: string;
  /** WhatsApp message ID (wamid). */
  whatsappMessageId?: string | null;
  conversationId?: string | null;
  ticketId?: string | null;
  text?: string | null;
  /** text, image, document, location, voice, audio, button, interactive, reaction, video, sticker, contacts, order, catalog, media_placeholder, template */
  type?: string | null;
  /** Extra payload for non-text messages. For media this is usually a file URL or path. */
  data?: unknown;
  sourceId?: string | null;
  sourceUrl?: string | null;
  /** Unix seconds, as a string. */
  timestamp?: string | null;
  /** `true` when the business (an operator, a chatbot or this bot) sent the message. */
  owner?: boolean | null;
  eventType?: string | null;
  statusString?: string | null;
  avatarUrl?: string | null;
  assignedId?: string | null;
  operatorName?: string | null;
  operatorEmail?: string | null;
  /** Customer WhatsApp ID (phone number with country code). */
  waId?: string | null;
  messageContact?: unknown;
  senderName?: string | null;
  listReply?: WatiInteractiveReply | null;
  interactiveButtonReply?: WatiInteractiveReply | null;
  buttonReply?: WatiInteractiveReply | null;
  /** WhatsApp ID of the message this one quotes or reacts to. Empty when none. */
  replyContextId?: string | null;
  sourceType?: number | null;
  frequentlyForwarded?: boolean | null;
  forwarded?: boolean | null;
  channelId?: string | null;
  /** The business WhatsApp number that received the message. */
  channelPhoneNumber?: string | null;
  bsuid?: string | null;
  parentBsuid?: string | null;
  username?: string | null;
  localMessageId?: string | null;
  [key: string]: unknown;
}

/** Interactive reply data. Wati does not document the inner shape, so all fields are optional. */
export interface WatiInteractiveReply {
  id?: string | null;
  title?: string | null;
  text?: string | null;
  payload?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

/** A message as returned by Wati V3 REST endpoints (send responses and history). */
export interface WatiApiMessage {
  id?: string | null;
  text?: string | null;
  type?: string | null;
  /** Unix seconds or ISO 8601, depending on the endpoint. */
  timestamp?: string | null;
  owner?: boolean | null;
  status?: string | null;
  avatar_url?: string | null;
  assigned_id?: string | null;
  operator_name?: string | null;
  failed_detail?: string | null;
  bot_type?: string | null;
  created?: string | null;
  conversation_id?: string | null;
  ticket_id?: string | null;
  event_type?: string | null;
  local_message_id?: string | null;
  data?: unknown;
  [key: string]: unknown;
}

/** Raw message payloads the adapter hands to Chat SDK. */
export type WatiRawMessage = WatiWebhookMessage | WatiApiMessage;

/** Raw message envelope returned by adapter send methods. */
export type WatiRawMessageResult = RawMessage<WatiRawMessage>;

/** One template parameter. */
export interface WatiTemplateParameter {
  name: string;
  value: string;
}

/** Options for {@link WatiAdapter.sendTemplate}. */
export interface WatiSendTemplateOptions {
  /** Approved WhatsApp template name. */
  templateName: string;
  /** Wati broadcast name this send is grouped under. Defaults to `chat-sdk`. */
  broadcastName?: string;
  /** Template variables, for example `[{ name: "name", value: "Ana" }]`. */
  parameters?: WatiTemplateParameter[];
  /** Sending WhatsApp number. Defaults to the thread's channel. */
  channelPhoneNumber?: string;
}

/** Result of {@link WatiAdapter.sendTemplate}. */
export interface WatiSendTemplateResult {
  /** Wati broadcast ID. */
  broadcastId?: string;
  /** The Chat SDK thread ID for the recipient, so you can subscribe to replies. */
  threadId: string;
  raw: unknown;
}
