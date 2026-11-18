import { WatiAdapter } from "./adapter";
import type { WatiAdapterConfig } from "./types";

/**
 * Create a Wati WhatsApp adapter for Chat SDK.
 *
 * Reads `WATI_API_ENDPOINT`, `WATI_ACCESS_TOKEN`, `WATI_WEBHOOK_SECRET`,
 * `WATI_CHANNEL_PHONE_NUMBER` and `WATI_BOT_USERNAME` for any value not
 * passed in `config`.
 */
export function createWatiAdapter(config: WatiAdapterConfig = {}): WatiAdapter {
  return new WatiAdapter(config);
}
