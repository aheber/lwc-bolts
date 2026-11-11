import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { importNameParts } from "../names.ts";
import { docParagraphs, docTag } from "../jsdoc.ts";
import { writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml, type XmlElement } from "../xml.ts";

export function CustomLabel(component: Component, context: ConversionContext): ConversionOutput {
  const label = parseMetadataXml(component.content, "CustomLabel");
  if (!label.childText("fullName")) {
    throw new Error("the label has no <fullName>");
  }
  const builder = new TextBuilder();
  writeLabel(builder, label, context.projectNamespace);
  return builder.output();
}

/**
 * Declares a label's module as `c.Name`, mapped to its `<fullName>`. Its value is a string in the user's language.
 * A label of another namespace (an installed package's, named `dlrs__Name`) is imported as `dlrs.Name`.
 */
export function writeLabel(builder: TextBuilder, label: XmlElement, projectNamespace: string | undefined): void {
  const fullName = label.child("fullName");
  if (fullName === undefined || fullName.text === "") {
    return;
  }
  const imported = importNameParts(fullName.text, projectNamespace);
  writeDefaultExportModule(builder, {
    name: `@salesforce/label/${imported.namespace ?? "c"}.${imported.name}`,
    variable: `lbl${imported.name}`,
    type: "string",
    doc: docParagraphs(quoted(label.childText("value") || undefined), docTag("description", label.childText("shortDescription"))),
    range: fullName.contentRange,
  });
}

/** A label's value in double quotes, so the documentation shows where it starts and ends. */
function quoted(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `"${value}"`;
}
