import { headers } from "next/headers";
import { checkWatiConnection, configStatus } from "@/lib/config";

export const dynamic = "force-dynamic";

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <span className={ok ? "ok" : "bad"}>{children}</span>;
}

export default async function Home() {
  const config = configStatus();
  const connection = await checkWatiConnection();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "your-app.vercel.app";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const webhookUrl = `${proto}://${host}/api/webhooks/wati?token=<WATI_WEBHOOK_SECRET>`;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");

  return (
    <main>
      <h1>Wati × Chat SDK test bot</h1>
      <p className="muted">
        A WhatsApp bot built with <code>@wati-io/chat-sdk-adapter</code>. Message your Wati number and send{" "}
        <code>help</code>.
      </p>

      <h2>Configuration</h2>
      <div className="card">
        <table>
          <tbody>
            <tr>
              <td><code>WATI_API_ENDPOINT</code></td>
              <td>{config.apiEndpoint ? <code>{config.apiEndpoint}</code> : <Status ok={false}>Missing</Status>}</td>
            </tr>
            <tr>
              <td><code>WATI_ACCESS_TOKEN</code></td>
              <td><Status ok={config.hasAccessToken}>{config.hasAccessToken ? "Set" : "Missing"}</Status></td>
            </tr>
            <tr>
              <td><code>WATI_WEBHOOK_SECRET</code></td>
              <td><Status ok={config.hasWebhookSecret}>{config.hasWebhookSecret ? "Set" : "Missing"}</Status></td>
            </tr>
            <tr>
              <td><code>WATI_CHANNEL_PHONE_NUMBER</code></td>
              <td>{config.channelPhoneNumber ? <code>{config.channelPhoneNumber}</code> : <span className="muted">Not set (optional)</span>}</td>
            </tr>
            <tr>
              <td>State</td>
              <td>
                {config.state === "redis" ? (
                  <Status ok>Redis</Status>
                ) : (
                  <span className="muted">
                    In memory. Fine locally; on Vercel add Redis (<code>REDIS_URL</code> or <code>KV_URL</code>) so button taps work
                    across instances.
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <td>Wati API connection</td>
              <td><Status ok={connection.ok}>{connection.ok ? "OK" : "Failed"}</Status> <span className="muted">{connection.detail}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Webhook URL</h2>
      <p>In Wati, open <strong>Webhooks</strong>, add this URL with your secret in place of the placeholder, and subscribe to <strong>Message Received</strong>:</p>
      <pre>{webhookUrl}</pre>
      {isLocal && (
        <p className="muted">
          Wati can&apos;t reach localhost. Run a tunnel such as <code>ngrok http 3000</code> or{" "}
          <code>cloudflared tunnel --url http://localhost:3000</code> and open this page through the tunnel URL to get the
          public webhook address.
        </p>
      )}

      <h2>Try it</h2>
      <ol>
        <li>From your phone, send any message to your Wati WhatsApp number.</li>
        <li>Reply <code>help</code> for the list of test commands: buttons, menu, file, pdf, typing, history, long, template.</li>
        <li>Send a photo or voice note, or react to a message.</li>
      </ol>
      <p className="muted">
        JSON health check: <code>/api/health</code>
      </p>
    </main>
  );
}
