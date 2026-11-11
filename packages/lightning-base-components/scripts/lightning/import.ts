// Builds the base components' definitions from their two sources and the manual overrides. Pure
// functions, so they can be tested without fetching anything (see ../generate.ts).
//
// - The Salesforce LWC language server's metadata (@salesforce/lwc-language-server's
//   transformed-lwc-standard.json) lists components and their attributes, with a type keyword and a
//   description for most.
// - The Jest stubs (@salesforce/sfdx-lwc-jest's src/lightning-stubs) are LWC classes with an `@api`
//   member for each property and method, without types.
//
// Components, properties and methods are the union of both. Types and descriptions come from the
// language server where it has them; anything else is `any`. Neither has events. The overrides then
// change, add or remove components and their members, and win over both sources.

export interface Member {
  type: string;
  description?: string;
}

export interface Component {
  description?: string;
  properties: Record<string, Member>;
  methods: Record<string, Member>;
  events: Record<string, Member>;
}

/** The language server's metadata (transformed-lwc-standard.json), as far as it's read. */
export interface LanguageServerMetadata {
  tags: { name: string; description: string; attributes?: { name: string; description?: string }[] }[];
}

/** The Jest stubs: each stub's folder, and the source of its module. */
export interface JestStub {
  folder: string;
  source: string;
}

/** A member's override: `null` removes it. */
export type MemberOverride = { type?: string; detail?: string; description?: string } | null;

/** A component's override: `null` removes it. */
export type ComponentOverride = {
  description?: string;
  replace?: boolean;
  properties?: Record<string, MemberOverride>;
  methods?: Record<string, MemberOverride>;
  events?: Record<string, MemberOverride>;
} | null;

/** lightning/overrides.jsonc, once validateOverrides finds it valid. */
export interface Overrides {
  components?: Record<string, ComponentOverride>;
}

/** A source's name, version and license, for the generated module's header. */
export interface Source {
  name: string;
  version: string;
  license: string;
}

export const MEMBER_KINDS = ["properties", "methods", "events"] as const;

export type MemberKind = (typeof MEMBER_KINDS)[number];

/** The language server's type keywords, as TypeScript types for bound values (base components coerce them). */
export const TYPE_KEYWORDS: Record<string, string> = {
  STRING: "string | number",
  BOOLEAN: "boolean",
  INTEGER: "number | string",
  DECIMAL: "number | string",
  NUMBER: "number | string",
  LIST: "readonly unknown[]",
  OBJECT: "any",
};

/** The type of a member nothing gives a type to. */
export const DEFAULT_TYPES: Record<MemberKind, string> = {
  properties: "any",
  methods: "(...args: any[]) => any",
  events: "CustomEvent<any>",
};

const TAG = /^lightning-[a-z0-9]+(-[a-z0-9]+)*$/;

function emptyComponent(): Component {
  return { properties: {}, methods: {}, events: {} };
}

/** Trims a description and folds its lines, as it's shown on hover. */
function cleanDescription(text: string | undefined): string | undefined {
  const cleaned = text?.replace(/\s*\n\s*/g, " ").trim();
  return cleaned ? cleaned : undefined;
}

/**
 * The language server's components. `toProperties(tag, attributeNames)` converts attribute names to the
 * property names LWC sets (see the generator, which compiles a template that uses them), returning
 * `[propertyName, attributeName]` pairs for those that are properties (not `class`, `style`, ...).
 */
