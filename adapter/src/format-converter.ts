import {
  BaseFormatConverter,
  type Content,
  type Root,
  isTableNode,
  parseMarkdown,
  tableToAscii,
} from "chat";

/**
 * Converts between Chat SDK's Markdown AST and WhatsApp text formatting.
 *
 * WhatsApp formatting: *bold*, _italic_, ~strike~, `code`, ```block```,
 * > quote, and "- " / "1. " lists. Links have no markup, so they render as
 * "label (url)". Tables render as monospace ASCII.
 */
export class WatiFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return parseMarkdown(whatsAppToMarkdown(platformText));
  }

  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.nodeToWhatsApp(node),
    ).trim();
  }

  private nodeToWhatsApp(node: Content): string {
    const value = node as unknown as Record<string, unknown>;
    const children = Array.isArray(value.children)
      ? (value.children as Content[])
      : [];
    const renderChildren = () =>
      children.map((child) => this.nodeToWhatsApp(child)).join("");

    if (isTableNode(node)) {
      return `\`\`\`\n${tableToAscii(node)}\n\`\`\``;
    }

    switch (node.type) {
      case "text":
        return String(value.value ?? "");
      case "paragraph":
        return renderChildren();
      case "heading":
      case "strong":
        return wrap("*", renderChildren());
      case "emphasis":
        return wrap("_", renderChildren());
      case "delete":
        return wrap("~", renderChildren());
      case "inlineCode":
        return `\`${String(value.value ?? "")}\``;
      case "code":
        return `\`\`\`\n${String(value.value ?? "")}\n\`\`\``;
      case "blockquote":
        return children
          .map((child) => this.nodeToWhatsApp(child))
          .join("\n")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      case "break":
        return "\n";
      case "link": {
        const label = renderChildren();
        const url = String(value.url ?? "");
        return label && label !== url ? `${label} (${url})` : url;
      }
      case "image": {
        const url = String(value.url ?? "");
        const alt = String(value.alt ?? "");
        return alt ? `${alt} (${url})` : url;
      }
      case "list":
        return this.renderList(node as never, 0, (child) =>
          this.nodeToWhatsApp(child),
        );
      case "thematicBreak":
        return "---";
      default:
        return this.defaultNodeToText(node, (child) =>
          this.nodeToWhatsApp(child),
        );
    }
  }
}

function wrap(marker: string, inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  const lead = inner.slice(0, inner.indexOf(trimmed));
  const tail = inner.slice(lead.length + trimmed.length);
  return `${lead}${marker}${trimmed}${marker}${tail}`;
}

/**
 * WhatsApp uses single `*` for bold and single `~` for strikethrough.
 * Convert those to standard Markdown before parsing so they become `strong`
 * and `delete` nodes instead of emphasis.
 */
export function whatsAppToMarkdown(input: string): string {
  return input
    .replace(/(^|[\s(\[{"'])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s)\]}.,!?:;"'])/g, "$1**$2**")
    .replace(/(^|[\s(\[{"'])~(?=\S)([^~\n]*?\S)~(?=$|[\s)\]}.,!?:;"'])/g, "$1~~$2~~");
}
