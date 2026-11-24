# @wati-io/chat-sdk-adapter

[![npm version](https://img.shields.io/npm/v/@wati-io/chat-sdk-adapter)](https://www.npmjs.com/package/@wati-io/chat-sdk-adapter)
[![CI](https://github.com/wati-io/chat-sdk-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/wati-io/chat-sdk-adapter/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wati-io/chat-sdk-adapter)](https://github.com/wati-io/chat-sdk-adapter/blob/main/adapter/LICENSE)

WhatsApp adapter for [Chat SDK](https://chat-sdk.dev), built on the [Wati](https://www.wati.io) API. Receive WhatsApp messages from Wati webhooks, reply from Chat SDK handlers, send reply buttons, list menus, files and templates, and read conversation history.

```bash
npm install @wati-io/chat-sdk-adapter chat @chat-adapter/state-memory
```

## Quick start

```typescript title="lib/bot.ts"
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createWatiAdapter } from "@wati-io/chat-sdk-adapter";

export const bot = new Chat({
  userName: "support",
  state: createMemoryState(), // use a durable state adapter in production
  adapters: {
    wati: createWatiAdapter(), // reads WATI_* env vars
  },
});

bot.onDirectMessage(async (thread, message) => {
  await thread.startTyping();
  await thread.post(`You said: ${message.text}`);
});
```

```typescript title="app/api/webhooks/wati/route.ts"
import { after } from "next/server";
import { bot } from "@/lib/bot";

export async function POST(request: Request): Promise<Response> {
  return bot.webhooks.wati(request, {
    waitUntil: (task) => after(() => task),
  });
}
```

Every WhatsApp conversation is one-to-one, so handle messages with `onDirectMessage`.

## Requirements

A Wati plan with **webhooks** and the **messaging API**. On Wati's current [pricing](https://www.wati.io/pricing-comparison/), that's **Pro** or **Business**. Growth includes the messaging API but no webhooks, so on Growth the adapter can only send (`postMessage`, `sendTemplate`); it can't receive messages.

**Try it free:** the [7-day Wati free trial](https://www.wati.io/signup/) includes the API and webhooks once your WhatsApp number is connected, so you can build and test a bot before choosing a plan.

## Setup in Wati

1. In Wati, open **API Docs** and copy the **API endpoint** host (for example `https://live-mt-server.wati.io`) and an **access token**. Use the host for your workspace's region.
2. Generate a long random webhook secret, for example `openssl rand -hex 32`.
3. In Wati, open **Webhooks** and add your webhook URL with the secret as a `token` query parameter:
   `https://your-app.com/api/webhooks/wati?token=<secret>`
4. Subscribe to the **Message Received** (`message`) event. You don't need status events.
5. Set the environment variables below.

Wati doesn't sign webhooks, so the adapter checks a shared secret instead, the same way Chat SDK's Telegram adapter does. Every delivery must carry your secret in the `token` query parameter; anything else gets a `401`. Use a long random secret and keep the full webhook URL private, since it contains the secret. (An `x-wati-webhook-secret` header is also accepted, for setups that can add headers.)

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `WATI_API_ENDPOINT` | Yes | Wati REST API host for your workspace, without the tenant ID. |
| `WATI_ACCESS_TOKEN` | Yes | Wati API access token. A `Bearer ` prefix is accepted. |
| `WATI_WEBHOOK_SECRET` | Yes | Secret that every webhook must carry (see setup). |
| `WATI_CHANNEL_PHONE_NUMBER` | No | Your WhatsApp Business number. Used by `openDM()` and `sendTemplate()` when you have several numbers. |
| `WATI_BOT_USERNAME` | No | Bot display name. Defaults to the Chat `userName`. |

## Configuration

All options are optional when the env vars are set.

| Option | Type | Description |
| --- | --- | --- |
| `apiEndpoint` | `string` | Wati API host. |
| `accessToken` | `string \| () => string \| Promise<string>` | Access token. Functions are called on every request, so rotating tokens work. |
| `webhookSecret` | `string \| () => string \| Promise<string>` | Webhook secret. |
| `verifyWebhooks` | `boolean` | Default `true`. Set `false` only for local testing. |
| `channelPhoneNumber` | `string` | Default sending number. |
| `userName` | `string` | Bot display name. |
| `actionMappingTtlMs` | `number` | How long button and list replies stay routable. Default 30 days. |
| `logger` | `Logger` | Chat SDK logger. |
| `fetch` | `typeof fetch` | Custom fetch, for tests or proxies. |

## Sending

Markdown is converted to WhatsApp formatting: `**bold**` becomes `*bold*`, links become `label (url)`, and tables become monospace blocks. Text longer than WhatsApp's 4,096-character limit is split into several messages.

```typescript
await thread.post({ markdown: "Your order **#42** has shipped." });
```

### Files

```typescript
await thread.post({
  markdown: "Here is your receipt.",
  files: [{ filename: "receipt.pdf", mimeType: "application/pdf", data: pdfBuffer }],
});
```

The text becomes the caption of the first file. Attachments with only a `url` are sent by URL without downloading them.

### Buttons and lists

```tsx
import { Actions, Button, Card, CardText } from "chat";

await thread.post(
  Card({
    title: "Order #42",
    children: [
      CardText("Ship it now?"),
      Actions([
        Button({ id: "ship", label: "Ship", value: "42" }),
        Button({ id: "hold", label: "Hold", value: "42" }),
      ]),
    ],
  }),
);

bot.onAction("ship", async (event) => {
  await event.thread?.post(`Shipping order ${event.value}`);
});
```

| Card content | Sent as |
| --- | --- |
| 1 to 3 buttons | WhatsApp reply buttons. A card `imageUrl` becomes the image header. |
| 4 to 10 buttons | A WhatsApp list message |
| `Select` / `RadioSelect` | A WhatsApp list message, up to 10 options |
| Link buttons only | Text with the URLs written out |

WhatsApp sends back only the label of the button the customer tapped. The adapter stores which action each label stands for in your Chat state adapter, keyed by thread and label. This means:

- Labels in one message must be unique, and button labels must be 20 characters or fewer. The adapter throws a `ValidationError` instead of truncating them.
- Use a durable state adapter (Redis or Postgres) in production, so taps still work after a restart or on another instance.
- If the same thread is sent two cards with the same label, a tap routes to the most recent one.
- A tap on a button the adapter didn't send, such as a template quick reply, arrives as an ordinary message.

### Templates

WhatsApp only allows free-form messages within 24 hours of the customer's last message. To start a conversation, or to reply after the window closes, send an approved template:

```typescript
import type { WatiAdapter } from "@wati-io/chat-sdk-adapter";

const wati = bot.getAdapter("wati") as WatiAdapter;
const { threadId } = await wati.sendTemplate("+15551234567", {
  templateName: "order_update",
  parameters: [{ name: "order_id", value: "42" }],
});
await bot.thread(threadId).subscribe();
```

### Typing indicator

`thread.startTyping()` shows "typing…" for up to 25 seconds or until your reply arrives. It also marks the customer's last message as read.

Typing indicators are available on every Wati plan but are off until you turn them on: **Settings → Team Inbox → General Settings → Show typing indicator to customers** ([how to](https://support.wati.io/en/articles/14753951-how-to-enable-typing-indicator-in-wati)). While they're off, the adapter logs one warning, skips typing and still sends your replies.

## Receiving

- Text, media (image, video, audio, voice, document, sticker) and locations arrive as Chat SDK messages. Media attachments download lazily through `fetchData()`.
- Reactions arrive through `onReaction`.
- Messages sent by your team or by Wati chatbots are ignored, so the bot doesn't answer itself or your agents.
- Repeat deliveries are deduplicated by Chat SDK.
- Chat SDK drops a message that arrives while the same thread is still being handled. Customers often send several short messages in a row, so consider `concurrency: "queue"` or `"debounce"` in your `Chat` config.

## History

`thread.adapter.fetchMessages(thread.id, { limit })` reads the conversation from Wati, up to 100 messages per page. Messages from your side (this bot, chatbots or agents) have `author.isMe` set to `true`.

## Thread IDs

```text
wati:<business number>:<customer waId>
```

For example `wati:14155550100:6591234567`. The business number is empty when it is unknown and the workspace's default number is used.

## Not supported

- Editing or deleting sent messages (WhatsApp doesn't allow it).
- Sending reactions (the Wati API has no endpoint for it yet).
- Streaming. Streamed responses are collected and sent as one message.
- WhatsApp CTA URL buttons. Link buttons are sent as text.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

To release, set the version in `package.json`, add an entry to [`CHANGELOG.md`](CHANGELOG.md), merge to `main`, and push a matching tag such as `v0.1.0`. The release workflow runs the checks and publishes to npm with provenance.

## License

MIT
