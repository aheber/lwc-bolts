// The `declare module` block most metadata becomes: a module whose default export is a `const`, such as
// `@salesforce/label/c.Greeting` or `@salesforce/schema/Account.Name`.
import { variableName } from "./identifiers.ts";
import { jsDoc } from "./jsdoc.ts";
import type { SourceRange, TextBuilder } from "./text-builder.ts";

export interface DefaultExportModule {
  /** The module's name, as imports name it (`@salesforce/label/c.Greeting`). */
  readonly name: string;
  /** The default export's name, which gets a `_` prefix when it's a reserved word (see `variableName`). */
  readonly variable: string;
  /** The default export's type. */
  readonly type: string;
  /** The default export's documentation, as JSDoc lines (see `jsDoc`). */
  readonly doc?: readonly (string | undefined)[];
  /** Where the module's name and its variable map to in the source; unmapped without one. */
  readonly range?: SourceRange | null;
}

/**
 * Declares a module whose default export is a `const` of `type`:
 *
 * ```ts
 * declare module "@salesforce/label/c.Greeting" {
 *   /** Hello *\/
 *   const lblGreeting: string;
 *   export default lblGreeting;
 * }
 * ```
 */
export function writeDefaultExportModule(builder: TextBuilder, { name, variable, type, doc = [], range }: DefaultExportModule): void {
  const constName = variableName(variable);
  builder.write("declare module ");
  builder.writeMapped(JSON.stringify(name), range);
  builder.write(` {\n${jsDoc("  ", [...doc])}  const `);
  builder.writeMapped(constName, range);
  builder.write(`: ${type};\n  export default ${constName};\n}\n`);
}

/** The value of a schema import: `{ objectApiName: "Account" }`, with a field's `fieldApiName` first. */
export function schemaValueType(objectApiName: string, fieldApiName?: string): string {
  const field = fieldApiName === undefined ? "" : `    fieldApiName: ${JSON.stringify(fieldApiName)};\n`;
  return `{\n${field}    objectApiName: ${JSON.stringify(objectApiName)};\n  }`;
}
