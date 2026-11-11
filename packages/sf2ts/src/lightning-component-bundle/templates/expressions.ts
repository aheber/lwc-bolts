// Template expressions, which are written to the TypeScript as they are in the template, with `$cmp.`
// before each name that's a member of the component. What's a member is up to LWC's own codegen.
import type { TemplateCompiler, TemplateExpression } from "./ast.ts";

/** Any ESTree node, which the compiler's types don't describe. */
interface EstreeNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** A name in an expression that's a member of the component. */
export interface ComponentName {
  start: number;
  end: number;
  /** Whether it's a shorthand property (`{ a }`), which needs its key spelled out to be prefixed. */
  shorthand: boolean;
}

function isNode(value: unknown): value is EstreeNode {
  return value !== null && typeof value === "object" && typeof (value as EstreeNode).type === "string";
}

function children(node: EstreeNode): EstreeNode[] {
  return Object.values(node).flat().filter(isNode);
}

/** Marks the names LWC binds to the component in an expression: nothing else is called this. */
const INSTANCE = "$cmp";

/**
 * The names in an expression that are members of the component, in order, as LWC's codegen binds them.
 * `bind` wraps each one in a member expression of an instance it makes up, which has no offsets, while
 * the name itself keeps its own. It throws for an expression that only codegen rejects.
 */
export function componentNames(
  expression: TemplateExpression,
  isLocal: (name: string) => boolean,
  complexExpressions: boolean,
  bind: TemplateCompiler["bind"],
): ComponentName[] {
  const names: ComponentName[] = [];
  const visit = (node: EstreeNode, parent: EstreeNode | undefined): void => {
    const object = node.type === "MemberExpression" ? (node.object as EstreeNode) : undefined;
    if (object?.name === INSTANCE && object.start === undefined) {
      const { start, end } = node.property as EstreeNode;
      names.push({ start, end, shorthand: parent?.type === "Property" && parent.shorthand === true });
      return;
    }
    for (const child of children(node)) {
      visit(child, node);
    }
  };
  visit(bind(expression, isLocal, INSTANCE, complexExpressions) as EstreeNode, undefined);
  return names.sort((a, b) => a.start - b.start);
}

/** Whether an expression is one that's safe anywhere: others are parenthesized where they're written. */
export function isSimple(expression: TemplateExpression): boolean {
  return expression.type === "Identifier" || expression.type === "MemberExpression";
}
