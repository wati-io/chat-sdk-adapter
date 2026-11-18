import type { WatiInteractiveReply, WatiWebhookMessage } from "./types";

/** Webhook event types that carry an incoming customer message. */
export const INCOMING_MESSAGE_EVENTS = new Set([
  "message",
  "newContactMessageReceived",
]);

/** Message types that carry a downloadable media file. */
export const MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "sticker",
]);

/**
 * Turn a parsed webhook body into message payloads. Wati posts one event per
 * request; arrays are accepted too in case several events are batched.
 */
export function webhookEvents(body: unknown): WatiWebhookMessage[] {
  const items = Array.isArray(body) ? body : [body];
  return items.filter(isWatiEvent);
}

function isWatiEvent(value: unknown): value is WatiWebhookMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** True when the event is a message a customer sent to the business. */
export function isIncomingMessage(event: WatiWebhookMessage): boolean {
  const eventType = event.eventType ?? "message";
  return INCOMING_MESSAGE_EVENTS.has(eventType) && event.owner !== true;
}

/** The interactive reply carried by a message, if any. */
export function interactiveReply(
  event: WatiWebhookMessage,
): { label: string; id?: string; reply: WatiInteractiveReply | null } | null {
  const reply =
    event.interactiveButtonReply ?? event.listReply ?? event.buttonReply ?? null;
  const isInteractiveType = event.type === "interactive" || event.type === "button";
  if (!reply && !isInteractiveType) return null;

  const label =
    firstString(reply?.title, reply?.text, reply?.payload) ??
    firstString(event.text);
  if (!label) return null;
  const id = firstString(reply?.id, reply?.payload) ?? undefined;
  return { label, id, reply };
}

/** For `reaction` messages: the emoji and the WhatsApp ID of the message reacted to. */
export function reactionDetails(
  event: WatiWebhookMessage,
): { emoji: string; targetMessageId: string } | null {
  if (event.type !== "reaction") return null;
  const data = asRecord(event.data);
  const emoji =
    firstString(data?.emoji, event.text) ?? "";
  const targetMessageId = firstString(
    data?.message_id,
    data?.messageId,
    event.replyContextId,
  );
  if (!targetMessageId) return null;
  return { emoji, targetMessageId };
}

/** Parse Wati's Unix-seconds string, ISO string, or millisecond timestamps. */
export function parseTimestamp(
  timestamp: string | number | null | undefined,
  fallback?: string | null,
): Date {
  const fromValue = (value: string | number): Date | null => {
    if (typeof value === "number" || /^\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      const ms = n < 1e12 ? n * 1000 : n;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  if (timestamp !== null && timestamp !== undefined && timestamp !== "") {
    const date = fromValue(timestamp);
    if (date) return date;
  }
  if (fallback) {
    const date = fromValue(fallback);
    if (date) return date;
  }
  return new Date();
}

/** Digits-only form of a phone number; leaves BSUIDs and other IDs untouched. */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (/^\+?[\d\s\-().]+$/.test(trimmed)) return trimmed.replace(/\D/g, "");
  return trimmed;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
