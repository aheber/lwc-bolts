// Reads the Lightning Component Reference (developer.salesforce.com/docs/platform/lightning-component-reference)
// and compares it with our definitions. Pure functions, so they can be tested without fetching anything
// (see ../compare-docs.ts).
//
// Each component has two parts:
// - Its Markdown page (guide/<tag>.md): a description, and a "Custom Events" section listing each event
//   with a description, a parameter table and its bubbles/cancelable/composed properties.
// - Its specification (/cx-router/components?model=lwc&namespace=lightning&component=<name>), which
//   the page's "Specifications" tab shows: attributes, methods (with arguments) and slots.
import type { LightningComponent } from "../../src/types.ts";

/** An event a component's page documents. */
export interface DocumentedEvent {
  description?: string;
  parameters: { name: string; type: string; description?: string }[];
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

/** A component's page, as parsePage reads it. */
export interface Page {
  description?: string;
  events: Record<string, DocumentedEvent>;
}

/** A component's specification, as parseSpecification reads it. */
export interface Specification {
  attributes: Record<string, { type?: string; description?: string; required?: true }>;
  methods: Record<string, { description?: string; arguments: { name: string; type?: string; required: boolean }[] }>;
  slots: Record<string, { description?: string }>;
}

/** The specification endpoint's response, as far as it's read. */
export interface SpecificationResponse {
  response?: {
    name?: string;
    attributes?: { name?: string; type?: string; description?: string; required?: boolean }[];
    methods?: { name?: string; description?: string; arguments?: { name: string; type?: string; required?: boolean }[] }[];
    slots?: { name?: string; description?: string }[];
  };
}

/** What the reference documents about a component. */
export interface Documented {
  page?: Page;
  specification?: Specification;
}

/** Details of a difference, such as `{ reference: "string", ours: "boolean" }`. */
export type Difference = Record<string, string | string[]>;

/** A component's comparison: its status, or the lists and differences found, by kind. */
export type ComponentComparison = Record<string, string | string[] | Record<string, Difference>>;

export const REFERENCE_SITE = "https://developer.salesforce.com";
export const INDEX_PATH = "/docs/platform/lightning-component-reference/guide/components.md";

/** The tags of the components the index links to, such as `lightning-combobox`. */
export function indexTags(markdown: string): string[] {
  const tags = [...markdown.matchAll(/\/guide\/(lightning-[a-z0-9-]+)\.md/g)].map((m) => m[1]!);
  return [...new Set(tags)].sort();
}

export const pagePath = (tag: string): string => `/docs/platform/lightning-component-reference/guide/${tag}.md`;
export const specificationPath = (tag: string): string =>
  `/cx-router/components?${new URLSearchParams({
    model: "lwc",
    namespace: "lightning",
    component: tag.slice("lightning-".length).replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase()),
  })}`;

/** Collapses a paragraph's line breaks, as it's shown on hover. */
function prose(text: string | undefined): string | undefined {
  const cleaned = text?.replace(/\s*\n\s*/g, " ").trim();
  return cleaned ? cleaned : undefined;
}

/** A Markdown table's rows, as arrays of cells. A cell can hold an escaped `\|`, as in `string \| number`. */
function tableRows(table: string): string[][] {
  return table
    .trim()
    .split("\n")
    .slice(2)
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/(?<!\\)\|$/, "")
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|")),
    );
}

/**
 * A component's page: its description (the paragraph after its tag), and its custom events, each with
 * its description, parameters (`name`, `type` and `description`, as the table gives them) and the
 * bubbles, cancelable and composed properties.
 */
export function parsePage(markdown: string): Page {
  // the first paragraph after the tag line
  const afterTag = /^\*\*`lightning-[a-z0-9-]+`\*\*[ \t]*$/m.exec(markdown);
  const description = afterTag
    ? prose(
        markdown
          .slice(afterTag.index + afterTag[0].length)
          .split(/\n[ \t]*\n/)
          .map((p) => p.trim())
          .find(Boolean),
      )
    : undefined;
  const events: Record<string, DocumentedEvent> = {};
  const section = markdown.split(/^## Custom Events\s*$/m)[1]?.split(/^:::/m)[0] ?? "";
  const headings = [...section.matchAll(/^\*\*`([a-z][a-z0-9_]*)`\*\*\s*$/gm)];
  headings.forEach((heading, i) => {
    const body = section.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? section.length);
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    const parameters: DocumentedEvent["parameters"] = [];
    const properties: Record<string, boolean> = {};
    for (const table of body.matchAll(/^\|.*\|\s*\n\|[-| :]+\|\s*\n(?:\|.*\|\s*\n?)+/gm)) {
      const header = table[0].split("\n")[0]!.toLowerCase();
      for (const [first = "", second = "", third] of tableRows(table[0])) {
        if (header.includes("parameter")) {
          parameters.push({ name: first, type: second, ...(third && { description: third }) });
        } else if (header.includes("property") && ["bubbles", "cancelable", "composed"].includes(first)) {
          properties[first] = second === "true";
        }
      }
    }
    events[heading[1]!] = {
      ...(paragraphs[0] && !paragraphs[0].startsWith("|") && { description: prose(paragraphs[0]) }),
      parameters,
      ...properties,
    };
  });
  return { ...(description && { description }), events };
}

