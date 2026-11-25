import { Card, Actions, Button, LinkButton, Select, SelectOption, CardText } from "chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WatiAdapter, splitText, targetFor } from "./adapter";
import { createWatiAdapter } from "./factory";
import {
  API,
  CHANNEL,
  CUSTOMER,
  SECRET,
  createFakeFetch,
  createTestContext,
  incomingMessage,
} from "./test-utils";

const THREAD = `wati:${CHANNEL}:${CUSTOMER}`;

describe("createWatiAdapter", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WATI_API_ENDPOINT;
    delete process.env.WATI_ACCESS_TOKEN;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("creates an adapter from explicit config", () => {
    const adapter = createWatiAdapter({ apiEndpoint: API, accessToken: "t" });
    expect(adapter.name).toBe("wati");
    expect(adapter).toBeInstanceOf(WatiAdapter);
  });

  it("reads environment variables", () => {
    process.env.WATI_API_ENDPOINT = API;
    process.env.WATI_ACCESS_TOKEN = "t";
    process.env.WATI_CHANNEL_PHONE_NUMBER = "+1 415 555 0123";
    process.env.WATI_BOT_USERNAME = "Support Bot";
    const adapter = createWatiAdapter();
    expect(adapter.botUserId).toBe(CHANNEL);
    expect(adapter.userName).toBe("Support Bot");
  });

  it("requires an API endpoint", () => {
    expect(() => createWatiAdapter({ accessToken: "t" })).toThrow(/WATI_API_ENDPOINT/);
  });

  it("requires an access token", () => {
    expect(() => createWatiAdapter({ apiEndpoint: API })).toThrow(/WATI_ACCESS_TOKEN/);
  });
});

describe("thread IDs", () => {
  const adapter = new WatiAdapter({ apiEndpoint: API, accessToken: "t" });

  it("round-trips channel and customer", () => {
    const id = adapter.encodeThreadId({ channelPhoneNumber: CHANNEL, waId: CUSTOMER });
    expect(id).toBe(THREAD);
    expect(adapter.decodeThreadId(id)).toEqual({ channelPhoneNumber: CHANNEL, waId: CUSTOMER });
  });

  it("round-trips an empty channel and a BSUID", () => {
    const id = adapter.encodeThreadId({ channelPhoneNumber: "", waId: "HK.abc:def" });
    expect(adapter.decodeThreadId(id)).toEqual({ channelPhoneNumber: "", waId: "HK.abc:def" });
  });

  it("rejects other adapters' IDs", () => {
    expect(() => adapter.decodeThreadId("slack:C1:123")).toThrow();
    expect(() => adapter.decodeThreadId("wati:123")).toThrow();
  });

  it("derives the channel ID and target", () => {
    expect(adapter.channelIdFromThreadId(THREAD)).toBe(`wati:${CHANNEL}`);
    expect(targetFor({ channelPhoneNumber: CHANNEL, waId: CUSTOMER })).toBe(`${CHANNEL}:${CUSTOMER}`);
    expect(targetFor({ channelPhoneNumber: "", waId: CUSTOMER })).toBe(CUSTOMER);
    expect(adapter.isDM()).toBe(true);
  });

  it("opens a DM from a formatted phone number", async () => {
    const withChannel = new WatiAdapter({
      apiEndpoint: API,
      accessToken: "t",
      channelPhoneNumber: CHANNEL,
    });
    expect(await withChannel.openDM("+44 7700 900123")).toBe(THREAD);
  });
});

