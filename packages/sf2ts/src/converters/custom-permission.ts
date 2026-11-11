import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { fileImportName } from "../names.ts";
import { docParagraphs, docTag } from "../jsdoc.ts";
import { writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml } from "../xml.ts";

export function CustomPermission(component: Component, context: ConversionContext): ConversionOutput {
  const perm = parseMetadataXml(component.content, "CustomPermission");
  // the project's own namespace is left out of imports; another's (an installed package's) is kept
  const permName = fileImportName(component, context.projectNamespace);
  const builder = new TextBuilder();
  writeDefaultExportModule(builder, {
    name: `@salesforce/customPermission/${permName}`,
    variable: `has${permName}`,
    // `true` when the user has the permission, and `undefined` when they don't
    type: "true | undefined",
    doc: docParagraphs(perm.childText("label"), docTag("description", perm.childText("description"))),
    // go-to-definition lands on the label, or on the root element without one
    range: perm.child("label")?.contentRange ?? perm.nameRange,
  });
  return builder.output();
}
