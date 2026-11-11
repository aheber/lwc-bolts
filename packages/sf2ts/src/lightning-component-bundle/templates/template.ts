// LWC templates: each `.html` in a component bundle becomes virtual TypeScript that uses the component
// the way the template does, so TypeScript checks the template's bindings against the component's class.
//
//   <template lwc:if={hasOrders}>                 import type __Component from "./orders.js";
//     <template for:each={rows} for:item="row">   declare const $cmp: InstanceType<typeof __Component>;
//       <p key={row.id}>{row.name}</p>     ->     if ($cmp.hasOrders) {
//     </template>                                   for (const row of $cmp.rows ?? []) {
//   </template>                                       row.id; row.name;
//                                                   }
//                                                 }
//
// Names map back to the template verbatim, so diagnostics, hover and go-to-definition work there, and a
// loop variable's go-to-definition lands on its `for:item`. The output is a module (it imports the
// component), so its helpers don't clash with other templates'. Its default export is the compiled
// template, so a component can import a template and return it from `render()`.
import { LIGHTNING_COMPONENTS, type LightningComponent } from "@lwc-bolts/lightning-base-components";
import type { ConversionContext } from "../../context.ts";
import type { ConversionOutput, LightningComponentBundleComponent, MapPair } from "../../types.ts";
import { isIdentifier } from "../../identifiers.ts";
import { MapFeature } from "../../text-builder.ts";
import {
  hasComplexExpressions,
  isExpression,
  loadTemplateCompiler,
  type BaseElement,
  type ChildNode,
  type ElseifBlock,
  type ForEach,
  type ForOf,
  type If,
  type IfBlock,
  type Property,
  type ScopedSlotFragment,
  type SourceLocation,
  type TemplateExpression,
  type TemplateCompiler,
  type TemplateValue,
  type Text,
} from "./ast.ts";
import { importNameParts } from "../../names.ts";
import { ComponentTypes, TemplateRefs } from "./declarations.ts";
import { componentNames, isSimple, type ComponentName } from "./expressions.ts";
import { helperDeclarations } from "./helpers.ts";
import { slotDeclarations, slottedContent, templateSlots } from "./slots.ts";
import { TemplateSource, type ExpressionOrigin } from "./source.ts";
import { elementType, tagKind, type TagKind } from "./tags.ts";
import { Writer } from "./writer.ts";

/** What a handler must be: any function, whatever the event it's given. */
const HANDLER_TYPE = "(...args: any[]) => unknown";

/** An error the LWC template compiler reports in a template, at a UTF-16 offset and length. */
export interface TemplateDiagnostic {
  message: string;
  start: number;
  length: number;
}

/** A template converted to TypeScript, with where its pieces came from and the compiler's errors. */
export interface ConvertedTemplate {
  text: string;
  mapData: MapPair[];
  diagnostics: TemplateDiagnostic[];
}

/**
 * Converts one of a bundle's templates (`convert` with a `LightningComponentBundle`'s `.html`). What the
 * template needs to know about its bundle is on the component: how it imports the bundle's component
 * (`componentModule`), the bundle's name, its API version, and whether it has other templates. Without
 * them, the template is taken to be in the bundle's folder, named for it. Other components' slots come
 * from their own templates' declarations. The compiler's errors are `TemplateError` diagnostics.
 */
export async function convertBundleTemplate(
  component: LightningComponentBundleComponent,
  context: ConversionContext,
): Promise<ConversionOutput> {
  const bundleName = component.bundleName ?? component.path.split(/[\\/]/).at(-2);
  if (!bundleName) {
    throw new Error(`no bundle name, and no bundle folder in the file path ${component.path}`);
  }
  const { namespace, name } = importNameParts(bundleName, context.projectNamespace);
  const { apiVersion, alternateTemplates, componentModule = `./${bundleName}.js` } = component;
  const { text, mapData, diagnostics } = await convertTemplate(component.content, componentModule, {
    fileName: component.path,
    module: `${namespace ?? "c"}/${name}`,
    ...(alternateTemplates !== undefined && { alternateTemplates }),
    ...(apiVersion !== undefined && { apiVersion }),
    ...(context.projectNamespace !== undefined && { projectNamespace: context.projectNamespace }),
  });
  return {
    text,
    mapData,
    ...(diagnostics.length > 0 && { diagnostics: diagnostics.map((diagnostic) => ({ kind: "TemplateError" as const, ...diagnostic })) }),
  };
}

