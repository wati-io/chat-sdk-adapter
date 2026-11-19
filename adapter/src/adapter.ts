import {
  ValidationError,
  extractCard,
  extractFiles,
  extractPostableAttachments,
  toBuffer,
} from "@chat-adapter/shared";
import {
  ConsoleLogger,
  Message,
  NotImplementedError,
  defaultEmojiResolver,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type Logger,
  type RawMessage,
  type StreamChunk,
  type StreamOptions,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { timingSafeEqual } from "node:crypto";
import {
  type WatiActionMapping,
  normalizeLabel,
  planCard,
} from "./cards";
import {
  WatiClient,
  resolveCredential,
  type SendMessageResponse,
} from "./client";
import { WatiFormatConverter } from "./format-converter";
import type {
  WatiAdapterConfig,
  WatiApiMessage,
  WatiCredential,
  WatiRawMessage,
  WatiSendTemplateOptions,
  WatiSendTemplateResult,
  WatiThreadId,
  WatiWebhookMessage,
} from "./types";
import {
  MEDIA_TYPES,
  asRecord,
  firstString,
  interactiveReply,
  isIncomingMessage,
  normalizePhone,
  parseTimestamp,
  reactionDetails,
  webhookEvents,
} from "./webhook";

const NAME = "wati";
const DEFAULT_ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const TEXT_MAX_LENGTH = 4096;
const WEBHOOK_SECRET_HEADER = "x-wati-webhook-secret";

/** Chat SDK adapter for WhatsApp through the Wati API. */
export class WatiAdapter implements Adapter<WatiThreadId, WatiRawMessage> {
  readonly name = NAME;

  private readonly client: WatiClient;
  private readonly webhookSecret?: WatiCredential;
  private readonly verifyWebhooks: boolean;
  private readonly defaultChannel: string;
  private readonly actionTtlMs: number;
  private readonly converter = new WatiFormatConverter();
  private chat: ChatInstance | null = null;
  private logger: Logger;
  private _userName: string;
  private readonly userNameFromConfig: boolean;
  private warnedUnverified = false;
  /** Set once Wati reports typing indicators are off for this account. */
  private typingDisabled = false;

  constructor(config: WatiAdapterConfig = {}) {
    const apiEndpoint = config.apiEndpoint ?? env("WATI_API_ENDPOINT");
    const accessToken = config.accessToken ?? env("WATI_ACCESS_TOKEN");
    if (!apiEndpoint) {
      throw new ValidationError(
        NAME,
        "Wati API endpoint is required. Pass apiEndpoint or set WATI_API_ENDPOINT (for example https://live-mt-server.wati.io).",
      );
    }
    if (!accessToken) {
      throw new ValidationError(
        NAME,
        "Wati access token is required. Pass accessToken or set WATI_ACCESS_TOKEN.",
      );
    }

    this.client = new WatiClient({
      apiEndpoint,
      accessToken,
      fetch: config.fetch,
    });
    this.webhookSecret = config.webhookSecret ?? env("WATI_WEBHOOK_SECRET");
    this.verifyWebhooks = config.verifyWebhooks ?? true;
    this.defaultChannel = normalizePhone(
      config.channelPhoneNumber ?? env("WATI_CHANNEL_PHONE_NUMBER") ?? "",
    );
    this.actionTtlMs = config.actionMappingTtlMs ?? DEFAULT_ACTION_TTL_MS;
    this.logger =
      config.logger ?? new ConsoleLogger(config.logLevel ?? "info", NAME);
    const configuredName = config.userName ?? env("WATI_BOT_USERNAME");
    this.userNameFromConfig = Boolean(configuredName);
    this._userName = configuredName ?? NAME;
  }

  get userName(): string {
    return this._userName;
  }

  /** The default WhatsApp Business number, when configured. */
  get botUserId(): string | undefined {
    return this.defaultChannel || undefined;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger(NAME);
    if (!this.userNameFromConfig) this._userName = chat.getUserName();
    if (this.verifyWebhooks && !this.webhookSecret) {
      this.logger.warn(
        "No Wati webhook secret is configured, so every webhook will be rejected. Set WATI_WEBHOOK_SECRET and add ?token=<secret> to the webhook URL in Wati, or pass verifyWebhooks: false for local development.",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  async handleWebhook(
    request: Request,
    options?: WebhookOptions,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rejection = await this.verifyWebhook(request);
    if (rejection) return rejection;

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!this.chat) {
      this.logger.warn("Chat instance is not initialized; ignoring Wati webhook");
      return new Response("OK", { status: 200 });
    }

    const events = webhookEvents(body);
    if (events.length === 0) {
      this.logger.debug("Wati webhook had no recognizable events", {
        bodyType: Array.isArray(body) ? "array" : typeof body,
      });
    }
    for (const event of events) {
      const summary = {
        id: event.id,
        eventType: event.eventType,
        type: event.type,
        owner: event.owner,
      };
      if (!isIncomingMessage(event)) {
        this.logger.debug("Ignoring Wati event (not an incoming customer message)", summary);
        continue;
      }
      this.logger.debug("Handling Wati message", summary);
      this.dispatch(event, options);
    }
    return new Response("OK", { status: 200 });
  }

  private async verifyWebhook(request: Request): Promise<Response | null> {
    if (!this.verifyWebhooks) {
      if (!this.warnedUnverified) {
        this.warnedUnverified = true;
        this.logger.warn(
          "Wati webhook verification is disabled. Only do this in local development.",
        );
      }
      return null;
    }
    const expected = await resolveCredential(this.webhookSecret);
    if (!expected) {
      return new Response("Webhook secret is not configured", { status: 401 });
    }
    const provided =
      request.headers.get(WEBHOOK_SECRET_HEADER) ??
      new URL(request.url).searchParams.get("token");
    if (!provided || !safeEqual(provided, expected)) {
      return new Response("Invalid webhook secret", { status: 401 });
    }
    return null;
  }

  private dispatch(event: WatiWebhookMessage, options?: WebhookOptions): void {
    const chat = this.chat;
    if (!chat) return;
    const thread = this.threadFromEvent(event);
    if (!thread) {
      this.logger.warn("Skipping Wati webhook without a customer waId", {
        id: event.id,
      });
      return;
    }
    const threadId = this.encodeThreadId(thread);

    const reaction = reactionDetails(event);
    if (reaction) {
      void chat.processReaction(
        {
          adapter: this,
          added: reaction.emoji.length > 0,
          emoji: defaultEmojiResolver.fromGChat(reaction.emoji || "removed"),
          rawEmoji: reaction.emoji,
          messageId: reaction.targetMessageId,
          threadId,
          user: this.authorFor(event),
          raw: event,
        },
        options,
      );
      return;
    }

    const reply = interactiveReply(event);
    if (reply) {
      const task = this.dispatchAction(event, threadId, reply.label, options).catch(
        (error: unknown) =>
          this.logger.error("Failed to handle Wati button reply", {
            error: String(error),
            id: event.id,
          }),
      );
      options?.waitUntil?.(task);
      return;
    }

    void chat.processMessage(this, threadId, this.parseMessage(event), options);
  }

  private async dispatchAction(
    event: WatiWebhookMessage,
    threadId: string,
    label: string,
    options?: WebhookOptions,
  ): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const mapping = await this.lookupAction(threadId, label);
    if (!mapping) {
      // A reply to a button this adapter did not send (for example a template
      // quick reply). Deliver it as a normal message so handlers still see it.
      void chat.processMessage(this, threadId, this.parseMessage(event), options);
      return;
    }
    await chat.processAction(
      {
        adapter: this,
        actionId: mapping.actionId,
        value: mapping.value,
        messageId: firstString(event.replyContextId) ?? event.id,
        threadId,
        user: this.authorFor(event),
        raw: event,
      },
      options,
    );
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WatiRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    const target = targetFor(thread);
    const card = extractCard(message);
    const files = extractFiles(message);
    const attachments = extractPostableAttachments(message);

    if (card) {
      if (files.length > 0 || attachments.length > 0) {
        throw new ValidationError(
          NAME,
          "A WhatsApp message cannot combine a card with file uploads. Send them as separate messages.",
        );
      }
      return this.postCard(threadId, target, card);
    }

    const text = this.converter.renderPostable(message).trim();
    if (files.length > 0 || attachments.length > 0) {
      return this.postMedia(threadId, target, text, files, attachments);
    }
    if (!text) {
      throw new ValidationError(NAME, "Message text cannot be empty.");
    }
    return this.postText(threadId, target, text);
  }

  /** WhatsApp messages sent through Wati are immutable. */
  async editMessage(): Promise<RawMessage<WatiRawMessage>> {
    throw new NotImplementedError(
      "WhatsApp does not support editing sent messages.",
      "editMessage",
    );
  }

  /** WhatsApp messages sent through Wati cannot be deleted for the recipient. */
  async deleteMessage(): Promise<void> {
    throw new NotImplementedError(
      "Wati does not support deleting sent messages.",
      "deleteMessage",
    );
  }

  /** Not available: the Wati API has no endpoint for sending reactions. */
  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "The Wati API does not support sending reactions.",
      "addReaction",
    );
  }

  /** Not available: the Wati API has no endpoint for sending reactions. */
  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError(
      "The Wati API does not support removing reactions.",
      "removeReaction",
    );
  }

  /**
   * Show "typing…" to the customer. WhatsApp clears it after 25 seconds or
   * when the reply arrives. This also marks their last message as read.
   *
   * Typing is cosmetic, so failures are logged rather than thrown: a handler
   * that calls `startTyping()` still gets to send its reply. Some Wati
   * accounts have the feature switched off; after Wati says so, further
   * calls are skipped.
   */
  async startTyping(threadId: string): Promise<void> {
    if (this.typingDisabled) return;
    const thread = this.decodeThreadId(threadId);
    try {
      await this.client.sendTypingIndicator(targetFor(thread));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/typing indicator is disabled/i.test(message)) {
        this.typingDisabled = true;
        this.logger.warn(
          "Typing indicators are off for this Wati account; skipping them from now on. Turn them on in Wati: Settings → Team Inbox → General Settings → Show typing indicator to customers.",
        );
        return;
      }
      this.logger.warn("Wati typing indicator failed", { threadId, error: message });
    }
  }

  /**
   * WhatsApp has no message editing, so streamed responses are collected and
   * sent as one message when the stream ends.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions,
  ): Promise<RawMessage<WatiRawMessage>> {
    let text = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") text += chunk;
      else if (chunk.type === "markdown_text") text += chunk.text;
    }
    return this.postMessage(threadId, { markdown: text });
  }

  /**
   * Send an approved WhatsApp template. Use this to start a conversation, or
   * to message a customer after WhatsApp's 24-hour customer-service window
   * has closed, when free-form messages are not allowed.
   *
   * @param threadIdOrPhone A Wati thread ID, or the customer's phone number.
   */
  async sendTemplate(
    threadIdOrPhone: string,
    options: WatiSendTemplateOptions,
  ): Promise<WatiSendTemplateResult> {
    const thread = threadIdOrPhone.startsWith(`${NAME}:`)
      ? this.decodeThreadId(threadIdOrPhone)
      : { channelPhoneNumber: this.defaultChannel, waId: normalizePhone(threadIdOrPhone) };
    const channel = normalizePhone(
      options.channelPhoneNumber ?? thread.channelPhoneNumber,
    );
    const response = await this.client.sendTemplate({
      template_name: options.templateName,
      broadcast_name: options.broadcastName ?? "chat-sdk",
      ...(channel ? { channel } : {}),
      recipients: [
        {
          phone_number: thread.waId,
          ...(options.parameters?.length
            ? { custom_params: options.parameters }
            : {}),
        },
      ],
    });
    const recipientErrors = response.recipients?.flatMap((r) => r.errors ?? []) ?? [];
    if (response.success === false || recipientErrors.length > 0) {
      const detail = JSON.stringify(response.error ?? recipientErrors);
      // Wati reports a missing or misnamed template parameter as "no valid
      // Receivers", which points at the wrong thing.
      const hint = /no valid receivers/i.test(detail)
        ? ` Check that the parameter names match the template's Wati names (custom_params / body_original in GET /api/ext/v3/messageTemplates, e.g. "name" rather than Meta's "1"), and that ${thread.waId} is a valid WhatsApp number.`
        : "";
      throw new ValidationError(
        NAME,
        `Wati did not accept template "${options.templateName}": ${detail}.${hint}`,
      );
    }
    return {
      broadcastId: response.broadcast_id,
      threadId: this.encodeThreadId({ channelPhoneNumber: channel, waId: thread.waId }),
      raw: response,
    };
  }

  private async postText(
    threadId: string,
    target: string,
    text: string,
  ): Promise<RawMessage<WatiRawMessage>> {
    let last: SendMessageResponse | undefined;
    for (const part of splitText(text, TEXT_MAX_LENGTH)) {
      last = await this.client.sendText(target, part);
    }
    return this.result(threadId, last);
  }

  private async postCard(
    threadId: string,
    target: string,
    card: Parameters<typeof planCard>[0],
  ): Promise<RawMessage<WatiRawMessage>> {
    const plan = planCard(card, (markdown) => this.converter.fromMarkdown(markdown));
    if (plan.kind === "text") {
      return this.postText(threadId, target, plan.text || card.title || " ");
    }
    await this.storeActions(threadId, plan.actions);
    const response =
      plan.kind === "buttons"
        ? await this.client.sendInteractiveButtons(target, plan.payload)
        : await this.client.sendInteractiveList(target, plan.payload);
    return this.result(threadId, response);
  }

  private async postMedia(
    threadId: string,
    target: string,
    text: string,
    files: ReturnType<typeof extractFiles>,
    attachments: Attachment[],
  ): Promise<RawMessage<WatiRawMessage>> {
    let caption: string | undefined = text || undefined;
    let first: SendMessageResponse | undefined;
    const send = async (response: Promise<SendMessageResponse>) => {
      const value = await response;
      first ??= value;
    };

    for (const file of files) {
      const data = await toBuffer(file.data, {
        platform: NAME,
        throwOnUnsupported: true,
      });
      if (!data) throw new ValidationError(NAME, "Unsupported file upload payload.");
      await send(
        this.client.sendFile(
          target,
          { data, filename: file.filename, mimeType: file.mimeType },
          caption,
        ),
      );
      caption = undefined;
    }

    for (const attachment of attachments) {
      if (attachment.url && !attachment.data && !attachment.fetchData) {
        await send(this.client.sendFileViaUrl(target, attachment.url, caption));
      } else {
        const raw = attachment.data ?? (await attachment.fetchData?.());
        const data = await toBuffer(raw, {
          platform: NAME,
          throwOnUnsupported: true,
        });
        if (!data) throw new ValidationError(NAME, "Unsupported attachment payload.");
        await send(
          this.client.sendFile(
            target,
            {
              data,
              filename: attachment.name ?? defaultFileName(attachment),
              mimeType: attachment.mimeType,
            },
            caption,
          ),
        );
      }
      caption = undefined;
    }

    return this.result(threadId, first);
  }

  private result(
    threadId: string,
    response: SendMessageResponse | undefined,
  ): RawMessage<WatiRawMessage> {
    const message: WatiApiMessage = response?.message ?? {};
    return {
      id: message.id ?? message.local_message_id ?? `wati-${Date.now()}`,
      threadId,
      raw: message,
    };
  }

  // ---------------------------------------------------------------------------
  // Button / list reply mapping
  // ---------------------------------------------------------------------------

  private actionKey(threadId: string, label: string): string {
    return `${NAME}:action:${threadId}:${normalizeLabel(label)}`;
  }

  private async storeActions(
    threadId: string,
    actions: Map<string, WatiActionMapping>,
  ): Promise<void> {
    if (actions.size === 0) return;
    const state = this.chat?.getState();
    if (!state) {
      this.logger.warn(
        "Chat is not initialized, so button replies cannot be mapped back to actions.",
      );
      return;
    }
    await Promise.all(
      [...actions].map(([label, mapping]) =>
        state.set(this.actionKey(threadId, label), mapping, this.actionTtlMs),
      ),
    );
  }

  private async lookupAction(
    threadId: string,
    label: string,
  ): Promise<WatiActionMapping | null> {
    const state = this.chat?.getState();
    if (!state) return null;
    return state.get<WatiActionMapping>(this.actionKey(threadId, label));
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Fetch conversation history from Wati. Pages are numbered from the most
   * recent messages backwards; `nextCursor` is the next page number.
   */
  async fetchMessages(
    threadId: string,
    options: FetchOptions = {},
  ): Promise<FetchResult<WatiRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    const pageSize = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const pageNumber = options.cursor ? Number.parseInt(options.cursor, 10) || 1 : 1;
    const response = await this.client.getMessages(
      targetFor(thread),
      pageNumber,
      pageSize,
    );
    const list = (response.message_list ?? []).filter(
      (item) => !item.event_type || item.event_type === "message",
    );
    const messages = list
      .map((item) => this.parseApiMessage(item, thread))
      .sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
    const fullPage = (response.message_list?.length ?? 0) >= pageSize;
    return {
      messages,
      nextCursor: fullPage ? String(pageNumber + 1) : undefined,
    };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const thread = this.decodeThreadId(threadId);
    let contact: Record<string, unknown> | undefined;
    try {
      contact = await this.client.getContact(targetFor(thread));
    } catch (error) {
      this.logger.debug("Wati contact lookup failed", { error: String(error) });
    }
    const contactRecord = asRecord(contact?.contact) ?? contact;
    const name = firstString(contactRecord?.name, contactRecord?.full_name, contactRecord?.fullName);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: name ? `WhatsApp: ${name}` : `WhatsApp ${thread.waId}`,
      isDM: true,
      metadata: { ...thread, contact },
    };
  }

  // ---------------------------------------------------------------------------
  // Thread IDs
  // ---------------------------------------------------------------------------

  encodeThreadId(data: WatiThreadId): string {
    return `${NAME}:${encodePart(data.channelPhoneNumber)}:${encodePart(data.waId)}`;
  }

  decodeThreadId(threadId: string): WatiThreadId {
    const parts = threadId.split(":");
    if (parts.length !== 3 || parts[0] !== NAME || !parts[2]) {
      throw new ValidationError(NAME, `Invalid Wati thread ID: ${threadId}`);
    }
    return {
      channelPhoneNumber: decodeURIComponent(parts[1] ?? ""),
      waId: decodeURIComponent(parts[2]),
    };
  }

  channelIdFromThreadId(threadId: string): string {
    const { channelPhoneNumber } = this.decodeThreadId(threadId);
    return `${NAME}:${encodePart(channelPhoneNumber)}`;
  }

  /** Every WhatsApp conversation is one-to-one. */
  isDM(_threadId?: string): boolean {
    return true;
  }

  /** Thread ID for a customer's phone number (with country code). */
  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({
      channelPhoneNumber: this.defaultChannel,
      waId: normalizePhone(userId),
    });
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  parseMessage(raw: WatiRawMessage): Message<WatiRawMessage> {
    if ("waId" in raw || "whatsappMessageId" in raw || "eventType" in raw) {
      return this.parseWebhookMessage(raw as WatiWebhookMessage);
    }
    throw new ValidationError(
      NAME,
      "parseMessage expects a Wati webhook payload. History messages are parsed by fetchMessages.",
    );
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  private parseWebhookMessage(event: WatiWebhookMessage): Message<WatiRawMessage> {
    const thread = this.threadFromEvent(event);
    if (!thread) {
      throw new ValidationError(NAME, `Wati message ${event.id} has no waId.`);
    }
    const text = messageText(event);
    return new Message<WatiRawMessage>({
      id: event.id,
      threadId: this.encodeThreadId(thread),
      ...this.converter.parseIncoming(text),
      raw: event,
      author: this.authorFor(event),
      metadata: {
        dateSent: parseTimestamp(event.timestamp, event.created),
        edited: false,
      },
      attachments: this.attachmentsFor(event.id, event.type, event.data, event.text),
      links: [],
    });
  }

  private parseApiMessage(
    item: WatiApiMessage,
    thread: WatiThreadId,
  ): Message<WatiRawMessage> {
    const text = firstString(item.text) ?? "";
    const id = item.id ?? item.local_message_id ?? "";
    const fromBusiness = item.owner === true;
    const name = fromBusiness
      ? firstString(item.operator_name) ?? this._userName
      : thread.waId;
    return new Message<WatiRawMessage>({
      id,
      threadId: this.encodeThreadId(thread),
      ...this.converter.parseIncoming(text),
      raw: item,
      author: {
        userId: fromBusiness ? thread.channelPhoneNumber || NAME : thread.waId,
        userName: name,
        fullName: name,
        // Business-side messages (this bot, Wati chatbots or human operators)
        // are reported as "me" so history reads as the business's side of
        // the conversation. History is never dispatched to handlers.
        isBot: fromBusiness ? "unknown" : false,
        isMe: fromBusiness,
      },
      metadata: {
        dateSent: parseTimestamp(item.timestamp, item.created),
        edited: false,
      },
      attachments: id ? this.attachmentsFor(id, item.type, item.data, item.text) : [],
      links: [],
    });
  }

  private threadFromEvent(event: WatiWebhookMessage): WatiThreadId | null {
    const waId = firstString(event.waId, event.bsuid);
    if (!waId) return null;
    return {
      channelPhoneNumber: normalizePhone(
        firstString(event.channelPhoneNumber) ?? this.defaultChannel,
      ),
      waId,
    };
  }

  private authorFor(event: WatiWebhookMessage): Author {
    const waId = firstString(event.waId, event.bsuid) ?? "unknown";
    const name = firstString(event.senderName, event.username) ?? waId;
    return {
      userId: waId,
      userName: name,
      fullName: name,
      isBot: false,
      isMe: false,
    };
  }

  private attachmentsFor(
    messageId: string,
    type: string | null | undefined,
    data: unknown,
    text: string | null | undefined,
  ): Attachment[] {
    if (!type || !MEDIA_TYPES.has(type)) return [];
    const url = mediaUrl(data);
    const name =
      mediaFileName(url) ??
      firstString(asRecord(data)?.fileName, asRecord(data)?.filename) ??
      (type === "document" ? firstString(text) : undefined);
    return [
      {
        type: attachmentType(type),
        name,
        url,
        fetchMetadata: { platform: NAME, messageId },
        fetchData: () => this.client.getMediaFile(messageId),
      },
    ];
  }

  /** Restore `fetchData` on attachments loaded from persisted history. */
  rehydrateAttachment(attachment: Attachment): Attachment {
    const messageId = attachment.fetchMetadata?.messageId;
    if (!messageId || attachment.fetchData) return attachment;
    return {
      ...attachment,
      fetchData: () => this.client.getMediaFile(String(messageId)),
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function env(name: string): string | undefined {
  const value = typeof process === "undefined" ? undefined : process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

/** Wati `target` for a thread: `{channel}:{waId}`, or just `{waId}` for the default channel. */
export function targetFor(thread: WatiThreadId): string {
  return thread.channelPhoneNumber
    ? `${thread.channelPhoneNumber}:${thread.waId}`
    : thread.waId;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function messageText(event: WatiWebhookMessage): string {
  const text = firstString(event.text);
  if (text) return text;
  if (event.type === "location") {
    const data = asRecord(event.data);
    const lat = data?.latitude ?? data?.lat;
    const lng = data?.longitude ?? data?.lng ?? data?.long;
    if (lat !== undefined && lng !== undefined) {
      return `https://maps.google.com/?q=${lat},${lng}`;
    }
  }
  return "";
}

function mediaUrl(data: unknown): string | undefined {
  if (typeof data === "string" && /^https?:\/\//i.test(data)) return data;
  const record = asRecord(data);
  return firstString(record?.url, record?.link, record?.mediaUrl);
}

function mediaFileName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const fromQuery = parsed.searchParams.get("fileName");
    const raw = fromQuery ?? parsed.pathname;
    return raw.split("/").pop() || undefined;
  } catch {
    return undefined;
  }
}

function attachmentType(type: string): Attachment["type"] {
  switch (type) {
    case "image":
    case "sticker":
      return "image";
    case "video":
      return "video";
    case "audio":
    case "voice":
      return "audio";
    default:
      return "file";
  }
}

function defaultFileName(attachment: Attachment): string {
  const ext = attachment.mimeType?.split("/")[1]?.split(";")[0];
  return ext ? `${attachment.type}.${ext}` : attachment.type;
}

/** Split text into chunks of at most `max` characters, preferring paragraph and line breaks. */
export function splitText(text: string, max: number): string[] {
  const chars = [...text];
  if (chars.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while ([...rest].length > max) {
    const window = [...rest].slice(0, max).join("");
    // Prefer a paragraph break, then a line break, then a space, as long as
    // it leaves the chunk at least half full; otherwise cut hard.
    const minimum = window.length * 0.5;
    const cut = ["\n\n", "\n", " "]
      .map((separator) => window.lastIndexOf(separator))
      .find((index) => index > minimum);
    const end = cut ?? window.length;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
