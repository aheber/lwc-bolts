import type { ConversionContext } from "../context.ts";
import type { ConversionOutput, LightningComponentBundleComponent } from "../types.ts";
import { importNameParts, metadataName } from "../names.ts";
import { parseComponentSource } from "./component-source.ts";
import { variableName } from "../identifiers.ts";
import { docParagraphs, docTag, jsDoc } from "../jsdoc.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseXml } from "../xml.ts";

/**
 * Declares the `c/<name>` module that LWC components import another component through, from the
 * component's `<name>.js-meta.xml`. The declaration re-exports the component's own module by type,
 * so its default and named exports keep their types and definitions, without listing them:
 *
 * ```ts
 * declare module "c/myComponent" {
 *   const myComponent: typeof import("./myComponent.js");
 *   export = myComponent;
 * }
 * ```
 *
 * The declaration's variable is named after the module's default export (`component.defaultExportName`),
 * which editors suggest when auto-importing it, or after the bundle without one.
 *
 * A bundle of another namespace (an installed package's, named `dlrs__manageRollups`) is imported
 * through its namespace, as `dlrs/manageRollups`, and only when it's exposed (`<isExposed>true`); other
 * namespaces can't import it otherwise, so it declares nothing. A template's tag names its namespace in
 * lower case (`<sbqq-quote-line>`), so a namespace that isn't (`SBQQ`) is declared that way too.
 */
export function convertBundleMetadata(component: LightningComponentBundleComponent, context: ConversionContext): ConversionOutput {
  // read leniently: a .js-meta.xml being written still declares its bundle's module
  const root = parseXml(component.content);
  const bundle = root?.name === "LightningComponentBundle" ? root : undefined;
  const fileName = metadataName(component.path);
  const { namespace, name } = importNameParts(fileName, context.projectNamespace);
  if (namespace !== undefined && bundle?.childText("isExposed")?.trim() !== "true") {
    return { text: "", mapData: [] };
  }
  const label = bundle?.childText("masterLabel");
  const description = docTag("description", bundle?.childText("description"));
  // go-to-definition on the module's name lands on the label, or on the root element without one
  const range = bundle?.child("masterLabel")?.contentRange ?? bundle?.nameRange;
  const variable = variableName(component.defaultExportName ?? name);
  const builder = new TextBuilder();
  const modules = new Set([`${namespace ?? "c"}/${name}`, ...(namespace === undefined ? [] : [`${namespace.toLowerCase()}/${name}`])]);
  for (const module of modules) {
    builder.write(jsDoc("", docParagraphs(label, description)));
    builder.write("declare module ");
    builder.writeMapped(JSON.stringify(module), range);
    builder.write(` {
  const ${variable}: typeof import("./${fileName}.js");
  export = ${variable};
}
`);
  }
  return builder.output();
}

/**
 * A bundle's API version, from its `.js-meta.xml`, or undefined when it has none that can be read (such
 * as one being written).
 */
export function bundleApiVersion(metadata: string): number | undefined {
  const root = parseXml(metadata);
  const version = root?.name === "LightningComponentBundle" ? Number(root.childText("apiVersion")?.trim() || NaN) : NaN;
  return Number.isFinite(version) ? version : undefined;
}

/**
 * Finds the name of a module's default export: a named class or function, an identifier
 * (`export default recordCard;`), or `export { recordCard as default }`, optionally re-exported from
 * another module. Returns undefined for anonymous defaults (`export default class extends ...`, arrow
 * functions, objects, calls, any other expression), `export { default } from "..."`, modules without a
 * default export, and modules that don't parse.
 */
export function findDefaultExportName(source: string): string | undefined {
  for (const statement of parseComponentSource(source)?.body ?? []) {
    if (statement.type === "ExportDefaultDeclaration") {
      const { declaration } = statement;
      const name =
        declaration.type === "Identifier"
          ? declaration.name
          : declaration.type === "ClassDeclaration" || declaration.type === "FunctionDeclaration"
            ? declaration.id?.name
            : undefined;
      // `undefined` is an identifier, but no name for a variable
      return name === "undefined" ? undefined : name;
    }
    if (statement.type === "ExportNamedDeclaration") {
      for (const { local, exported } of statement.specifiers) {
        const exportedName = exported.type === "Identifier" ? exported.name : exported.value;
        if (exportedName === "default" && local.type === "Identifier" && local.name !== "default") {
          return local.name;
        }
      }
    }
  }
  return undefined;
}
