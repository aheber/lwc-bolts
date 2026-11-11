import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { fileImportName } from "../names.ts";
import { writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml } from "../xml.ts";

export function ContentAsset(component: Component, context: ConversionContext): ConversionOutput {
  const asset = parseMetadataXml(component.content, "ContentAsset");
  // LWC imports content assets by developer name (the file name), not by the display masterLabel,
  // which may contain spaces and other characters that aren't valid in an identifier
  // the project's own namespace is left out of imports; another's (an installed package's) is kept
  const assetName = fileImportName(component, context.projectNamespace);
  const builder = new TextBuilder();
  writeDefaultExportModule(builder, {
    name: `@salesforce/contentAssetUrl/${assetName}`,
    variable: assetName,
    type: "string",
    // go-to-definition lands on the label, or on the root element without one
    range: asset.child("masterLabel")?.contentRange ?? asset.nameRange,
  });
  return builder.output();
}
