// Declarative rules for a JSON(C) config: a policy names what the config must not have (`block`) and what
// it must have (`enforce`). checkConfig says where a config doesn't conform, and conformConfig applies just
// those changes, editing the text in place so the rest of it, comments and formatting included, is kept.
//
// The `lwc` folders' configs are kept in shape with these (see projectConfigPolicy and lwcFolderPolicy in
// index.ts): the settings known to break the content mapper are blocked, and the ones it needs enforced,
// with the project's own values, such as its package directories, merged into the enforced ones.
import { isDeepStrictEqual } from "node:util";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type FormattingOptions, type Node, type ParseError } from "jsonc-parser";

/** Selects the element of an array whose property `where` equals `equals`, such as a `contentMappers` entry by its `package`. */
export interface ArrayMatch {
  readonly where: string;
  readonly equals: unknown;
}

/** A path into a config: property names, and ArrayMatch for an array's element. */
export type RulePath = readonly (string | ArrayMatch)[];

/** Something a config must not have. */
export interface BlockRule {
  readonly path: RulePath;
  /**
   * With this, the property is an array, and only the entries it matches are removed; without it, the
   * property itself is removed.
   */
  readonly entries?: (entry: unknown) => boolean;
}

/** A property that must have exactly this value. */
export interface EnforceValue {
  readonly path: RulePath;
  readonly value: unknown;
}

/** An array that must contain these entries. Its other entries are kept. */
export interface EnforceEntries {
  readonly path: RulePath;
  readonly contains: readonly unknown[];
  /** Whether an entry already in the array is a required one, deep equality by default; such as two spellings of one path. */
  readonly same?: (existing: unknown, required: unknown) => boolean;
  /**
   * The order entries belong in, `contains` by default. A missing entry goes after the nearest entry
   * before it in this order that the array has, or else before the nearest one after it, or else last.
   */
  readonly order?: readonly unknown[];
}

export type EnforceRule = EnforceValue | EnforceEntries;

/** What a config must not have, and what it must have. Blocks apply first. */
export interface ConfigPolicy {
  readonly block: readonly BlockRule[];
  readonly enforce: readonly EnforceRule[];
}

/** A config brought into line with a policy, and what changed, such as `removed compilerOptions.baseUrl`. */
export interface ConformResult {
  readonly text: string;
  readonly changes: readonly string[];
}

export const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

/** A config's object, or undefined when it isn't valid JSONC, or isn't an object. */
export function parseConfig(text: string): Record<string, unknown> | undefined {
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0 && config && typeof config === "object" && !Array.isArray(config) ? config : undefined;
}

/** The indentation a config uses, for the parts added to it (the Salesforce extensions indent with 4 spaces). */
export function indentation(text: string): Partial<FormattingOptions> {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  if (indent === undefined) {
    return {};
  }
  return indent.startsWith("\t") ? { insertSpaces: false } : { tabSize: indent.length };
}

/** What changing a config to conform to `policy` would change; empty when it conforms. Undefined when it isn't valid JSON. */
export function checkConfig(text: string, policy: ConfigPolicy): readonly string[] | undefined {
  return conformConfig(text, policy)?.changes;
}

/**
 * Brings a config into line with `policy`: removes what it blocks, then adds what it enforces that's
 * missing or different. Only those parts change. Undefined when the config isn't valid JSON, which is
 * left alone.
 */
export function conformConfig(text: string, policy: ConfigPolicy): ConformResult | undefined {
  if (parseConfig(text) === undefined) {
    return undefined;
  }
  const formattingOptions = { ...FORMATTING, ...indentation(text) };
  const changes: string[] = [];
  let current = text;
  const config = () => parseConfig(current)!;
  const set = (jsonPath: (string | number)[], value: unknown, isArrayInsertion = false) => {
    current = applyEdits(current, modify(current, jsonPath, value, { formattingOptions, isArrayInsertion }));
  };

  /** The concrete path to `rulePath`, creating the objects, arrays and matched elements on the way. */
  const materialize = (rulePath: RulePath): (string | number)[] => {
    // each pass creates at least one segment
    for (let attempts = 0; attempts <= rulePath.length; attempts++) {
      const found = walk(config(), rulePath);
      if (found.found) {
        return found.path;
      }
      const segment = rulePath[found.index]!;
      if (typeof segment === "object") {
        const element = { [segment.where]: segment.equals };
        if (Array.isArray(found.parent)) {
          set([...found.path, found.parent.length], element, true);
        } else {
          set(found.path, [element]);
        }
        continue;
      }
      if (!isObject(found.parent)) {
        set(found.path, {});
        continue;
      }
      // modify creates the objects on the way, up to the next array element
      const rest = rulePath.slice(found.index);
      const match = rest.findIndex((each) => typeof each === "object");
      if (match === -1) {
        return [...found.path, ...(rest as string[])];
      }
      set([...found.path, ...(rest.slice(0, match) as string[])], []);
    }
    throw new Error(`Unable to create ${describePath(rulePath)}`);
  };

  for (const rule of policy.block) {
    const found = walk(config(), rule.path);
    if (!found.found) {
      continue;
    }
    if (rule.entries === undefined) {
      set(found.path, undefined);
      changes.push(`removed ${describePath(rule.path)}`);
      continue;
    }
    if (!Array.isArray(found.value)) {
      continue;
    }
    const removed: string[] = [];
    for (let i = found.value.length - 1; i >= 0; i--) {
      if (rule.entries(found.value[i])) {
        current = removeArrayElement(current, found.path, i);
        removed.unshift(`removed ${JSON.stringify(found.value[i])} from ${describePath(rule.path)}`);
      }
    }
    changes.push(...removed);
  }

  for (const rule of policy.enforce) {
    const found = walk(config(), rule.path);
    if ("value" in rule) {
      if (!found.found || !isDeepStrictEqual(found.value, rule.value)) {
        set(materialize(rule.path), rule.value);
        changes.push(`set ${describePath(rule.path)} to ${JSON.stringify(rule.value)}`);
      }
      continue;
    }
    const same = rule.same ?? isDeepStrictEqual;
    const order = rule.order ?? rule.contains;
    const has = (entries: readonly unknown[], entry: unknown) => entries.some((each) => same(each, entry));
    const existing = found.found && Array.isArray(found.value) ? found.value : undefined;
    if (rule.contains.every((entry) => existing !== undefined && has(existing, entry))) {
      continue;
    }
    if (existing === undefined) {
      set(materialize(rule.path), []);
    }
    const arrayPath = materialize(rule.path);
    for (const entry of rule.contains) {
      const entries = walk(config(), rule.path).value as unknown[];
      if (has(entries, entry)) {
        continue;
      }
      set([...arrayPath, insertionIndex(entries, entry, order, same)], entry, true);
      changes.push(`added ${JSON.stringify(entry)} to ${describePath(rule.path)}`);
    }
  }
  return { text: current, changes };
}