describe("webhook verification", () => {
  it("accepts the secret as a token query parameter", async () => {
    const ctx = createTestContext();
    const res = await ctx.send(incomingMessage());
    expect(res.status).toBe(200);
    expect(ctx.received.messages).toHaveLength(1);
  });

  it("accepts the secret as a header", async () => {
    const ctx = createTestContext();
    const res = await ctx.send(incomingMessage(), { token: null, header: SECRET });
    expect(res.status).toBe(200);
  });

  it("rejects a missing secret", async () => {
    const ctx = createTestContext();
    const res = await ctx.send(incomingMessage(), { token: null });
    expect(res.status).toBe(401);
    expect(ctx.received.messages).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    const ctx = createTestContext();
    const res = await ctx.send(incomingMessage(), { token: "nope" });
    expect(res.status).toBe(401);
  });

  it("rejects everything when no secret is configured", async () => {
    const ctx = createTestContext({ config: { webhookSecret: undefined } });
    delete process.env.WATI_WEBHOOK_SECRET;
    const res = await ctx.send(incomingMessage());
    expect(res.status).toBe(401);
  });

  it("resolves a function-form secret", async () => {
    const ctx = createTestContext({ config: { webhookSecret: async () => SECRET } });
    expect((await ctx.send(incomingMessage())).status).toBe(200);
  });

  it("can be disabled for local development", async () => {
    const ctx = createTestContext({ config: { verifyWebhooks: false } });
    expect((await ctx.send(incomingMessage(), { token: null })).status).toBe(200);
  });

  it("rejects non-POST and invalid JSON", async () => {
    const ctx = createTestContext();
    const get = await ctx.adapter.handleWebhook(new Request("https://x/?token=" + SECRET));
    expect(get.status).toBe(405);
    expect((await ctx.send("{not json")).status).toBe(400);
  });
});

describe("incoming messages", () => {
  it("parses a text message", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage({ text: "*bold* and _italic_" }));
    const { thread, message } = ctx.received.messages[0]!;
    expect(thread.id).toBe(THREAD);
    expect(message.text).toBe("bold and italic");
    expect(message.author).toMatchObject({
      userId: CUSTOMER,
      userName: "Ana",
      isBot: false,
      isMe: false,
    });
    expect(message.metadata.dateSent.toISOString()).toBe("2025-11-27T10:14:13.000Z");
  });

  it("ignores business-sent echoes and status events", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage({ owner: true }));
    await ctx.send(incomingMessage({ id: "s1", eventType: "sessionMessageSent_v2", owner: true }));
    await ctx.send(incomingMessage({ id: "d1", eventType: "sentMessageDELIVERED_v2" }));
    expect(ctx.received.messages).toHaveLength(0);
  });

  it("deduplicates repeat deliveries", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    await ctx.send(incomingMessage());
    await ctx.send(incomingMessage({ eventType: "newContactMessageReceived" }));
    expect(ctx.received.messages).toHaveLength(1);
  });

  it("accepts a batched array", async () => {
    const ctx = createTestContext();
    // Different customers: Chat SDK's default concurrency drops overlapping
    // messages on the same thread.
    await ctx.send([
      incomingMessage({ id: "a" }),
      incomingMessage({ id: "b", text: "two", waId: "6591234567" }),
    ]);
    expect(ctx.received.messages.map((m) => m.message.id)).toEqual(["a", "b"]);
  });

  it("exposes media as an attachment that downloads through the V3 API", async () => {
    const ctx = createTestContext({
      routes: {
        "GET /api/ext/v3/conversations/messages/file/img-1": () =>
          new Response(new Uint8Array([1, 2, 3])),
      },
    });
    await ctx.send(
      incomingMessage({
        id: "img-1",
        type: "image",
        text: null,
        data: "https://live-mt-server.wati.io/123/api/file/showFile?fileName=data/images/photo.jpg",
      }),
    );
    const attachment = ctx.received.messages[0]!.message.attachments[0]!;
    expect(attachment).toMatchObject({ type: "image", name: "photo.jpg" });
    const data = await attachment.fetchData!();
    expect([...new Uint8Array(data)]).toEqual([1, 2, 3]);
    expect(ctx.calls.at(-1)!.headers.authorization).toBe("Bearer test-token");
  });

  it("maps voice notes and documents", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage({ id: "v", type: "voice", text: null, data: null }));
    await ctx.send(incomingMessage({ id: "d", type: "document", text: "invoice.pdf", data: null }));
    expect(ctx.received.messages[0]!.message.attachments[0]!.type).toBe("audio");
    expect(ctx.received.messages[1]!.message.attachments[0]).toMatchObject({
      type: "file",
      name: "invoice.pdf",
    });
  });

  it("turns a location into a maps link", async () => {
    const ctx = createTestContext();
    await ctx.send(
      incomingMessage({ type: "location", text: null, data: { latitude: 1.3, longitude: 103.8 } }),
    );
    expect(ctx.received.messages[0]!.message.text).toContain("1.3,103.8");
  });

  it("delivers reactions", async () => {
    const ctx = createTestContext();
    await ctx.send(
      incomingMessage({ id: "r1", type: "reaction", text: "👍", replyContextId: "wamid.target" }),
    );
    expect(ctx.received.reactions).toHaveLength(1);
    expect(ctx.received.reactions[0]).toMatchObject({
      added: true,
      rawEmoji: "👍",
      messageId: "wamid.target",
      threadId: THREAD,
    });
  });
});