/**
 * The name of a template's default export, which editors show and offer in auto-imports: `<file>Template`,
 * so `default.html`'s is `defaultTemplate` rather than a reserved word. A file name can have characters
 * a name can't.
 */
export function templateExportName(fileName: string): string {
  const name = fileName
    .split(/[\\/]/)
    .pop()!
    .replace(/\.html$/i, "")
    .replace(/[^\w$]/g, "_");
  return `${/^\d/.test(name) ? "_" : ""}${name}Template`;
}

/** What a template converter can find out about the rest of the project. */
export interface TemplateContext {
  /** The template's file, which names its default export (see templateExportName): `default.html` when not given. */
  fileName?: string;
  /**
   * The module other components import the template's component as, such as `c/orders`, under which it
   * declares its slots for their templates. Without it, the template declares none.
   */
  module?: string;
  /** Whether the bundle has other templates, any of which may be the one rendered. */
  alternateTemplates?: boolean;
  /** The API version of the template's component, which it's parsed at: the compiler's latest when not given. */
  apiVersion?: number;
  /** The project's own namespace, whose tags are left unchecked: components in it use `c`. */
  projectNamespace?: string;
  /** The `lightning-*` base components, by tag, that templates are checked against: LIGHTNING_COMPONENTS by default. */
  baseComponents?: Readonly<Record<string, LightningComponent>>;
}

class TemplateConverter {
  readonly out = new Writer();
  /** What only LWC's codegen rejects, which parsing the template doesn't report. */
  readonly diagnostics: TemplateDiagnostic[] = [];
  readonly #context: TemplateContext;
  readonly #source: TemplateSource;
  /** How many conditional blocks (`lwc:if`, `if:true`, scoped slots) enclose the current node. */
  #conditional = 0;
  readonly #refs = new TemplateRefs();
  readonly #components: ComponentTypes;
  readonly #compiler: TemplateCompiler;
  /** The base components, by tag (see TemplateContext.baseComponents). */
  readonly #baseComponents: Readonly<Record<string, LightningComponent>>;
  /** Loop variables in scope; any other name is a member of the component. */
  readonly #scope: Set<string>[] = [];
  /** How many loops have needed an item variable of their own (see #loop). */
  #loopItems = 0;
  /** How many loops have needed a variable for their list (see #loop). */
  #loopLists = 0;

  constructor(source: string, context: TemplateContext, compiler: TemplateCompiler) {
    this.#source = new TemplateSource(source, { complexExpressions: hasComplexExpressions(context.apiVersion) });
    this.#context = context;
    this.#compiler = compiler;
    this.#baseComponents = context.baseComponents ?? LIGHTNING_COMPONENTS;
    this.#components = new ComponentTypes(this.#baseComponents);
  }

  #tag(node: BaseElement): TagKind {
    return tagKind(node, this.#compiler.tagModule, this.#context.projectNamespace, this.#baseComponents);
  }

  /**
   * Checks the content passed to a child component, `module`, against the slots its templates declare (see
   * slotDeclarations): a `slot="name"` must be one of them, and content without one needs an unnamed slot.
   */
  #checkSlots(node: BaseElement, module: string): void {
    const allowed = `__lwcSlots<${JSON.stringify(module)}>`;
    for (const { slot, position, length } of slottedContent(node, this.#source)) {
      // `satisfies` rather than a helper call, whose argument would get a parameter name inlay hint, and in
      // a tuple so TypeScript reports a mismatch on the slot's name rather than on the type
      this.out.line(() => {
        this.out.write("[");
        this.out.writeAt(JSON.stringify(slot), position, length);
        this.out.write(`] satisfies [${allowed}];`);
      });
    }
  }