/**
 * A component's specification: attributes (by property name, with the type and description given),
 * methods (with arguments) and slots. Undefined when the response has no specification.
 */
export function parseSpecification(json: SpecificationResponse | undefined): Specification | undefined {
  const response = json?.response;
  if (!response || (!response.attributes && !response.methods && !response.slots)) {
    return undefined;
  }
  const byName = <T extends { name?: string }, U>(list: T[] | undefined, map: (item: T) => U): Record<string, U> =>
    Object.fromEntries((list ?? []).flatMap((item) => (item?.name ? [[item.name, map(item)] as const] : [])));
  return {
    attributes: byName(response.attributes, (a) => ({
      ...(a.type && { type: a.type }),
      ...(prose(a.description) && { description: prose(a.description) }),
      ...(a.required && { required: true }),
    })),
    methods: byName(response.methods, (m) => ({
      ...(prose(m.description) && { description: prose(m.description) }),
      arguments: (m.arguments ?? []).map((a) => ({ name: a.name, ...(a.type && { type: a.type }), required: a.required !== false })),
    })),
    slots: byName(response.slots, (s) => ({ ...(prose(s.description) && { description: prose(s.description) }) })),
  };
}

/**
 * What kind of value a type allows: `string`, `number`, `boolean`, `array`, `object`, or `any` when it
 * can't be told. A named type the reference doesn't define (such as `DayType`, often a union of strings)
 * is `any`, so it isn't reported as a difference.
 */
