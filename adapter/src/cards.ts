import { ValidationError, cardToFallbackText } from "@chat-adapter/shared";
import type {
  ButtonElement,
  CardChild,
  CardElement,
  LinkButtonElement,
  RadioSelectElement,
  SelectElement,
} from "chat";
import type { InteractiveButtonsPayload, InteractiveListPayload } from "./client";

/** WhatsApp interactive message limits, as documented by Wati. */
export const LIMITS = {
  body: 1024,
  footer: 60,
  header: 60,
  buttonText: 20,
  buttons: 3,
  listButtonText: 20,
  listRows: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
} as const;

/** What a reply button or list row stands for. Stored in Chat state, keyed by its label. */
export interface WatiActionMapping {
  actionId: string;
  value?: string;
}

export type WatiCardPlan =
  | {
      kind: "buttons";
      payload: InteractiveButtonsPayload;
      actions: Map<string, WatiActionMapping>;
    }
  | {
      kind: "list";
      payload: InteractiveListPayload;
      actions: Map<string, WatiActionMapping>;
    }
  | { kind: "text"; text: string };

type Select = SelectElement | RadioSelectElement;

interface CollectedActions {
  buttons: ButtonElement[];
  links: LinkButtonElement[];
  selects: Select[];
}

/**
 * Decide how to send a card through Wati:
 *
 * - 1–3 reply buttons → interactive buttons message
 * - 4–10 reply buttons, or a select menu → interactive list message
 * - anything else → formatted text, with link buttons written out as URLs
 *
 * `renderText` turns standard Markdown into WhatsApp text.
 */
export function planCard(
  card: CardElement,
  renderText: (markdown: string) => string,
): WatiCardPlan {
  const collected = collectActions(card.children);
  const buttons = collected.buttons.filter((button) => !button.disabled);
  const linkLines = collected.links.map((link) => `${link.label}: ${link.url}`);

  const bodyMarkdown = cardToFallbackText(
    { ...card, title: undefined },
    { boldFormat: "**" },
  );
  const body = [renderText(bodyMarkdown), ...linkLines]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const title = card.title?.trim();

  if (collected.selects.length > 0) {
    return listPlan(card, body, title, selectRows(collected.selects));
  }

  if (buttons.length > LIMITS.buttons) {
    return listPlan(card, body, title, [
      {
        sectionTitle: "Options",
        rows: buttons.map((button) => ({
          title: button.label,
          mapping: { actionId: button.id, value: button.value },
        })),
      },
    ]);
  }

  if (buttons.length > 0) {
    const actions = new Map<string, WatiActionMapping>();
    const payloadButtons = buttons.map((button) => {
      const label = fitLabel(button.label, LIMITS.buttonText, "Button label");
      addMapping(actions, label, { actionId: button.id, value: button.value });
      return { text: label };
    });

    const payload: InteractiveButtonsPayload = {
      body: fitBody(body || title || "Choose an option"),
      buttons: payloadButtons,
    };
    if (card.imageUrl) {
      payload.header = {
        type: "Image",
        media: { url: card.imageUrl, file_name: fileNameFromUrl(card.imageUrl) },
      };
      if (title) payload.body = fitBody(`*${title}*\n\n${body}`.trim());
    } else if (title && body) {
      payload.header = { type: "Text", text: truncate(title, LIMITS.header) };
    }
    if (card.subtitle && !body.includes(card.subtitle)) {
      payload.footer = truncate(card.subtitle, LIMITS.footer);
    }
    return { kind: "buttons", payload, actions };
  }

  const text = [title ? `*${title}*` : "", body]
    .filter(Boolean)
    .join("\n\n");
  return { kind: "text", text };
}

interface PlannedSection {
  sectionTitle: string;
  rows: { title: string; description?: string; mapping: WatiActionMapping }[];
}

function listPlan(
  card: CardElement,
  body: string,
  title: string | undefined,
  sections: PlannedSection[],
): WatiCardPlan {
  const rowCount = sections.reduce((sum, s) => sum + s.rows.length, 0);
  if (rowCount === 0) {
    throw new ValidationError("wati", "A select menu needs at least one option.");
  }
  if (rowCount > LIMITS.listRows) {
    throw new ValidationError(
      "wati",
      `WhatsApp list messages support at most ${LIMITS.listRows} options; this card has ${rowCount}.`,
    );
  }

  const actions = new Map<string, WatiActionMapping>();
  const payload: InteractiveListPayload = {
    body: fitBody(body || title || "Choose an option"),
    button_text: fitLabel(
      sections.length === 1 && sections[0]?.sectionTitle !== "Options"
        ? sections[0]!.sectionTitle
        : "Options",
      LIMITS.listButtonText,
      "List button text",
      true,
    ),
    sections: sections.map((section) => ({
      title: truncate(section.sectionTitle, LIMITS.sectionTitle),
      rows: section.rows.map((row) => {
        const rowTitle = fitLabel(row.title, LIMITS.rowTitle, "List option label");
        addMapping(actions, rowTitle, row.mapping);
        return row.description
          ? { title: rowTitle, description: truncate(row.description, LIMITS.rowDescription) }
          : { title: rowTitle };
      }),
    })),
  };
  if (title && body) payload.header = truncate(title, LIMITS.header);
  if (card.subtitle && !body.includes(card.subtitle)) {
    payload.footer = truncate(card.subtitle, LIMITS.footer);
  }
  return { kind: "list", payload, actions };
}

function selectRows(selects: Select[]): PlannedSection[] {
  return selects.map((select) => ({
    sectionTitle: select.label || "Options",
    rows: select.options.map((option) => ({
      title: option.label,
      description: option.description,
      mapping: { actionId: select.id, value: option.value },
    })),
  }));
}

function collectActions(children: CardChild[]): CollectedActions {
  const out: CollectedActions = { buttons: [], links: [], selects: [] };
  const visit = (nodes: CardChild[]) => {
    for (const child of nodes) {
      if (child.type === "actions") {
        for (const action of child.children) {
          if (action.type === "button") out.buttons.push(action);
          else if (action.type === "link-button") out.links.push(action);
          else if (action.type === "select" || action.type === "radio_select") {
            out.selects.push(action);
          }
        }
      } else if (child.type === "section") {
        visit(child.children);
      }
    }
  };
  visit(children);
  return out;
}

/** Normalize a label for lookups: trim, collapse spaces, lowercase. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function addMapping(
  actions: Map<string, WatiActionMapping>,
  label: string,
  mapping: WatiActionMapping,
): void {
  const key = normalizeLabel(label);
  if (actions.has(key)) {
    throw new ValidationError(
      "wati",
      `Two options in one WhatsApp message share the label "${label}". WhatsApp replies only carry the label, so labels must be unique.`,
    );
  }
  actions.set(key, mapping);
}

function fitLabel(
  label: string,
  max: number,
  what: string,
  allowTruncate = false,
): string {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new ValidationError("wati", `${what} cannot be empty.`);
  }
  if ([...trimmed].length <= max) return trimmed;
  if (allowTruncate) return truncate(trimmed, max);
  throw new ValidationError(
    "wati",
    `${what} "${trimmed}" is longer than WhatsApp's ${max}-character limit. Shorten it so button replies can be matched.`,
  );
}

function fitBody(body: string): string {
  return truncate(body, LIMITS.body);
}

/** Truncate to `max` characters (code points), ending with "…" when cut. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.split("/").pop();
    return name || undefined;
  } catch {
    return undefined;
  }
}
