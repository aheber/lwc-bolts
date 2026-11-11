// ApexDoc comments (`/** ... */`) on Apex classes, fields and methods, as JSDoc for their declarations.
import type { Node } from "web-tree-sitter-sfapex";

export interface ApexDoc {
  /** JSDoc lines: the description, then tags */
  lines: string[];
  /** `@param` descriptions keyed by lower-cased parameter name */
  params: Map<string, string>;
}

/**
 * Reads the ApexDoc comment of a class, field or method: the `/** ... *\/` comment right before it, or
 * one placed between its annotations and the rest of its declaration.
 *
 * @param isSobject also accept `/* ... *\/` comments, which the generated SObject definitions use for
 *   field descriptions
 */
export function getApexDoc(node: Node, isSobject: boolean = false): ApexDoc | undefined {
  const isDoc = (n: Node | null | undefined): n is Node =>
    n?.type === "block_comment" && n.text.startsWith(isSobject ? "/*" : "/**") && !/^\/\*\*?\/$/.test(n.text);
  const previous = node.previousNamedSibling;
  if (isDoc(previous)) {
    return parseApexDoc(previous.text);
  }
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
  const inner = modifiers?.namedChildren.find(isDoc);
  return inner ? parseApexDoc(inner.text) : undefined;
}

/**
 * Converts an ApexDoc comment to JSDoc lines. `@description` text joins the description, `@return`
 * becomes `@returns`, and other tags (`@param`, `@example`, `@see`, ...) are kept as written.
 */
function parseApexDoc(comment: string): ApexDoc {
  const raw = comment
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split(/\r\n|\r|\n/)
    // keep indentation after the `* ` gutter, which matters in `@example` code
    .map((line) => (/^\s*\*/.test(line) ? line.replace(/^\s*\* ?/, "") : line.trimStart()).trimEnd());
  const description: string[] = [];
  const tags: string[][] = [];
  for (const line of raw) {
    const tag = /^\s*@(\w+)\s*(.*)$/.exec(line);
    if (tag) {
      const name = tag[1] ?? "";
      const rest = tag[2] ?? "";
      if (name.toLowerCase() === "description") {
        description.push(rest);
        tags.push(description); // continuation lines join the description
      } else {
        tags.push([`@${name.toLowerCase() === "return" ? "returns" : name} ${rest}`.trimEnd()]);
      }
    } else if (tags.length > 0) {
      tags.at(-1)!.push(line);
    } else {
      description.push(line);
    }
  }
  const params: Map<string, string> = new Map();
  for (const tag of tags) {
    const param = /^@param\s+(\w+)\s*([\s\S]*)$/.exec(tag.join("\n"));
    if (param?.[1] && param[2]) {
      params.set(param[1].toLowerCase(), param[2].trim());
    }
  }
  const trim = (lines: string[]) => {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start]?.trim() === "") start++;
    while (end > start && lines[end - 1]?.trim() === "") end--;
    return lines.slice(start, end);
  };
  const tagLines = tags.filter((tag) => tag !== description).map(trim);
  const descriptionLines = trim(description);
  return {
    lines: [...descriptionLines, ...(descriptionLines.length > 0 && tagLines.length > 0 ? [""] : []), ...tagLines.flat()],
    params,
  };
}

/**
 * Flattens documentation onto one line for an inline `/** ... *\/` comment.
 */
export function inlineDoc(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\*\//g, "*\\/");
}
