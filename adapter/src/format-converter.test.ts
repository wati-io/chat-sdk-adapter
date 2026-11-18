import { Actions, Button, Card, CardText, Section } from "chat";
import { describe, expect, it } from "vitest";
import { LIMITS, planCard, truncate } from "./cards";
import { WatiFormatConverter, whatsAppToMarkdown } from "./format-converter";

const converter = new WatiFormatConverter();
const render = (markdown: string) => converter.fromMarkdown(markdown);

describe("WatiFormatConverter.fromAst", () => {
  it.each([
    ["**bold**", "*bold*"],
    ["_italic_", "_italic_"],
    ["~~gone~~", "~gone~"],
    ["`code`", "`code`"],
    ["```js\nconst a = 1;\n```", "```\nconst a = 1;\n```"],
    ["# Title", "*Title*"],
    ["> quoted\n> lines", "> quoted\n> lines"],
    ["[Wati](https://wati.io)", "Wati (https://wati.io)"],
    ["https://wati.io", "https://wati.io"],
    ["![logo](https://x.io/l.png)", "logo (https://x.io/l.png)"],
    ["- one\n- two", "- one\n- two"],
    ["1. one\n2. two", "1. one\n2. two"],
    ["a\n\n---\n\nb", "a\n\n---\n\nb"],
  ])("renders %j as %j", (markdown, expected) => {
    expect(render(markdown)).toBe(expected);
  });

  it("renders tables as monospace blocks", () => {
    const out = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("1");
  });
});

describe("WatiFormatConverter.toAst", () => {
  it("reads WhatsApp single-marker bold and strike", () => {
    expect(whatsAppToMarkdown("*bold* and ~old~")).toBe("**bold** and ~~old~~");
    expect(whatsAppToMarkdown("2 * 3 * 4")).toBe("2 * 3 * 4");
    const ast = converter.toAst("hi *there*");
    const paragraph = ast.children[0] as { children: { type: string }[] };
    expect(paragraph.children.map((c) => c.type)).toContain("strong");
  });

  it("round-trips WhatsApp text", () => {
    const text = "*Order* _shipped_ ~late~";
    expect(converter.fromAst(converter.toAst(text))).toBe(text);
  });
});

describe("planCard", () => {
  it("falls back to text when a card has no actions", () => {
    const plan = planCard(Card({ title: "Hi", children: [CardText("Body")] }), render);
    expect(plan).toEqual({ kind: "text", text: "*Hi*\n\nBody" });
  });

  it("uses an image header and keeps the title in the body", () => {
    const plan = planCard(
      Card({
        title: "Deal",
        subtitle: "Ends soon",
        imageUrl: "https://cdn.example.com/deal.jpg",
        children: [CardText("50% off"), Actions([Button({ id: "buy", label: "Buy" })])],
      }),
      render,
    );
    expect(plan.kind).toBe("buttons");
    if (plan.kind !== "buttons") return;
    expect(plan.payload.header).toEqual({
      type: "Image",
      media: { url: "https://cdn.example.com/deal.jpg", file_name: "deal.jpg" },
    });
    expect(plan.payload.body).toContain("*Deal*");
    expect(plan.payload.body).toContain("50% off");
  });

  it("finds buttons inside sections and skips disabled ones", () => {
    const plan = planCard(
      Card({
        children: [
          Section([
            CardText("Pick"),
            Actions([
              Button({ id: "a", label: "A" }),
              Button({ id: "b", label: "B", disabled: true }),
            ]),
          ]),
        ],
      }),
      render,
    );
    expect(plan.kind === "buttons" && plan.payload.buttons).toEqual([{ text: "A" }]);
  });

  it("turns more than three buttons into a list", () => {
    const buttons = ["One", "Two", "Three", "Four"].map((label) =>
      Button({ id: label.toLowerCase(), label }),
    );
    const plan = planCard(Card({ children: [CardText("Choose"), Actions(buttons)] }), render);
    expect(plan.kind).toBe("list");
    if (plan.kind !== "list") return;
    expect(plan.payload.button_text).toBe("Options");
    expect(plan.payload.sections[0]!.rows).toHaveLength(4);
    expect(plan.actions.get("four")).toEqual({ actionId: "four", value: undefined });
  });

  it("rejects more than ten options", () => {
    const buttons = Array.from({ length: 11 }, (_, i) => Button({ id: `b${i}`, label: `B${i}` }));
    expect(() => planCard(Card({ children: [Actions(buttons)] }), render)).toThrow(/at most 10/);
  });

  it("rejects duplicate and over-long labels", () => {
    expect(() =>
      planCard(
        Card({ children: [Actions([Button({ id: "a", label: "Yes" }), Button({ id: "b", label: "yes " })])] }),
        render,
      ),
    ).toThrow(/share the label/);
    expect(() =>
      planCard(
        Card({ children: [Actions([Button({ id: "a", label: "x".repeat(LIMITS.buttonText + 1) })])] }),
        render,
      ),
    ).toThrow(/20-character/);
  });

  it("truncates by code point", () => {
    expect(truncate("😀😀😀", 2)).toBe("😀…");
    expect(truncate("short", 10)).toBe("short");
  });
});