export function typeKinds(type: string): Set<string> {
  const kinds = new Set<string>();
  for (const part of splitTopLevel(type, "|").map((p) => p.trim().toLowerCase())) {
    if (part === "" || part === "*" || part === "any" || part === "unknown") return new Set(["any"]);
    if (part.endsWith("[]") || /^(readonly )?(array|list)\b/.test(part) || part.startsWith("readonly ")) kinds.add("array");
    else if (/^(string|"|')/.test(part)) kinds.add("string");
    else if (/^(number|integer|decimal|double|long)\b/.test(part)) kinds.add("number");
    else if (part === "boolean") kinds.add("boolean");
    else if (part === "null" || part === "undefined") continue;
    else if (/^(object|record\b|\{|function\b|\()/.test(part)) kinds.add("object");
    else return new Set(["any"]);
  }
  return kinds;
}

/** Splits a type at a separator outside brackets: `(a: Record<string, any>, b: number)`'s commas, say. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const char of text) {
    if ("{(<[".includes(char)) depth++;
    if ("})>]".includes(char)) depth--;
    if (depth === 0 && char === separator) {
      parts.push(part);
      part = "";
    } else part += char;
  }
  parts.push(part);
  return parts;
}

/**
 * Members every base component has through its host element, which the reference documents once for
 * all of them rather than per component: global attributes such as `title` and `aria-*`, and the
 * methods refs get from `HTMLElement` (`focus`, `blur`, `click`).
 */
export const HOST_PROPERTIES = new Set([
  "id",
  "title",
  "hidden",
  "tabIndex",
  "accessKey",
  "dir",
  "lang",
  "draggable",
  "spellcheck",
  "autofocus",
]);
export const HOST_METHODS = new Set(["focus", "blur", "click"]);
const isHostProperty = (name: string) => HOST_PROPERTIES.has(name) || /^aria[A-Z]/.test(name);

/** The property names of an event's detail type, such as `{ value: string; checked?: boolean }`. */
export function detailFields(eventType: string): string[] | undefined {
  const detail = /^CustomEvent<([\s\S]*)>$/.exec(eventType)?.[1]?.trim();
  if (!detail?.startsWith("{")) return undefined;
  // top-level keys only
  return splitTopLevel(detail.slice(1, -1).replace(/,/g, ";"), ";")
    .map((field) => /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(field)?.[1])
    .filter((name) => name !== undefined);
}

/**
 * Compares the reference with our definitions. For each component, lists what one has that the other
 * doesn't, and where they disagree:
 *
 * - attributes and methods the reference documents that our definitions lack, and the reverse, leaving
 *   out the host element's members (see HOST_PROPERTIES and HOST_METHODS);
 * - attribute types whose kinds don't overlap (ours are lenient, so `string | number` covers `string`);
 * - methods whose documented argument count differs from our type's;
 * - events either documents that the other lacks, and documented parameters our detail type lacks;
 * - the reference's slots, which our definitions don't model.
 *
 * `reference` maps tags to `{ page, specification }`; `ours` is LIGHTNING_COMPONENTS.
 */
export function compareReference(
  reference: Record<string, Documented>,
  ours: Readonly<Record<string, LightningComponent>>,
): Record<string, ComponentComparison> {
  const components: Record<string, ComponentComparison> = {};
  const tags = new Set([...Object.keys(reference), ...Object.keys(ours)]);
  for (const tag of [...tags].sort()) {
    const documented = reference[tag];
    const defined = ours[tag];
    if (!documented) {
      components[tag] = { status: "only in our definitions" };
      continue;
    }
    if (!defined) {
      components[tag] = { status: "only in the reference", ...summary(documented) };
      continue;
    }
    const spec = documented.specification;
    const result: ComponentComparison = {};
    const add = (key: string, value: string[] | Record<string, Difference>) => {
      if (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0) result[key] = value;
    };
    if (spec) {
      add(
        "missingAttributes",
        Object.keys(spec.attributes).filter((name) => !defined.properties[name]),
      );
      add(
        "undocumentedProperties",
        Object.keys(defined.properties).filter((name) => !spec.attributes[name] && !isHostProperty(name)),
      );
      add(
        "typeDifferences",
        Object.fromEntries(
          Object.entries(spec.attributes)
            .filter(([name, attribute]) => {
              const ourType = defined.properties[name]?.type;
              if (!attribute.type || !ourType) return false;
              const theirs = typeKinds(attribute.type);
              const mine = typeKinds(ourType);
              return !mine.has("any") && !theirs.has("any") && ![...theirs].some((kind) => mine.has(kind));
            })
            .map(([name, attribute]) => [name, { reference: attribute.type!, ours: defined.properties[name]!.type }]),
        ),
      );
      add(
        "missingMethods",
        Object.keys(spec.methods).filter((name) => !defined.methods[name] && !HOST_METHODS.has(name)),
      );
      add(
        "undocumentedMethods",
        Object.keys(defined.methods).filter((name) => !spec.methods[name]),
      );
      add(
        "argumentDifferences",
        Object.fromEntries(
          Object.entries(spec.methods)
            .filter(([name, method]) => {
              const type = defined.methods[name]?.type;
              if (!type || /\(\.\.\.args/.test(type)) return false;
              const parameters = /^\((.*)\)\s*=>/.exec(type)?.[1] ?? "";
              const ours = splitTopLevel(parameters, ",").filter((a) => a.trim()).length;
              return ours !== method.arguments.length;
            })
            .map(([name, method]) => [
              name,
              {
                reference: `(${method.arguments.map((a) => `${a.name}${a.required ? "" : "?"}: ${a.type ?? "?"}`).join(", ")})`,
                ours: defined.methods[name]!.type,
              },
            ]),
        ),
      );
      add("slots", Object.keys(spec.slots));
    } else {
      result.specification = "none published";
    }
    const events = documented.page?.events ?? {};
    add(
      "missingEvents",
      Object.keys(events).filter((name) => !defined.events[name]),
    );
    add(
      "undocumentedEvents",
      Object.keys(defined.events).filter((name) => !events[name]),
    );
    add(
      "detailDifferences",
      Object.fromEntries(
        Object.entries(events)
          .map(([name, event]): [string, string[]] => {
            const fields = defined.events[name] && detailFields(defined.events[name].type);
            if (!fields) return [name, []];
            const documentedFields = event.parameters.map((p) => p.name.split(".")[0]!);
            return [name, documentedFields.filter((field) => !fields.includes(field))];
          })
          .filter(([, missing]) => missing.length > 0)
          .map(([name, missing]) => [name, { documentedParameters: missing, ours: defined.events[name]!.type }]),
      ),
    );
    components[tag] = Object.keys(result).length > 0 ? result : { status: "matches" };
  }
  return components;
}

function summary(documented: Documented): ComponentComparison {
  const spec = documented.specification;
  return {
    attributes: Object.keys(spec?.attributes ?? {}),
    methods: Object.keys(spec?.methods ?? {}),
    events: Object.keys(documented.page?.events ?? {}),
    slots: Object.keys(spec?.slots ?? {}),
  };
}

/** The comparison as a readable report. */
export function formatComparison(comparison: Record<string, ComponentComparison>): string {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const [tag, result] of Object.entries(comparison)) {
    if (result.status === "matches") {
      counts.matches = (counts.matches ?? 0) + 1;
      continue;
    }
    lines.push(`${tag}${result.status ? ` (${result.status})` : ""}`);
    for (const [key, value] of Object.entries(result)) {
      if (key === "status") continue;
      counts[key] = (counts[key] ?? 0) + (Array.isArray(value) ? value.length : typeof value === "object" ? Object.keys(value).length : 1);
      if (Array.isArray(value)) {
        if (value.length > 0) lines.push(`  ${key}: ${value.join(", ")}`);
      } else if (typeof value === "object") {
        lines.push(`  ${key}:`);
        for (const [name, detail] of Object.entries(value)) {
          lines.push(
            `    ${name}: ${Object.entries(detail)
              .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : v}`)
              .join("; ")}`,
          );
        }
      } else {
        lines.push(`  ${key}: ${value}`);
      }
    }
  }
  const totals = Object.entries(counts)
    .map(([key, count]) => `${count} ${key}`)
    .join(", ");
  return `${lines.join("\n")}${lines.length > 0 ? "\n\n" : ""}${totals || "nothing to compare"}\n`;
}