describe("sending", () => {
  it("posts WhatsApp-formatted text to the channel target", async () => {
    const ctx = createTestContext();
    const result = await ctx.adapter.postMessage(THREAD, { markdown: "**Hi** ~~old~~ [docs](https://wati.io)" });
    const call = ctx.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API}/api/ext/v3/conversations/messages/text`);
    expect(call.headers.authorization).toBe("Bearer test-token");
    expect(call.json).toEqual({
      target: `${CHANNEL}:${CUSTOMER}`,
      text: "*Hi* ~old~ docs (https://wati.io)",
    });
    expect(result.id).toBe("msg-1");
    expect(result.threadId).toBe(THREAD);
  });

  it("resolves function-form tokens on every call and strips a Bearer prefix", async () => {
    let n = 0;
    const fake = createFakeFetch();
    const adapter = new WatiAdapter({
      apiEndpoint: `${API}/api/v1/`,
      accessToken: () => `Bearer token-${++n}`,
      fetch: fake.fetch,
    });
    await adapter.postMessage(THREAD, "one");
    await adapter.postMessage(THREAD, "two");
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(fake.calls[0]!.url).toBe(`${API}/api/ext/v3/conversations/messages/text`);
  });

  it("accepts the dashboard endpoint with a tenant ID or without a scheme", async () => {
    for (const apiEndpoint of [`${API}/1234567`, `${API}/1234567/`, "live-mt-server.wati.io"]) {
      const fake = createFakeFetch();
      const adapter = new WatiAdapter({ apiEndpoint, accessToken: "t", fetch: fake.fetch });
      await adapter.postMessage(THREAD, "hi");
      expect(fake.calls[0]!.url).toBe(`${API}/api/ext/v3/conversations/messages/text`);
    }
  });

  it("splits text longer than 4096 characters", async () => {
    const ctx = createTestContext();
    await ctx.adapter.postMessage(THREAD, { raw: `${"a".repeat(3000)}\n\n${"b".repeat(3000)}` });
    expect(ctx.calls).toHaveLength(2);
    expect(splitText("x".repeat(9000), 4096).every((p) => p.length <= 4096)).toBe(true);
  });

  it("splits long text at paragraph breaks before spaces", () => {
    const paragraph = (n: number) => `${n}. ${"word ".repeat(18).trim()}`;
    const text = Array.from({ length: 60 }, (_, i) => paragraph(i + 1)).join("\n\n");
    const parts = splitText(text, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part).toMatch(/^\d+\. /);
      expect(part.endsWith("word")).toBe(true);
    }
    expect(parts.join("\n\n")).toBe(text);
  });

  it("rejects empty text", async () => {
    const ctx = createTestContext();
    await expect(ctx.adapter.postMessage(THREAD, "   ")).rejects.toThrow(/empty/);
  });

  it("uploads files with the text as caption", async () => {
    const ctx = createTestContext();
    await ctx.adapter.postMessage(THREAD, {
      markdown: "Your receipt",
      files: [{ data: Buffer.from("pdf"), filename: "receipt.pdf", mimeType: "application/pdf" }],
    });
    const call = ctx.calls[0]!;
    expect(call.path).toBe("/api/ext/v3/conversations/messages/file");
    expect(call.form?.get("target")).toBe(`${CHANNEL}:${CUSTOMER}`);
    expect(call.form?.get("caption")).toBe("Your receipt");
    expect((call.form?.get("file") as File).name).toBe("receipt.pdf");
  });

  it("sends URL attachments via fileViaUrl", async () => {
    const ctx = createTestContext();
    await ctx.adapter.postMessage(THREAD, {
      markdown: "Look",
      attachments: [{ type: "image", url: "https://example.com/a.png" }],
    });
    expect(ctx.calls[0]!.path).toBe("/api/ext/v3/conversations/messages/fileViaUrl");
    expect(ctx.calls[0]!.json).toEqual({
      target: `${CHANNEL}:${CUSTOMER}`,
      file_url: "https://example.com/a.png",
      caption: "Look",
    });
  });

  it("collects streams into one message", async () => {
    const ctx = createTestContext();
    async function* chunks() {
      yield "Hello ";
      yield { type: "markdown_text" as const, text: "**world**" };
    }
    await ctx.adapter.stream(THREAD, chunks());
    expect(ctx.calls).toHaveLength(1);
    expect((ctx.calls[0]!.json as { text: string }).text).toBe("Hello *world*");
  });

  it("sends a typing indicator", async () => {
    const ctx = createTestContext();
    await ctx.adapter.startTyping(THREAD);
    expect(ctx.calls[0]!.path).toBe("/api/ext/v3/conversations/typingIndicator");
    expect(ctx.calls[0]!.json).toEqual({ target: `${CHANNEL}:${CUSTOMER}` });
  });

  it("keeps going when Wati has typing indicators disabled", async () => {
    const ctx = createTestContext({
      routes: {
        "POST /api/ext/v3/conversations/typingIndicator": () =>
          new Response(
            JSON.stringify({ code: 400, message: "Typing indicator is disabled for this account." }),
            { status: 400 },
          ),
      },
    });
    await expect(ctx.adapter.startTyping(THREAD)).resolves.toBeUndefined();
    await ctx.adapter.startTyping(THREAD);
    // The second call is skipped once Wati has said the feature is off.
    expect(ctx.calls.filter((c) => c.path.endsWith("/typingIndicator"))).toHaveLength(1);
  });

  it("does not throw on other typing indicator failures", async () => {
    const ctx = createTestContext({
      routes: { "POST *": () => new Response("", { status: 500 }) },
    });
    await expect(ctx.adapter.startTyping(THREAD)).resolves.toBeUndefined();
  });

  it("reports unsupported operations", async () => {
    const ctx = createTestContext();
    await expect(ctx.adapter.editMessage()).rejects.toThrow(/editing/);
    await expect(ctx.adapter.deleteMessage()).rejects.toThrow(/deleting/);
    await expect(ctx.adapter.addReaction(THREAD, "m", "👍")).rejects.toThrow(/reactions/);
    await expect(ctx.adapter.removeReaction(THREAD, "m", "👍")).rejects.toThrow(/reactions/);
  });
});

describe("API errors", () => {
  const cases: [number, RegExp][] = [
    [400, /rejected/],
    [401, /401/],
    [403, /Permission|permission/],
    [404, /not found/i],
    [500, /500/],
  ];
  for (const [status, pattern] of cases) {
    it(`maps HTTP ${status}`, async () => {
      const ctx = createTestContext({
        routes: {
          "POST *": () =>
            new Response(JSON.stringify({ code: status, message: "nope" }), { status }),
        },
      });
      await expect(ctx.adapter.postMessage(THREAD, "hi")).rejects.toThrow(pattern);
    });
  }

  it("maps 429 with Retry-After", async () => {
    const ctx = createTestContext({
      routes: {
        "POST *": () => new Response("", { status: 429, headers: { "retry-after": "7" } }),
      },
    });
    await expect(ctx.adapter.postMessage(THREAD, "hi")).rejects.toMatchObject({
      retryAfter: 7,
    });
  });

  it("wraps network failures", async () => {
    const adapter = new WatiAdapter({
      apiEndpoint: API,
      accessToken: "t",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(adapter.postMessage(THREAD, "hi")).rejects.toThrow(/Request to Wati failed/);
  });
});

describe("cards and button replies", () => {
  it("sends reply buttons and routes the reply to onAction", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    const { thread } = ctx.received.messages[0]!;
    await thread.post(
      Card({
        title: "Order #42",
        children: [
          CardText("Ship it?"),
          Actions([
            Button({ id: "approve", label: "Approve", value: "42" }),
            Button({ id: "reject", label: "Reject", value: "42" }),
          ]),
        ],
      }),
    );
    const sent = ctx.calls.find((c) => c.path.endsWith("/interactive"))!;
    expect(sent.json).toEqual({
      target: `${CHANNEL}:${CUSTOMER}`,
      type: "buttons",
      button_message: {
        header: { type: "Text", text: "Order #42" },
        body: "Ship it?",
        buttons: [{ text: "Approve" }, { text: "Reject" }],
      },
    });

    await ctx.send(
      incomingMessage({
        id: "reply-1",
        type: "interactive",
        text: "Approve",
        interactiveButtonReply: { title: "Approve" },
        replyContextId: "wamid.card",
      }),
    );
    expect(ctx.received.actions).toHaveLength(1);
    expect(ctx.received.actions[0]).toMatchObject({
      actionId: "approve",
      value: "42",
      messageId: "wamid.card",
      threadId: THREAD,
      user: { userId: CUSTOMER },
    });
  });

  it("sends select menus as list messages and routes the choice", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    const { thread } = ctx.received.messages[0]!;
    await thread.post(
      Card({
        title: "Pick a size",
        children: [
          CardText("We have three."),
          Actions([
            Select({
              id: "size",
              label: "Sizes",
              options: [
                SelectOption({ label: "Small", value: "s", description: "Fits most" }),
                SelectOption({ label: "Large", value: "l" }),
              ],
            }),
          ]),
        ],
      }),
    );
    const sent = ctx.calls.find((c) => c.path.endsWith("/interactive"))!;
    expect(sent.json).toMatchObject({
      type: "list",
      list_message: {
        header: "Pick a size",
        body: "We have three.",
        button_text: "Sizes",
        sections: [
          {
            title: "Sizes",
            rows: [{ title: "Small", description: "Fits most" }, { title: "Large" }],
          },
        ],
      },
    });
    await ctx.send(
      incomingMessage({ id: "reply-2", type: "interactive", text: "Large", listReply: { title: "Large" } }),
    );
    expect(ctx.received.actions[0]).toMatchObject({ actionId: "size", value: "l" });
  });

  it("keeps buttons next to a select as an extra list section and routes both", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    const { thread } = ctx.received.messages[0]!;
    await thread.post(
      Card({
        title: "Pick a size",
        children: [
          CardText("Or talk to us."),
          Actions([
            Select({
              id: "size",
              label: "Sizes",
              options: [SelectOption({ label: "Small", value: "s" }), SelectOption({ label: "Large", value: "l" })],
            }),
            Button({ id: "agent", label: "Talk to an agent", value: "help" }),
          ]),
        ],
      }),
    );
    const sent = ctx.calls.find((c) => c.path.endsWith("/interactive"))!;
    expect(sent.json).toMatchObject({
      type: "list",
      list_message: {
        button_text: "Options",
        sections: [
          { title: "Sizes", rows: [{ title: "Small" }, { title: "Large" }] },
          { title: "More options", rows: [{ title: "Talk to an agent" }] },
        ],
      },
    });

    await ctx.send(
      incomingMessage({ id: "reply-a", type: "interactive", text: null, listReply: { title: "Talk to an agent" } }),
    );
    await ctx.send(incomingMessage({ id: "reply-b", type: "interactive", text: null, listReply: { title: "Small" } }));
    expect(ctx.received.actions.map((a) => [a.actionId, a.value])).toEqual([
      ["agent", "help"],
      ["size", "s"],
    ]);
  });

  it("rejects a select plus buttons over the 10-option list limit instead of dropping any", async () => {
    const ctx = createTestContext();
    await expect(
      ctx.adapter.postMessage(THREAD, {
        card: Card({
          children: [
            Actions([
              Select({
                id: "n",
                label: "Numbers",
                options: Array.from({ length: 9 }, (_, i) => SelectOption({ label: `Option ${i + 1}`, value: `${i + 1}` })),
              }),
              Button({ id: "a", label: "Extra A" }),
              Button({ id: "b", label: "Extra B" }),
            ]),
          ],
        }),
      }),
    ).rejects.toThrow(/at most 10 options; this card has 11/);
    expect(ctx.calls).toHaveLength(0);
  });

  // Payload shapes below were captured from a live Wati account (2026-11-17).
  it("routes a real Wati button tap payload", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    const { thread } = ctx.received.messages[0]!;
    await thread.post(
      Card({ children: [CardText("Approve?"), Actions([Button({ id: "approve", label: "Approve", value: "1042" })])] }),
    );
    await ctx.send(
      incomingMessage({
        id: "6afc0fcd764de2078b1ee6e5",
        text: "Approve",
        type: "interactive",
        interactiveButtonReply: { id: "1", title: "Approve" },
        replyContextId: "wamid.card",
      }),
    );
    expect(ctx.received.actions[0]).toMatchObject({ actionId: "approve", value: "1042", messageId: "wamid.card" });
  });

  it("routes a real Wati list reply payload (text is null, field typo included)", async () => {
    const ctx = createTestContext();
    await ctx.send(incomingMessage());
    const { thread } = ctx.received.messages[0]!;
    await thread.post(
      Card({
        children: [
          Actions([
            Select({
              id: "size",
              label: "Sizes",
              options: [SelectOption({ label: "Small", value: "S" }), SelectOption({ label: "Medium", value: "M" })],
            }),
          ]),
        ],
      }),
    );
    await ctx.send(
      incomingMessage({
        id: "6afc1002a65bc67740c53b7c",
        text: null,
        type: "interactive",
        listReply: { title: "Medium", desription: "Chest 96–101 cm", id: "0-1" },
        replyContextId: "wamid.list",
      }),
    );
    expect(ctx.received.actions[0]).toMatchObject({ actionId: "size", value: "M", messageId: "wamid.list" });
  });

  it("ignores real Wati delivery and read status events", async () => {
    const ctx = createTestContext();
    for (const eventType of ["sentMessageDELIVERED", "sentMessageREAD"]) {
      await ctx.send({
        eventType,
        statusString: eventType === "sentMessageREAD" ? "Read" : "Delivered",
        id: `status-${eventType}`,
        whatsappMessageId: "wamid.x",
        conversationId: "c",
        text: "Refund request #1042",
        type: "text",
        timestamp: "1794904006",
        assigneeId: "a",
        operatorEmail: "api-token-user@example.com",
      });
    }
    expect(ctx.received.messages).toHaveLength(0);
  });

  it("delivers unknown button replies as normal messages", async () => {
    const ctx = createTestContext();
    await ctx.send(
      incomingMessage({ id: "q", type: "button", text: "Yes please", buttonReply: { text: "Yes please" } }),
    );
    expect(ctx.received.actions).toHaveLength(0);
    expect(ctx.received.messages[0]!.message.text).toBe("Yes please");
  });

  it("writes link buttons out as URLs in text cards", async () => {
    const ctx = createTestContext();
    await ctx.adapter.postMessage(THREAD, {
      card: Card({
        title: "Docs",
        children: [CardText("Read more"), Actions([LinkButton({ label: "Open", url: "https://docs.wati.io" })])],
      }),
    });
    expect(ctx.calls[0]!.json).toEqual({
      target: `${CHANNEL}:${CUSTOMER}`,
      text: "*Docs*\n\nRead more\n\nOpen: https://docs.wati.io",
    });
  });
});

describe("templates", () => {
  it("sends a template and returns the recipient's thread", async () => {
    const ctx = createTestContext({
      config: { channelPhoneNumber: CHANNEL },
      routes: {
        "POST /api/ext/v3/messageTemplates/send": () => ({
          success: true,
          broadcast_id: "b-1",
          recipients: [{ phone_number: CUSTOMER, errors: [] }],
        }),
      },
    });
    const result = await ctx.adapter.sendTemplate("+44 7700 900123", {
      templateName: "order_update",
      parameters: [{ name: "order", value: "42" }],
    });
    expect(ctx.calls[0]!.json).toEqual({
      template_name: "order_update",
      broadcast_name: "chat-sdk",
      channel: CHANNEL,
      recipients: [{ phone_number: CUSTOMER, custom_params: [{ name: "order", value: "42" }] }],
    });
    expect(result).toMatchObject({ broadcastId: "b-1", threadId: THREAD });
  });

  it("explains Wati's misleading 'no valid Receivers' error", async () => {
    const ctx = createTestContext({
      routes: {
        "POST /api/ext/v3/messageTemplates/send": () => ({
          success: false,
          error: "There are no valid Receivers",
        }),
      },
    });
    await expect(
      ctx.adapter.sendTemplate(THREAD, { templateName: "chat_sdk_test", parameters: [{ name: "1", value: "Ana" }] }),
    ).rejects.toThrow(/parameter names match the template's Wati names/);
  });

  it("throws when Wati reports a recipient error", async () => {
    const ctx = createTestContext({
      routes: {
        "POST /api/ext/v3/messageTemplates/send": () => ({
          success: true,
          recipients: [{ phone_number: CUSTOMER, errors: ["template not approved"] }],
        }),
      },
    });
    await expect(ctx.adapter.sendTemplate(THREAD, { templateName: "x" })).rejects.toThrow(
      /did not accept/,
    );
  });
});

describe("history", () => {
  it("fetches messages oldest-first with page cursors", async () => {
    const ctx = createTestContext({
      routes: {
        "GET *": () => ({
          message_list: [
            { id: "2", text: "Hi Ana", owner: true, operator_name: "Bot", created: "2026-07-14T16:15:40Z", event_type: "message" },
            { id: "1", text: "hello", owner: false, created: "2026-07-14T16:15:38Z", event_type: "message" },
            { id: "t", event_type: "ticket", created: "2026-07-14T16:15:30Z" },
          ],
          page_number: 1,
          page_size: 3,
        }),
      },
    });
    const page = await ctx.adapter.fetchMessages(THREAD, { limit: 3 });
    expect(ctx.calls[0]!.url).toBe(
      `${API}/api/ext/v3/conversations/${encodeURIComponent(`${CHANNEL}:${CUSTOMER}`)}/messages?page_number=1&page_size=3`,
    );
    expect(page.messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(page.messages[1]!.author.isMe).toBe(true);
    expect(page.nextCursor).toBe("2");

    await ctx.adapter.fetchMessages(THREAD, { limit: 3, cursor: page.nextCursor });
    expect(ctx.calls[1]!.url).toContain("page_number=2");
  });

  it("fetches thread info with the contact name", async () => {
    const ctx = createTestContext({
      routes: { "GET *": () => ({ contact: { name: "Ana Lima" } }) },
    });
    const info = await ctx.adapter.fetchThread(THREAD);
    expect(info).toMatchObject({ id: THREAD, isDM: true, channelName: "WhatsApp: Ana Lima" });
  });
});
