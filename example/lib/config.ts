/** Which settings are present. Never returns secret values. */
export function configStatus() {
  return {
    apiEndpoint: process.env.WATI_API_ENDPOINT ?? null,
    hasAccessToken: Boolean(process.env.WATI_ACCESS_TOKEN),
    hasWebhookSecret: Boolean(process.env.WATI_WEBHOOK_SECRET),
    channelPhoneNumber: process.env.WATI_CHANNEL_PHONE_NUMBER || null,
    state: process.env.REDIS_URL || process.env.KV_URL ? "redis" : "memory",
    // Names only (never values), to diagnose Redis integrations that use other variable names.
    redisEnvNames: Object.keys(process.env)
      .filter((name) => /REDIS|^KV_|UPSTASH/i.test(name))
      .sort(),
  } as const;
}

/** Call a cheap Wati endpoint to check the token and API host. */
export async function checkWatiConnection(): Promise<{ ok: boolean; detail: string }> {
  const endpoint = apiOrigin(process.env.WATI_API_ENDPOINT);
  const token = process.env.WATI_ACCESS_TOKEN?.trim().replace(/^Bearer\s+/i, "");
  if (!endpoint || !token) {
    return { ok: false, detail: "WATI_API_ENDPOINT and WATI_ACCESS_TOKEN must be set." };
  }
  try {
    const response = await fetch(`${endpoint}/api/ext/v3/contacts?page_number=1&page_size=1`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) return { ok: true, detail: `Connected (HTTP ${response.status}).` };
    const hint =
      response.status === 401
        ? " Check the token, and that the endpoint matches your workspace's region."
        : response.status === 403
          ? " The token is valid but lacks permission to read contacts."
          : "";
    return { ok: false, detail: `Wati returned HTTP ${response.status}.${hint}` };
  } catch (error) {
    return { ok: false, detail: `Request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The dashboard shows the endpoint with a tenant ID; V3 calls use only the origin. */
function apiOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return undefined;
  }
}
