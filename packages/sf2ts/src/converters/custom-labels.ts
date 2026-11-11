import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { TextBuilder } from "../text-builder.ts";
import { writeLabel } from "./custom-label.ts";
import { parseMetadataXml } from "../xml.ts";

export function CustomLabels(component: Component, context: ConversionContext): ConversionOutput {
  const builder = new TextBuilder();
  for (const label of parseMetadataXml(component.content, "CustomLabels").childrenNamed("labels")) {
    writeLabel(builder, label, context.projectNamespace);
  }
  return builder.output();
}
