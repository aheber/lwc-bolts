// Slots: those a template declares, for templates that use its component, and the content a template
// passes to a child's.
import { isBlock, type BaseElement, type ChildNode, type Root } from "./ast.ts";
import type { TemplateSource } from "./source.ts";

/** A slot name in a slot check, with `(default)` for the unnamed slot. */
export const DEFAULT_SLOT = "(default)";

/** The slots a template declares, `(default)` for the unnamed one. */
export function templateSlots(root: Root): Set<string> {
  const slots = new Set<string>();
  const visit = (node: ChildNode | undefined) => {
    if (node === undefined || node.type === "Text" || node.type === "Comment") return;
    if (node.type === "Slot") {
      slots.add(node.slotName || DEFAULT_SLOT);
    }
    node.children.forEach(visit);
    if ("else" in node) visit(node.else);
  };
  root.children.forEach(visit);
  return slots;
}

/**
 * Declares a template's slots for the templates that use its component, `module` (such as `c/baseCard`),
 * which check what they pass it against `__lwcSlots<"c/baseCard">`. Each of the component's templates adds
 * to the global `__LwcSlots` interface: `"c/baseCard"`, saying its slots are known, and `"c/baseCard footer"`
 * for each slot. Slots are `undefined` when the template has errors (such as one being edited), whose slots
 * may be missing: it adds `"c/baseCard *"`, which allows any slot. A component without templates in the
 * program adds nothing, and isn't checked.
 */
export function slotDeclarations(module: string, slots: ReadonlySet<string> | undefined): string {
  const keys = [module, ...(slots === undefined ? [`${module} *`] : [...slots].map((slot) => `${module} ${slot}`))];
  return `declare global {
  interface __LwcSlots {
${keys.map((key) => `    ${JSON.stringify(key)}: true;\n`).join("")}  }
}
`;
}

/** A piece of content passed to a component, naming the slot it goes in. */
export interface SlottedContent {
  slot: string;
  /** Where to report a slot that doesn't exist, when that can be found. */
  position: number | undefined;
  length: number;
}

/** The content a component's tag passes to it: `lwc:if` and loops don't create elements, so theirs is too. */
export function slottedContent(node: BaseElement, source: TemplateSource): SlottedContent[] {
  const nodes: ChildNode[] = [];
  const collect = (children: ChildNode[]) => {
    for (const child of children) {
      if (isBlock(child)) {
        collect(child.children);
        if ("else" in child && child.else) collect([child.else]);
      } else {
        nodes.push(child);
      }
    }
  };
  collect(node.children);
  return nodes.flatMap((child) => contentOf(child, source) ?? []);
}

/** What a node passes to a slot, if anything: a slot chosen at runtime can't be checked. */
function contentOf(child: ChildNode, source: TemplateSource): SlottedContent | undefined {
  if (child.type === "Comment" || isBlock(child)) {
    return undefined;
  }
  if (child.type === "Text") {
    const text = child.raw.trim();
    return text === "" ? undefined : { slot: DEFAULT_SLOT, position: source.literal(text, child.location), length: text.length };
  }
  if (child.type === "ScopedSlotFragment") {
    const name = child.slotName;
    return name.type === "Literal" ? { slot: String(name.value) || DEFAULT_SLOT, position: undefined, length: 0 } : undefined;
  }
  const attribute = child.attributes.find(({ name }) => name === "slot");
  if (attribute === undefined) {
    return { slot: DEFAULT_SLOT, position: child.location.start + 1, length: child.name.length };
  }
  const { value } = attribute;
  if (value.type !== "Literal" || typeof value.value !== "string") {
    return undefined;
  }
  return { slot: value.value || DEFAULT_SLOT, position: source.name(value.value, attribute.location, "="), length: value.value.length };
}
