import type { ConversionContext } from "../context.ts";
import type { Component, ConversionOutput } from "../types.ts";
import { importName, metadataName, recordName, splitNamespace } from "../names.ts";
import { qualifyApex } from "../apex/namespace.ts";
import { addSObjectInterfaces, fieldDoc, fieldTsType, type SObjectInterface } from "../apex/sobjects.ts";
import { schemaValueType, writeDefaultExportModule } from "../module-declaration.ts";
import { TextBuilder, type SourceRange } from "../text-builder.ts";
import { parseMetadataXml, type XmlElement } from "../xml.ts";

export function CustomField(component: Component, context: ConversionContext): ConversionOutput {
  const field = parseMetadataXml(component.content, "CustomField");
  const namespace = context.projectNamespace;
  // a field's file is in its object's `fields` folder: `objects/<Object>/fields/<Field>.field-meta.xml`
  const fileField = metadataName(component.path);
  const fileObject = component.path.split(/[\\/]/).at(-3);
  if (!fileObject) {
    throw new Error(`no object name in the file path ${component.path}`);
  }
  // LWC imports the field by its names without the project's namespace; records and the import's value
  // name the object and field with the namespace
  const objectName = importName(fileObject, namespace);
  const fieldName = importName(fileField, namespace);
  const objectApiName = recordName(objectName, namespace);
  const fieldApiName = recordName(fieldName, namespace);

  // go-to-definition lands on the field's name, or on the root element without one
  const nameRange = field.child("fullName")?.contentRange ?? field.nameRange;
  const doc = fieldDoc(field.childText("description"), field.childText("inlineHelpText"));

  const builder = new TextBuilder();
  writeDefaultExportModule(builder, {
    name: `@salesforce/schema/${objectName}.${fieldName}`,
    variable: fieldName,
    type: schemaValueType(objectApiName, fieldApiName),
    doc,
    range: nameRange,
  });

  const interfaces = sobjectInterfaces(field, {
    objectName: objectApiName,
    fieldName: fieldApiName,
    nameRange,
    doc,
    namespace,
    apexNamespace: context.apexNamespace,
  });
  if (interfaces.length > 0) {
    addSObjectInterfaces(builder, context.apexNamespace, interfaces);
  }
  return builder.output();
}

/**
 * The field's part of its object's record type: the field itself, and for a lookup its related record
 * and the parent's child relationship. Compound geolocation fields declare their latitude and longitude.
 * `objectName` and `fieldName` are API names, with the project's namespace (`namespace`) for custom ones;
 * the records it refers to are types in `apexNamespace`.
 */
function sobjectInterfaces(
  field: XmlElement,
  {
    objectName,
    fieldName,
    nameRange,
    doc,
    namespace,
    apexNamespace,
  }: {
    objectName: string;
    fieldName: string;
    nameRange: SourceRange | undefined;
    doc: (string | undefined)[];
    namespace: string | undefined;
    apexNamespace: string | null;
  },
): SObjectInterface[] {
  const fieldType = field.childText("type");
  const typeRange = field.child("type")?.contentRange;
  if (fieldType?.toLowerCase() === "location") {
    const base = fieldName.replace(/__c$/, "");
    return [
      {
        name: objectName,
        properties: ["Latitude", "Longitude"].map((part) => ({
          name: `${base}__${part}__s`,
          type: "number",
          nameRange,
          doc,
        })),
      },
    ];
  }
  const type = fieldTsType(fieldType, field.childText("summaryOperation"));
  if (type === undefined) {
    return [];
  }
  const properties = [{ name: fieldName, type, nameRange, typeRange, doc }];
  const interfaces: SObjectInterface[] = [{ name: objectName, properties }];

  const writtenReferenceTo = field.childText("referenceTo");
  const referenceTo = writtenReferenceTo && recordName(importName(writtenReferenceTo, namespace), namespace);
  const isRelationship = ["lookup", "masterdetail", "hierarchy"].includes(fieldType?.toLowerCase() ?? "");
  // Standard lookups (AccountId -> Account) name their relationships differently; only custom ones follow `__r`.
  if (isRelationship && referenceTo && fieldName.endsWith("__c")) {
    const referenceRange = field.child("referenceTo")?.contentRange;
    properties.push({
      name: fieldName.replace(/__c$/, "__r"),
      type: qualifyApex(apexNamespace, [referenceTo]),
      nameRange,
      typeRange: referenceRange,
      doc,
    });
    const relationshipName = field.childText("relationshipName");
    // A child relationship is in its field's namespace, as its fields are: the project's own, or an
    // installed package's (`dlrs__Log__c.dlrs__Parent__c` gives `dlrs__Children__r`), whatever the parent's.
    const relationshipNamespace = splitNamespace(fieldName).namespace;
    // the parent's records list their children; declaring the parent also makes the related record's type resolve
    interfaces.push({
      name: referenceTo,
      properties: relationshipName
        ? [
            {
              name: relationshipNamespace ? `${relationshipNamespace}__${relationshipName}__r` : `${relationshipName}__r`,
              type: `${qualifyApex(apexNamespace, [objectName])}[]`,
              nameRange: field.child("relationshipName")?.contentRange,
            },
          ]
        : [],
    });
  }
  return interfaces;
}
