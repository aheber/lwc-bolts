import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { fileImportName } from "../names.ts";
import { docTag } from "../jsdoc.ts";
import { writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml } from "../xml.ts";

export function StaticResource(component: Component, context: ConversionContext): ConversionOutput {
  const resource = parseMetadataXml(component.content, "StaticResource");
  // the project's own namespace is left out of imports; another's (an installed package's) is kept
  const resourceName = fileImportName(component, context.projectNamespace);
  const builder = new TextBuilder();
  writeDefaultExportModule(builder, {
    name: `@salesforce/resourceUrl/${resourceName}`,
    variable: resourceName,
    type: "string",
    doc: [docTag("description", resource.childText("description")), docTag("cacheControl", resource.childText("cacheControl"))],
    // go-to-definition lands on the description, or on the root element without one
    range: resource.child("description")?.contentRange ?? resource.nameRange,
  });
  return builder.output();
}