  /**
   * Checks a component's properties by writing them as an object literal that must satisfy its type:
   * TypeScript reports a property the component doesn't have, or a value of the wrong type, on the
   * property, which maps to the attribute's name. A child component's type is its public members
   * (`__lwcProperties<InstanceType<...>>`, a `Partial` that leaves out private ones). Base components coerce what they're
   * given, so for them (`lenient`) a literal value only checks the attribute's name.
   */
  #checkProperties(properties: Property[], type: string, lenient: boolean): void {
    // one literal per property: TypeScript reports only the first problem in each
    for (const property of properties) {
      const start = property.location.start;
      const { text } = this.#source;
      const named = text.slice(start, start + property.attributeName.length).toLowerCase() === property.attributeName.toLowerCase();
      this.out.line(() => {
        this.out.write("({ ");
        const key = isIdentifier(property.name) ? property.name : JSON.stringify(property.name);
        this.out.writeAt(key, named ? start : undefined, property.attributeName.length);
        this.out.write(": ");
        const { value } = property;
        const origin = this.#source.attribute(property.location);
        if (isExpression(value) && origin !== undefined) {
          this.#expression(value, origin);
        } else if (value.type === "Literal") {
          // LWC normalizes tabindex; a literal is otherwise the string (or, bare, `true`) it's set to
          this.out.write(lenient || property.name === "tabIndex" ? "undefined" : JSON.stringify(value.value ?? null));
        } else {
          this.out.write("undefined as any");
        }
        this.out.write(` }) satisfies ${type};`);
      });
    }
  }

  /** The type of an `lwc:ref` on an element or component. */
  #refType(node: BaseElement, tag: TagKind): string {
    switch (tag.kind) {
      case "child":
        return `HTMLElement & InstanceType<${this.#components.component(tag.module, node)}>`;
      case "package":
        // its source is hidden, so its members beyond the cached stub's are unknown
        return `HTMLElement & InstanceType<${this.#components.component(tag.module, node)}> & Record<string, any>`;
      case "element":
        return elementType(node);
      case "base": {
        const alias = this.#components.base(tag.tag);
        return `HTMLElement & ${alias}${Object.keys(this.#baseComponents[tag.tag]!.methods).length > 0 ? ` & ${alias}Methods` : ""}`;
      }
      default:
        return "HTMLElement & Record<string, any>"; // a component nothing describes
    }
  }

  /** Records an `lwc:ref`, typed as the element (or child component) it names. */
  #ref(node: BaseElement, tag: TagKind, name: string, location: SourceLocation): void {
    if (isIdentifier(name)) {
      const optional = this.#conditional > 0 || this.#context.alternateTemplates === true;
      this.#refs.add(name, this.#refType(node, tag), optional, this.#source.name(name, location, "="));
    }
  }

  #inConditional(body: () => void): void {
    this.#conditional++;
    body();
    this.#conditional--;
  }

  /** Declares what the template's code used: child components' types, and its `lwc:ref`s for `this.refs`. */
  finish(componentModule: string): void {
    this.#components.write(this.out);
    this.#refs.write(this.out, componentModule);
  }

  #inScope(name: string): boolean {
    return this.#scope.some((names) => names.has(name));
  }

  #withScope(names: string[], body: () => void): void {
    this.#scope.push(new Set(names));
    body();
    this.#scope.pop();
  }

  /**
   * Writes an expression as it is in the template, so anything that's valid in one is in the other and
   * every piece maps back, with `$cmp.` before the component's members. `$cmp.` maps to the `{`, so a
   * diagnostic about a whole expression (such as a handler that isn't a function) starts there rather
   * than at the start of the file.
   */
  #expression(expression: TemplateExpression, origin: ExpressionOrigin): void {
    const { brace, at } = origin;
    const names = this.#componentNames(expression, origin);
    if (names === undefined) {
      this.out.write("(undefined as any)");
      return;
    }
    const copy = (start: number, end: number) => {
      if (start < end) {
        this.out.write(this.#source.text.slice(at(start), at(end)), at(start), at(end));
      }
    };
    const simple = isSimple(expression);
    if (!simple) {
      this.out.write("(", brace, brace + 1);
    }
    let copied = expression.start;
    for (const { start, end, shorthand } of names) {
      copy(copied, shorthand ? end : start);
      if (shorthand) {
        this.out.write(": ");
      }
      this.out.write("$cmp.", brace, brace + 1);
      copied = start;
    }
    copy(copied, expression.end);
    if (!simple) {
      this.out.write(")", brace, brace + 1);
    }
  }

  /** An expression's members of the component, or undefined when LWC rejects it, which is reported on it. */
  #componentNames(expression: TemplateExpression, origin: ExpressionOrigin): ComponentName[] | undefined {
    try {
      const isLocal = (name: string) => this.#inScope(name);
      return componentNames(expression, isLocal, hasComplexExpressions(this.#context.apiVersion), this.#compiler.bind);
    } catch (error) {
      const start = origin.at(expression.start);
      this.diagnostics.push({ message: (error as Error).message, start, length: origin.at(expression.end) - start });
      return undefined;
    }
  }

  /** Writes a value as a statement, when it's an expression. `wrap` can check it there. */
  #statement(value: TemplateValue, location: SourceLocation, wrap = (write: () => void) => write()): void {
    const origin = this.#source.attribute(location);
    if (!isExpression(value) || origin === undefined) {
      return;
    }
    this.out.line(() => {
      wrap(() => this.#expression(value, origin));
      this.out.write(";");
    });
  }

  /** Writes a value as a statement that must satisfy a type, reported on the value, not on the type. */
  #checked(value: TemplateValue, location: SourceLocation, type: string): void {
    this.#statement(value, location, (write) => {
      this.out.write("[");
      write();
      this.out.write(`] satisfies [${type}]`);
    });
  }

  /** Declares a loop variable, mapped to where the template names it, and marks it used. */
  #declare(name: string, initializer: string, position: number | undefined): void {
    this.out.line(() => {
      this.out.write("const ");
      this.out.writeAt(name, position, name.length);
      this.out.write(` = ${initializer}; void ${name};`);
    });
  }

  nodes(nodes: ChildNode[]): void {
    for (const node of nodes) {
      this.node(node);
    }
  }

  node(node: ChildNode): void {
    switch (node.type) {
      case "Text":
        return this.#text(node);
      case "Element":
      case "Component":
      case "ExternalComponent":
      case "Slot":
      case "Lwc":
        return this.#element(node);
      case "IfBlock":
        return this.#ifBlock(node);
      case "If":
        return this.#if(node);
      case "ForEach":
        return this.#forEach(node);
      case "ForOf":
        return this.#forOf(node);
      case "ScopedSlotFragment":
        return this.#scopedSlot(node);
      case "Comment":
        return;
      default:
        // anything newer: its children may still have bindings
        return this.nodes(node.children);
    }
  }

  #text(node: Text): void {
    const expression = isExpression(node.value) ? node.value : undefined;
    const origin = this.#source.textExpression(node.raw, expression, node.location);
    if (expression === undefined || origin === undefined) {
      return;
    }
    this.out.line(() => {
      this.#expression(expression, origin);
      this.out.write(";");
    });
  }

  #element(node: BaseElement): void {
    const tag = this.#tag(node);
    for (const attribute of node.attributes) {
      this.#statement(attribute.value, attribute.location);
    }
    switch (tag.kind) {
      case "child":
        // every child is referenced, so one that doesn't exist is reported on its tag
        this.#checkProperties(node.properties, `__lwcProperties<InstanceType<${this.#components.component(tag.module, node)}>>`, false);
        break;
      case "base":
        if (node.properties.length > 0) {
          this.#checkProperties(node.properties, this.#components.base(tag.tag), true);
        }
        break;
      case "package":
        // An installed package's component is referenced too, so one the project doesn't have (not cached, or
        // misspelt) is reported on its tag. Its source is hidden, so its properties, events and slots aren't
        // known: they're left open, and only the values' expressions are checked.
        this.#components.component(tag.module, node);
      // falls through
      default:
        for (const property of node.properties) {
          this.#statement(property.value, property.location);
        }
    }
    if (tag.kind === "child") {
      this.#checkSlots(node, tag.module);
    }
    for (const directive of node.directives) {
      switch (directive.name) {
        case "Ref":
          this.#ref(node, tag, directive.value.value, directive.location);
          break;
        case "Is":
          // `lwc:is` renders nothing until it has a constructor
          this.#checked(directive.value, directive.location, "(new (...args: any[]) => unknown) | null | undefined");
          break;
        case "On":
          // `lwc:on` takes listeners by event name; which events isn't known, so nor is what they're given
          this.#checked(directive.value, directive.location, "Record<string, (event: any) => unknown> | null | undefined");
          break;
        default:
          this.#statement(directive.value, directive.location);
      }
    }
    // a handler (`on<event>={...}`) must be a function; which event it's given isn't checked. It's checked
    // with `satisfies` rather than passed to a helper, since an argument made of several mapped spans gets a
    // parameter name inlay hint for each of them. In a tuple, so TypeScript reports a mismatch on the
    // handler, which maps to the template, rather than on the `satisfies` type, which doesn't.
    for (const listener of node.listeners) {
      this.#checked(listener.handler, listener.location, HANDLER_TYPE);
    }
    this.nodes(node.children);
  }

  /** Writes a block's condition, which is all `true` is when there's nothing to check. */
  #condition(condition: TemplateExpression | undefined, location: SourceLocation): void {
    const origin = this.#source.attribute(location);
    if (condition === undefined || origin === undefined) {
      this.out.write("true");
    } else {
      this.#expression(condition, origin);
    }
  }

  /** `lwc:if`, with its `lwc:elseif` and `lwc:else` chain. */
  #ifBlock(node: IfBlock | ElseifBlock, keyword = "if"): void {
    this.out.block(
      () => {
        this.out.write(`${keyword} (`);
        this.#condition(node.condition as TemplateExpression | undefined, node.directiveLocation);
        this.out.write(")");
      },
      () => this.#inConditional(() => this.nodes(node.children)),
    );
    const next = node.else;
    if (next?.type === "ElseifBlock") {
      this.#ifBlock(next, "else if");
    } else if (next?.type === "ElseBlock") {
      this.out.block(
        () => this.out.write("else"),
        () => this.#inConditional(() => this.nodes(next.children)),
      );
    }
  }

  /** The legacy `if:true` and `if:false`. */
  #if(node: If): void {
    this.out.block(
      () => {
        this.out.write(node.modifier === "false" ? "if (!" : "if (");
        this.#condition(node.condition as TemplateExpression | undefined, node.directiveLocation);
        this.out.write(")");
      },
      () => this.#inConditional(() => this.nodes(node.children)),
    );
  }

  /**
   * A loop over the list in `node`'s directive. `for...of` checks the list is iterable (`?? []` allows
   * `null` and `undefined`, which render nothing), so the loop needs no helper call, whose argument would
   * get a parameter name inlay hint for each of its mapped spans.
   */
  #loop(node: ForEach | ForOf, variable: { name: string; position: number | undefined }, body: () => void, iterator = false): void {
    const origin = this.#source.attribute(node.directiveLocation);
    if (origin === undefined) {
      return this.#withScope([variable.name], () => this.nodes(node.children));
    }
    const expression = node.expression as TemplateExpression;
    // TypeScript rejects `?? []` after an expression that it can see is never nullish (`"{rows ?? []}"`), so
    // a complex list goes through a variable, which hides that
    const list = isSimple(expression) ? undefined : `__lwcList${this.#loopLists++}`;
    if (list !== undefined) {
      this.out.line(() => {
        this.out.write(`const ${list} = `);
        this.#expression(expression, origin);
        this.out.write(";");
      });
    }
    const { name, position } = variable;
    // An iterator's variable wraps each item, and a variable that shadows an outer loop's, which the list
    // may use (`for:each={item.children} for:item="item"`), can't be the loop's own: in
    // `for (const item of item.children)` the list would read it before its declaration. Either is
    // declared in the loop's body instead, from the loop's item.
    const direct = !iterator && !this.#inScope(name);
    const item = direct ? name : `__lwcItem${this.#loopItems++}`;
    this.out.block(
      () => {
        this.out.write("for (const ");
        if (direct) {
          this.out.writeAt(name, position, name.length);
        } else {
          this.out.write(item);
        }
        this.out.write(" of ");
        if (list === undefined) {
          this.#expression(expression, origin);
        } else {
          this.out.write(list, origin.brace, origin.brace + 1);
        }
        this.out.write(" ?? [])");
      },
      () => {
        if (iterator) {
          this.#declare(name, `{ value: ${item}, index: 0 as number, first: false as boolean, last: false as boolean }`, position);
        } else if (!direct) {
          this.#declare(name, item, position);
        } else {
          this.out.line(() => this.out.write(`void ${name};`));
        }
        body();
      },
    );
  }

  /** `for:each={list} for:item="item" for:index="index"`. */
  #forEach(node: ForEach): void {
    const { item, index } = node;
    const names = [item.name, ...(index ? [index.name] : [])];
    this.#loop(node, { name: item.name, position: this.#source.name(item.name, item.location, "=") }, () => {
      if (index) {
        this.#declare(index.name, "0 as number", this.#source.name(index.name, index.location, "="));
      }
      this.#withScope(names, () => this.nodes(node.children));
    });
  }

  /** `iterator:it={list}`, whose variable has `value`, `index`, `first` and `last`. */
  #forOf(node: ForOf): void {
    const { iterator } = node;
    const position = this.#source.name(iterator.name, iterator.location, ":");
    this.#loop(node, { name: iterator.name, position }, () => this.#withScope([iterator.name], () => this.nodes(node.children)), true);
  }

  /** `lwc:slot-data="data"` in a scoped slot: the parent can't know the data's type. */
  #scopedSlot(node: ScopedSlotFragment): void {
    const { name } = node.slotData.value;
    this.out.block(
      () => {},
      () => {
        this.#declare(name, "undefined as any", this.#source.name(name, node.slotData.location, "="));
        this.#withScope([name], () => this.#inConditional(() => this.nodes(node.children)));
      },
    );
  }
}

