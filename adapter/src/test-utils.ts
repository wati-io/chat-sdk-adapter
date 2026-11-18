import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type ActionEvent, type Message, type ReactionEvent, type Thread } from "chat";
import { WatiAdapter } from "./adapter";
import type { WatiAdapterConfig, WatiWebhookMessage } from "./types";

export const API = "https://live-mt-server.wati.io";
export const SECRET = "test-webhook-secret";
export const CHANNEL = "14155550123"; // US 555-01xx, reserved for fiction
export const CUSTOMER = "447700900123"; // UK 07700 900xxx, reserved for drama

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  json?: unknown;
  form?: FormData;
}

/** A fake `fetch` that records requests and answers from a route table. */
export function createFakeFetch(
  routes: Record<string, (call: RecordedCall) => Response | unknown> = {},
) {
  const calls: RecordedCall[] = [];
  let counter = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const call: RecordedCall = { method, url, path: parsed.pathname, headers };
    if (init?.body instanceof FormData) call.form = init.body;
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);

    const route =
      routes[`${method} ${parsed.pathname}`] ?? routes[`${method} *`];
    const result = route
      ? route(call)
      : { message: { id: `msg-${++counter}`, conversation_id: "conv-1" } };
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

export function incomingMessage(
  overrides: Partial<WatiWebhookMessage> = {},
): WatiWebhookMessage {
  return {
    id: "69282478274a880fe782b2d9",
    created: "2025-11-27T10:14:16.6268572Z",
    whatsappMessageId: "wamid.HBgNODYxODcxOTE0OTIxNBUCABIYFDNCRkJFNDFCMTI1MDAwQTRCMDMwAA==",
    conversationId: "68c8d56157578adb12ada249",
    ticketId: "69280a6d6244a6d9b9b486e9",
    text: "hello",
    type: "text",
    data: null,
    timestamp: "1764238453",
    owner: false,
    eventType: "message",
    statusString: "SENT",
    waId: CUSTOMER,
    senderName: "Ana",
    listReply: null,
    interactiveButtonReply: null,
    buttonReply: null,
    replyContextId: "",
    channelPhoneNumber: CHANNEL,
    ...overrides,
  };
}

export function webhookRequest(
  body: unknown,
  { token = SECRET, header }: { token?: string | null; header?: string } = {},
): Request {
  const url = new URL("https://bot.example.com/api/webhooks/wati");
  if (token) url.searchParams.set("token", token);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(header ? { "x-wati-webhook-secret": header } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function createTestContext(
  options: {
    config?: Partial<WatiAdapterConfig>;
    routes?: Parameters<typeof createFakeFetch>[0];
  } = {},
) {
  const fake = createFakeFetch(options.routes);
  const adapter = new WatiAdapter({
    apiEndpoint: API,
    accessToken: "test-token",
    webhookSecret: SECRET,
    fetch: fake.fetch,
    ...options.config,
  });
  const chat = new Chat({
    userName: "wati-bot",
    adapters: { wati: adapter },
    state: createMemoryState(),
    logger: "error",
  });

  const received: {
    messages: { thread: Thread; message: Message }[];
    actions: ActionEvent[];
    reactions: ReactionEvent[];
  } = { messages: [], actions: [], reactions: [] };

  chat.onDirectMessage(async (thread, message) => {
    received.messages.push({ thread, message });
  });
  chat.onAction(async (event) => {
    received.actions.push(event);
  });
  chat.onReaction(async (event) => {
    received.reactions.push(event);
  });

  const tasks: Promise<unknown>[] = [];
  const send = async (body: unknown, requestOptions?: Parameters<typeof webhookRequest>[1]) => {
    const response = await chat.webhooks.wati(webhookRequest(body, requestOptions), {
      waitUntil: (task) => {
        tasks.push(task);
      },
    });
    while (tasks.length) await Promise.all(tasks.splice(0));
    return response;
  };

  return { adapter, chat, calls: fake.calls, received, send };
}
