export { WatiAdapter, splitText, targetFor } from "./adapter";
export { createWatiAdapter } from "./factory";
export { WatiFormatConverter, whatsAppToMarkdown } from "./format-converter";
export { LIMITS as WATI_INTERACTIVE_LIMITS, planCard } from "./cards";
export type { WatiActionMapping, WatiCardPlan } from "./cards";
export type {
  WatiAdapterConfig,
  WatiApiMessage,
  WatiCredential,
  WatiInteractiveReply,
  WatiRawMessage,
  WatiRawMessageResult,
  WatiSendTemplateOptions,
  WatiSendTemplateResult,
  WatiTemplateParameter,
  WatiThreadId,
  WatiWebhookMessage,
} from "./types";