/**
 * Converts a component's template to TypeScript that checks its bindings against the component, imported
 * as `componentModule` (such as `./orders.js`). `context` tells it about its own bundle, and names
 * the component's module, for the slots it declares.
 */
export async function convertTemplate(content: string, componentModule: string, context: TemplateContext = {}): Promise<ConvertedTemplate> {
  const compiler = await loadTemplateCompiler();
  const { root, errors } = compiler.parse(content, context.apiVersion);
  const converter = new TemplateConverter(content, context, compiler);
  const out = converter.out;
  out.write(`import type __Component from ${JSON.stringify(componentModule)};
declare const $cmp: InstanceType<typeof __Component>;
`);
  if (root !== undefined) {
    converter.nodes(root.children);
    converter.finish(componentModule);
  }
  if (context.module !== undefined) {
    // a template with errors may be missing slots, so it allows any
    out.write(slotDeclarations(context.module, root === undefined || errors.length > 0 ? undefined : templateSlots(root)));
  }
  // Written even for a template that doesn't parse, so importing one being edited stays valid. The name
  // maps to the root tag, for go-to-definition from an import. `lwc` typings without `Template` (the
  // tests', or ones written by other tools) make it `any` rather than an error on every template.
  const name = templateExportName(context.fileName ?? "default.html");
  const tag = root === undefined ? undefined : root.location.start + 1;
  out.write("// @ts-ignore\ndeclare const ");
  out.writeAt(name, tag, "template".length, MapFeature.Definition);
  out.write(`: import("lwc").Template;\nexport default ${name};\n`);
  // the helpers the code uses, after it: TypeScript hoists declarations
  out.write(helperDeclarations(out.text));
  const parseErrors = errors.map((error) => {
    const start = Math.min(Math.max(error.location?.start ?? 0, 0), content.length);
    const end = Math.min(start + Math.max(error.location?.length ?? 0, 0), content.length);
    return { message: error.message, start, length: end - start };
  });
  return { text: out.text, mapData: out.mapData, diagnostics: [...parseErrors, ...converter.diagnostics] };
}
