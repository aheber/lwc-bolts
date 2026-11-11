// @lwc/template-compiler's AST, which its own types describe, and what they leave out. They're imported
// from where they're declared: the package's entry re-exports them with an extensionless path, which
// `nodenext` can't resolve, so its entry has no types of its own (and `parse` returns `any`).
import type { Config } from "@lwc/template-compiler/dist/config.js";
import type {
  ChildNode,
  ComplexExpression,
  ElseBlock,
  ElseifBlock,
  Expression,
  ForEach,
  ForOf,
  If,
  IfBlock,
  Literal,
  Root,
  TemplateParseResult,
} from "@lwc/template-compiler/dist/shared/types.js";

export type {
  BaseElement,
  ChildNode,
  ElseifBlock,
  ForEach,
  ForOf,
  If,
  IfBlock,
  Property,
  Root,
  ScopedSlotFragment,
  SourceLocation,
  Text,
} from "@lwc/template-compiler/dist/shared/types.js";

/** The API version that complex expressions start at. */
const COMPLEX_EXPRESSIONS_API_VERSION = 66;

/** Whether a component at an API version has complex expressions: the latest does, when it's not known. */
export function hasComplexExpressions(apiVersion: number | undefined): boolean {
  return apiVersion === undefined || apiVersion >= COMPLEX_EXPRESSIONS_API_VERSION;
}

/**
 * How a template is parsed: at its component's API version, as the compiler gates what's valid by it, or
 * without one (a component whose metadata can't be read) at the compiler's latest. Complex expressions
 * also need their flag, as it changes what's valid at older versions: with it, `"{x}"` is a binding, rather
 * than an ambiguity the compiler reports.
 */
function parseConfig(apiVersion: number | undefined): Config {
  return {
    experimentalComplexExpressions: hasComplexExpressions(apiVersion),
    enableDynamicComponents: true,
    enableLwcOn: true,
    ...(apiVersion !== undefined && { apiVersion }),
  };
}

/**
 * A parsed expression: an ESTree node, which the compiler's types leave without its offsets. In an
 * attribute or directive they're relative to its `{`. Where they're relative to in text depends on the API
 * version (see TemplateSource.textExpression).
 */
export type TemplateExpression = (Expression | ComplexExpression) & { start: number; end: number };

/** What an attribute, directive or text has: an expression, or a literal the compiler made of it. */
export type TemplateValue = Literal | Expression | ComplexExpression;

/** Whether a value is an expression, rather than the literal the compiler made of an attribute or text. */
export function isExpression(value: TemplateValue): value is TemplateExpression {
  return "start" in value;
}

/** Nodes that don't create elements, so their content is their parent's content. */
export function isBlock(node: ChildNode): node is IfBlock | ElseifBlock | ElseBlock | If | ForEach | ForOf {
  return ["IfBlock", "ElseifBlock", "ElseBlock", "If", "ForEach", "ForOf"].includes(node.type);
}

/** A diagnostic from the compiler, whose own type doesn't resolve either. */
export interface CompilerDiagnostic {
  message: string;
  level: number;
  location?: { start?: number; length?: number };
}

/** A parsed template: as much of it as the compiler could read, and its errors, without its warnings. */
export interface ParsedTemplate {
  root: Root | undefined;
  errors: CompilerDiagnostic[];
}

/** What sf2ts uses the compiler for, which is where it's reached from. */
export interface TemplateCompiler {
  /** Parses a template at an API version (see parseConfig). */
  parse(source: string, apiVersion: number | undefined): ParsedTemplate;
  /**
   * The expression as LWC's codegen binds it: an ESTree node with each of the component's members wrapped
   * in a member expression of `instance`. It throws for what only codegen rejects.
   */
  bind(expression: TemplateExpression, isLocal: (name: string) => boolean, instance: string, complexExpressions: boolean): unknown;
  /** The module of a component's tag: `c-base-card` is `c/baseCard`. */
  tagModule(tag: string): string;
}

/** Whether the compiler's diagnostic is an error. Its levels: 0 fatal, 1 error, 2 warning, 3 log. */
function isError(diagnostic: CompilerDiagnostic): boolean {
  return diagnostic.level <= 1;
}

let compiler: Promise<typeof import("@lwc/template-compiler")> | undefined;

/** Loads the compiler, on the first template. */
export async function loadTemplateCompiler(): Promise<TemplateCompiler> {
  compiler ??= import("@lwc/template-compiler");
  const { bindExpression, kebabcaseToCamelcase, parse } = await compiler;
  return {
    parse(source, apiVersion) {
      const { root, warnings } = parse(source, parseConfig(apiVersion)) as TemplateParseResult;
      return { root, errors: (warnings as CompilerDiagnostic[]).filter(isError) };
    },
    bind: (expression, isLocal, instance, complexExpressions) =>
      bindExpression(expression, (node: { name: string }) => isLocal(node.name), instance, complexExpressions),
    tagModule: kebabcaseToCamelcase,
  };
}
