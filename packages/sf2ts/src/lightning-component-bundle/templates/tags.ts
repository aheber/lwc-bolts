// Templates' tags: what each one is, and the types of those that are elements.
import type { LightningComponent } from "@lwc-bolts/lightning-base-components";
import type { BaseElement } from "./ast.ts";

/**
 * Salesforce's own namespaces of components that templates use, which aren't installed packages':
 * `lightning`'s are described by LIGHTNING_COMPONENTS, and the others aren't described at all. It isn't
 * every one there is, so a tag of one that's missing is reported as a component the project doesn't have.
 */
export const PLATFORM_NAMESPACES = new Set(["lightning", "lightningsnapin", "force", "ui"]);

/** Which helper types an element in a namespace other than HTML, whose tags can have the same names. */
const ELEMENT_HELPERS: Readonly<Record<string, string>> = {
  "http://www.w3.org/2000/svg": "__lwcSvgElement",
  "http://www.w3.org/1998/Math/MathML": "__lwcMathElement",
};

/** The DOM type of a plain element, by its namespace, as `<a>` in an `<svg>` isn't an HTML `<a>`. */
export function elementType(node: BaseElement): string {
  return `${ELEMENT_HELPERS[node.namespace] ?? "__lwcElement"}<${JSON.stringify(node.name)}>`;
}

/** What a tag is, which decides how its properties, events and refs are checked. */
export type TagKind =
  /** A plain HTML, SVG or MathML element. */
  | { kind: "element" }
  /** One of the project's components: `name` is what the project's lookups know it by. */
  | { kind: "child"; name: string; module: string }
  /** An installed package's component, whose source is hidden. */
  | { kind: "package"; module: string }
  /** A base component with a definition. */
  | { kind: "base"; tag: string }
  /** Anything nothing describes, such as `<slot>`, `<lwc:component>` or another Salesforce namespace's component. */
  | { kind: "other" };

/**
 * What a tag is. `tagModule` is the compiler's, as a tag names what the compiled template imports.
 * Installed packages' components are of any namespace but `c`, the project's own and Salesforce's.
 */
export function tagKind(
  node: BaseElement,
  tagModule: (tag: string) => string,
  projectNamespace: string | undefined,
  baseComponents: Readonly<Record<string, LightningComponent>>,
): TagKind {
  if (node.type === "Element") {
    return { kind: "element" };
  }
  if (node.type !== "Component") {
    return { kind: "other" };
  }
  const module = tagModule(node.name);
  const [namespace, name] = module.split("/") as [string, string];
  if (namespace === "c") {
    return { kind: "child", name, module };
  }
  if (namespace !== projectNamespace?.toLowerCase() && !PLATFORM_NAMESPACES.has(namespace)) {
    return { kind: "package", module };
  }
  return baseComponents[node.name] === undefined ? { kind: "other" } : { kind: "base", tag: node.name };
}