/** Where a missing entry goes in `entries`, by `order` (see EnforceEntries.order). */
function insertionIndex(
  entries: readonly unknown[],
  entry: unknown,
  order: readonly unknown[],
  same: (existing: unknown, required: unknown) => boolean,
): number {
  const position = order.findIndex((each) => same(entry, each));
  if (position === -1) {
    return entries.length;
  }
  for (let i = position - 1; i >= 0; i--) {
    const index = entries.findLastIndex((each) => same(each, order[i]));
    if (index !== -1) {
      return index + 1;
    }
  }
  for (let i = position + 1; i < order.length; i++) {
    const index = entries.findIndex((each) => same(each, order[i]));
    if (index !== -1) {
      return index;
    }
  }
  return entries.length;
}

type Walk =
  | { readonly found: true; readonly path: (string | number)[]; readonly value: unknown }
  /** Not found: `path` is as far as it got, to `parent`, and `index` is the segment of the rule's path that's missing. */
  | {
      readonly found: false;
      readonly path: (string | number)[];
      readonly parent: unknown;
      readonly index: number;
      readonly value?: undefined;
    };

/** Follows a rule's path through a config, to the concrete path (with array indexes) and the value there. */
function walk(config: unknown, rulePath: RulePath): Walk {
  const concrete: (string | number)[] = [];
  let current = config;
  for (const [index, segment] of rulePath.entries()) {
    let next: string | number | undefined;
    if (typeof segment === "object") {
      const position = Array.isArray(current)
        ? current.findIndex((element) => isObject(element) && isDeepStrictEqual(element[segment.where], segment.equals))
        : -1;
      next = position === -1 ? undefined : position;
    } else {
      next = isObject(current) && Object.hasOwn(current, segment) ? segment : undefined;
    }
    if (next === undefined) {
      return { found: false, path: concrete, parent: current, index };
    }
    concrete.push(next);
    current = (current as Record<string | number, unknown>)[next];
  }
  return { found: true, path: concrete, value: current };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A rule's path for messages, such as `contentMappers[package="x"].extensions`. */
export function describePath(rulePath: RulePath): string {
  return rulePath
    .map((segment, i) =>
      typeof segment === "object" ? `[${segment.where}=${JSON.stringify(segment.equals)}]` : i === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/**
 * Removes one element of an array: the element and its comma (or, for the last element, the comma
 * before it), and its line when nothing else is on it. Unlike jsonc-parser's removal, it keeps comments
 * between the element and the next one, which describe the next one.
 */
export function removeArrayElement(text: string, arrayPath: (string | number)[], index: number): string {
  const tree = parseTree(text);
  const array: Node | undefined = tree && findNodeAtLocation(tree, arrayPath);
  const element = array?.children?.[index];
  if (!array?.children || !element) {
    return text;
  }
  let start = element.offset;
  let end = element.offset + element.length;
  const isLast = index === array.children.length - 1;
  if (!isLast) {
    end = text.indexOf(",", end) + 1;
  } else if (index > 0) {
    const previous = array.children[index - 1]!;
    start = text.indexOf(",", previous.offset + previous.length);
  }
  // take the whole line when the element is alone on it
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*$/.test(text.slice(end, lineEnd === -1 ? text.length : lineEnd))) {
    start = lineStart;
    end = lineEnd === -1 ? text.length : lineEnd + 1;
  }
  return text.slice(0, start) + text.slice(end);
}
