# Wati × Chat SDK test bot

A Next.js app that runs a WhatsApp bot with [`@wati-io/chat-sdk-adapter`](https://www.npmjs.com/package/@wati-io/chat-sdk-adapter), installed from npm like any developer would. Use it to try every adapter feature from your phone, locally or on Vercel.

What you need:

- A Wati workspace with a connected WhatsApp number, on a plan that includes webhooks (Pro or Business on current [pricing](https://www.wati.io/pricing-comparison/))
- A Wati **API endpoint** and **access token** (Wati → **API Docs**)
- A phone with WhatsApp to message that number

## Run it locally

Wati has to reach your machine, so you need a tunnel.

1. In this folder, install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` from the template and fill it in:

   ```bash
   cp .env.example .env.local
   ```

   For `WATI_WEBHOOK_SECRET`, use any long random string:

   ```bash
   openssl rand -hex 32
   ```

3. Start the app on port 3000:

   ```bash
   npm run dev
   ```

4. In another terminal, open a tunnel to port 3000, with either ngrok or Cloudflare:

   ```bash
   ngrok http 3000
   ```

   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```

5. Open the tunnel's `https://…` URL in a browser. The status page checks your settings, tests the Wati connection and shows the webhook URL to register.
6. In Wati, open **Webhooks**, add `https://<tunnel-host>/api/webhooks/wati?token=<your WATI_WEBHOOK_SECRET>`, and subscribe to **Message Received**.
7. Message your Wati number from your phone and send `help`.

The tunnel URL changes each time you restart ngrok's free plan, so update the webhook in Wati when it does. If you also have a Vercel deployment, point Wati at only one of them at a time.

## Deploy to Vercel

1. In Vercel, click **Add New → Project** and import this GitHub repo.
2. Set **Root Directory** to `example`. Leave the framework and build settings as they are.
3. Add the environment variables from `.env.example`: `WATI_API_ENDPOINT`, `WATI_ACCESS_TOKEN`, `WATI_WEBHOOK_SECRET`, and optionally `WATI_CHANNEL_PHONE_NUMBER`.
4. Add Redis: **Storage → Create Database**, pick a Redis provider (Upstash or Redis Cloud, both with free plans), and connect it to this project. That sets `REDIS_URL` or `KV_URL`; the app reads either. Without Redis, button taps can land on a different serverless instance that doesn't know about the buttons.
5. Deploy, then open `https://<your-app>.vercel.app`. The status page shows whether everything is set and gives the webhook URL.
6. Register that webhook URL in Wati with your secret, and send `help` from your phone.

After changing environment variables in Vercel, redeploy so they take effect.

## Test commands

Send these to your Wati number:

| Message | What it tests |
| --- | --- |
| `help` | Text reply with WhatsApp formatting |
| `format` | Markdown conversion: bold, italic, lists, quote, link, table, code |
| `buttons` | Reply buttons. Tap one to test `onAction`. |
| `menu` | List message. Pick an option to test `onAction` with a value. |
| `file` | Uploading a generated text file |
| `pdf` | Sending a file by URL with a caption |
| `typing` | Typing indicator, then a reply 3 seconds later |
| `history` | `fetchMessages`: last 10 messages, oldest first |
| `long` | Splitting a message over 4,096 characters |
| `template <name>` | `sendTemplate` with an approved template |
| a photo, voice note or document | Incoming attachments and downloading them |
| a reaction on any message | `onReaction` |

## Troubleshooting

- **Status page says "Wati API connection: Failed (401)"**: the token is wrong, or `WATI_API_ENDPOINT` is for a different region than your workspace.
- **No reply, and Vercel logs show 401 on `/api/webhooks/wati`**: the `token` in the Wati webhook URL doesn't match `WATI_WEBHOOK_SECRET`.
- **No reply and no request in the logs**: check the webhook is enabled in Wati and subscribed to Message Received.
- **Button taps arrive as plain messages**: state was lost between the card and the tap. Add Redis.
- **Status page still says "In memory" after adding Redis**: when connecting the database, set **Custom Prefix** to `REDIS` so the variable is `REDIS_URL` (the default `STORAGE` prefix creates `STORAGE_URL`, which the app ignores). Then redeploy: new env vars only reach new deployments. `/api/health` lists the Redis-related variable names it can see.
- **A push didn't redeploy ("Skipped – Not affected")**: with Root Directory set to `example`, Vercel only rebuilds when `example/` changes. Use **Deployments → ⋯ → Redeploy** instead.
- **Wati rejects a send outside 24 hours**: WhatsApp only allows free-form replies within 24 hours of the customer's last message. Message the number again, or use `template <name>`.
- Logs appear in the terminal locally, or under the deployment's **Logs** tab in Vercel.

## Trying unreleased adapter changes

The app uses the published package. To try local changes in `../adapter` before releasing them, build the adapter and install it from the folder, then switch back:

```bash
npm run build --prefix ../adapter && npm install ../adapter
```

```bash
npm install @wati-io/chat-sdk-adapter@latest
```

## Files

| File | Purpose |
| --- | --- |
| `lib/bot.ts` | The bot: Chat setup and the test commands |
| `app/api/webhooks/wati/route.ts` | The webhook endpoint Wati calls |
| `app/page.tsx` | Status page |
| `app/api/health/route.ts` | The same checks as JSON |