export function importLanguageServer(
  metadata: LanguageServerMetadata,
  toProperties: (tag: string, attributes: string[]) => [string, string][],
): Record<string, Component> {
  const components: Record<string, Component> = {};
  for (const tag of metadata.tags) {
    if (!TAG.test(tag.name)) {
      continue;
    }
    // `* **icon-name**: *STRING* ...`, or `* **access-key**` without a type
    const declared = new Map([...tag.description.matchAll(/^\* \*\*([a-z][\w-]*)\*\*(?:: \*(\w+)\*)?/gm)].map((m) => [m[1]!, m[2]]));
    if (declared.size === 0) {
      continue; // a module, such as lightning-navigation
    }
    const descriptions = new Map((tag.attributes ?? []).map((attribute) => [attribute.name, cleanDescription(attribute.description)]));
    const component = emptyComponent();
    component.description = cleanDescription(tag.description.split(/^### Attributes/m)[0]);
    for (const [property, attribute] of toProperties(tag.name, [...declared.keys()])) {
      const type = property === "value" ? "any" : (TYPE_KEYWORDS[declared.get(attribute) ?? ""] ?? DEFAULT_TYPES.properties);
      const description = descriptions.get(attribute);
      component.properties[property] = { type, ...(description && { description }) };
    }
    components[tag.name] = component;
  }
  return components;
}

/** A stub folder's tag: `buttonIcon` is `lightning-button-icon`. */
export function stubTag(folder: string): string {
  return `lightning-${folder.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * The Jest stubs' components: classes extending LightningElement, with `@api` fields, accessors and
 * methods. Other stubs are modules (such as uiRecordApi), not components.
 */
export function importJestStubs(stubs: JestStub[]): Record<string, Component> {
  const components: Record<string, Component> = {};
  for (const { folder, source } of stubs) {
    if (!/\bextends\s+LightningElement\b/.test(source)) {
      continue;
    }
    const tag = stubTag(folder);
    if (!TAG.test(tag)) {
      continue;
    }
    const component = emptyComponent();
    for (const match of source.matchAll(/@api\s+(?:(get|set)\s+)?([A-Za-z_$][\w$]*)\s*([;=(])/g)) {
      const [, accessor, name = "", next] = match;
      if (next === "(" && accessor === undefined) {
        component.methods[name] = { type: DEFAULT_TYPES.methods };
      } else {
        component.properties[name] = { type: DEFAULT_TYPES.properties };
      }
    }
    components[tag] = component;
  }
  return components;
}

/**
 * The union of both sources' components and members, preferring the language server's types and
 * descriptions (the stubs have neither).
 */
export function consolidate(languageServer: Record<string, Component>, jestStubs: Record<string, Component>): Record<string, Component> {
  const components: Record<string, Component> = {};
  for (const tag of new Set([...Object.keys(languageServer), ...Object.keys(jestStubs)])) {
    const component = emptyComponent();
    const fromServer = languageServer[tag];
    const fromStubs = jestStubs[tag];
    if (fromServer?.description) {
      component.description = fromServer.description;
    }
    for (const kind of MEMBER_KINDS) {
      component[kind] = { ...fromStubs?.[kind], ...fromServer?.[kind] };
    }
    components[tag] = component;
  }
  return components;
}

const COMPONENT_KEYS = new Set<string>(["description", "replace", ...MEMBER_KINDS]);
const MEMBER_KEYS: Record<MemberKind, string[]> = {
  properties: ["type", "description"],
  methods: ["type", "description"],
  events: ["type", "detail", "description"],
};

/** Checks the overrides file's shape, returning its problems (an empty list when it's valid). */
export function validateOverrides(overrides: unknown): string[] {
  const problems: string[] = [];
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(overrides)) {
    return ["the overrides must be an object"];
  }
  for (const key of Object.keys(overrides)) {
    if (key !== "$schema" && key !== "components") problems.push(`unknown key "${key}"`);
  }
  const components = overrides.components ?? {};
  if (!isObject(components)) {
    return [...problems, `"components" must be an object`];
  }
  for (const [tag, component] of Object.entries(components)) {
    if (!TAG.test(tag)) problems.push(`"${tag}" isn't a lightning-* tag`);
    if (component === null) continue;
    if (!isObject(component)) {
      problems.push(`${tag} must be an object, or null to remove it`);
      continue;
    }
    for (const [key, value] of Object.entries(component)) {
      if (!COMPONENT_KEYS.has(key)) problems.push(`${tag}: unknown key "${key}"`);
      else if (key === "replace" && typeof value !== "boolean") problems.push(`${tag}.replace must be a boolean`);
      else if (key === "description" && typeof value !== "string") problems.push(`${tag}.description must be a string`);
    }
    for (const kind of MEMBER_KINDS) {
      const members = component[kind];
      if (members === undefined) continue;
      if (!isObject(members)) {
        problems.push(`${tag}.${kind} must be an object`);
        continue;
      }
      for (const [name, member] of Object.entries(members)) {
        const at = `${tag}.${kind}.${name}`;
        if (!/^[A-Za-z_$][\w$]*$/.test(name) && kind !== "events") problems.push(`${at}: not an identifier`);
        if (kind === "events" && !/^[a-z][a-z0-9_]*$/.test(name))
          problems.push(`${at}: event names are lowercase, as \`on<name>\` handles them`);
        if (member === null) continue;
        if (!isObject(member)) {
          problems.push(`${at} must be an object, or null to remove it`);
          continue;
        }
        for (const [key, value] of Object.entries(member)) {
          if (!MEMBER_KEYS[kind].includes(key)) problems.push(`${at}: unknown key "${key}"`);
          else if (typeof value !== "string" || value.trim() === "") problems.push(`${at}.${key} must be a non-empty string`);
        }
        if (member.type !== undefined && member.detail !== undefined) problems.push(`${at}: give a type or a detail, not both`);
      }
    }
  }
  return problems;
}

/**
 * Applies the overrides, which win over the imported definitions:
 *
 * - A component or member set to `null` is removed, and stays removed however the sources change.
 * - A member's `type` and `description` replace the imported ones; a member that isn't imported is added
 *   (with `any`, or the kind's default type, when it has no type). An event's `detail` is shorthand for
 *   `CustomEvent<detail>`.
 * - A component that isn't imported is added. With `"replace": true`, the imported members of a
 *   component are ignored, and it has only the members the overrides give it.
 *
 * Also returns warnings for overrides that no longer match anything imported, such as a removal of a
 * property the sources dropped, so they can be cleaned up.
 */
export function applyOverrides(
  imported: Record<string, Component>,
  overrides: Overrides,
): { components: Record<string, Component>; warnings: string[] } {
  const components = structuredClone(imported);
  const warnings: string[] = [];
  for (const [tag, override] of Object.entries(overrides?.components ?? {})) {
    if (override === null) {
      if (components[tag] === undefined) warnings.push(`${tag} is removed, but neither source has it`);
      delete components[tag];
      continue;
    }
    const current = components[tag];
    const component = override.replace || current === undefined ? emptyComponent() : current;
    if (override.description !== undefined) {
      component.description = override.description;
    } else if (override.replace) {
      component.description = imported[tag]?.description;
    }
    for (const kind of MEMBER_KINDS) {
      for (const [name, member] of Object.entries(override[kind] ?? {})) {
        if (member === null) {
          if (imported[tag]?.[kind]?.[name] === undefined) warnings.push(`${tag}.${kind}.${name} is removed, but neither source has it`);
          delete component[kind][name];
          continue;
        }
        const existing = component[kind][name];
        const type = member.detail !== undefined ? `CustomEvent<${member.detail}>` : (member.type ?? existing?.type ?? DEFAULT_TYPES[kind]);
        const description = member.description ?? existing?.description;
        component[kind][name] = { type, ...(description && { description }) };
      }
    }
    if (component.description === undefined) delete component.description;
    components[tag] = component;
  }
  return { components, warnings };
}

/** Sorts components and their members by name, so the generated file only changes with its content. */
export function sortComponents(components: Record<string, Component>): Record<string, Component> {
  const sorted = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return sorted(
    Object.fromEntries(
      Object.entries(components).map(([tag, component]) => [
        tag,
        {
          ...(component.description && { description: component.description }),
          properties: sorted(component.properties),
          methods: sorted(component.methods),
          events: sorted(component.events),
        },
      ]),
    ),
  );
}

/**
 * The generated module: the definitions, with the sources' versions and licenses in its header.
 */
export function renderModule(components: Record<string, Component>, sources: Source[]): string {
  const comment = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => `// ${line}`.trimEnd())
      .join("\n");
  const licenses = sources.map((source) => `\n// ${source.name}@${source.version}:\n//\n${comment(source.license.trim())}`).join("\n//");
  return `// Generated by scripts/generate.ts from the sources in lightning/sources.json and the
// manual changes in lightning/overrides.jsonc; don't edit it by hand. The sources' licenses:
//${licenses}

import type { LightningComponent } from "./types.ts";

/** The \`lightning-*\` base components, by tag. */
export const LIGHTNING_COMPONENTS: Readonly<Record<string, LightningComponent>> = ${JSON.stringify(sortComponents(components), null, 2)};
`;
}
