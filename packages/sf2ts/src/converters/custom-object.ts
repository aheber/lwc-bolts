import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { fileImportName, recordName } from "../names.ts";
import { qualifyApex } from "../apex/namespace.ts";
import { addSObjectInterfaces, standardFields } from "../apex/sobjects.ts";
import { docTag } from "../jsdoc.ts";
import { schemaValueType, writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder } from "../text-builder.ts";
import { parseMetadataXml } from "../xml.ts";

export function CustomObject(component: Component, context: ConversionContext): ConversionOutput {
  const obj = parseMetadataXml(component.content, "CustomObject");
  // LWC imports the object by its name without the project's namespace; records and the import's value
  // name it with the namespace
  const objectName = fileImportName(component, context.projectNamespace);
  const apiName = recordName(objectName, context.projectNamespace);

  // go-to-definition lands on the label, or on the root element without one
  const labelRange = obj.child("label")?.contentRange ?? obj.nameRange;
  const doc = [docTag("description", obj.childText("description"))];

  const builder = new TextBuilder();
  writeDefaultExportModule(builder, {
    name: `@salesforce/schema/${objectName}`,
    variable: objectName,
    type: schemaValueType(apiName),
    doc,
    range: labelRange,
  });

  // The object's record type, with its standard fields; each field file adds its own field.
  const properties = standardFields(objectName, {
    owned: obj.childText("sharingModel") !== "ControlledByParent",
    apexNamespace: context.apexNamespace,
  });
  const user = qualifyApex(context.apexNamespace, ["User"]);
  addSObjectInterfaces(builder, context.apexNamespace, [
    { name: apiName, nameRange: labelRange, doc, properties },
    // referenced by CreatedBy and LastModifiedBy; declared here so the reference always resolves
    ...(properties.some((p) => p.type === user) ? [{ name: "User", properties: [] }] : []),
  ]);
  return builder.output();
}
