// SObject record types: the interfaces object and field metadata declare in the Apex namespace.
import { docTag, jsDoc } from "../jsdoc.ts";
import type { TextBuilder, SourceRange } from "../text-builder.ts";
import { qualifyApex, registration, SOBJECTS_REGISTRY } from "./namespace.ts";

export interface SObjectProperty {
  name: string;
  /** TypeScript type, with Apex types referenced in the namespace they're declared in (see `qualifyApex`) */
  type: string;
  nameRange?: SourceRange | null;
  typeRange?: SourceRange | null;
  /** JSDoc lines */
  doc?: (string | undefined)[];
}

export interface SObjectInterface {
  name: string;
  nameRange?: SourceRange | null;
  /** JSDoc lines */
  doc?: (string | undefined)[];
  properties: SObjectProperty[];
}

/**
 * The standard fields of an object, by the kind its API name's suffix identifies. They match the types
 * the Salesforce extensions' SObject definitions (`.sfdx/tools/sobjects`) give them, since a property
 * declared in both must have the same type. Standard objects' fields vary, so only `Id` is declared.
 * `owned` is whether records have an owner, which children of a master-detail relationship
 * (`ControlledByParent` sharing) don't; only the owner's Id is declared (see below). The users who
 * created and last modified a record are `User`s in `apexNamespace`.
 */
export function standardFields(
  objectName: string,
  { owned, apexNamespace }: { owned: boolean; apexNamespace: string | null },
): SObjectProperty[] {
  const user = qualifyApex(apexNamespace, ["User"]);
  let fields: [string, string][];
  if (objectName.endsWith("__c")) {
    fields = [
      ["Id", "string"],
      ["Name", "string"],
      ["IsDeleted", "boolean"],
      ["CreatedById", "string"],
      ["CreatedBy", user],
      ["CreatedDate", "string"],
      ["LastModifiedById", "string"],
      ["LastModifiedBy", user],
      ["LastModifiedDate", "string"],
      ["SystemModstamp", "string"],
      // The owner (a user or a queue) is left to the SObject definition, whose type for it depends on the
      // org: its targets, when the project has the object's describe, and `SObject` otherwise.
      ...(owned ? ([["OwnerId", "string"]] satisfies [string, string][]) : []),
    ];
  } else if (objectName.endsWith("__mdt")) {
    fields = [
      ["Id", "string"],
      ["DeveloperName", "string"],
      ["MasterLabel", "string"],
      ["Label", "string"],
      ["Language", "string"],
      ["NamespacePrefix", "string"],
      ["QualifiedApiName", "string"],
      ["SystemModstamp", "string"],
    ];
  } else if (objectName.endsWith("__e")) {
    fields = [
      ["ReplayId", "string"],
      ["EventUuid", "string"],
      ["CreatedById", "string"],
      ["CreatedBy", user],
      ["CreatedDate", "string"],
    ];
  } else {
    fields = [["Id", "string"]];
  }
  return fields.map(([name, type]) => ({ name, type }));
}

/**
 * TypeScript types of field types, as LWC receives their values (see the Apex types in resolution.ts).
 * Lookups hold the related record's Id; their related records are declared separately.
 */
const FIELD_TYPES: Record<string, string> = {
  autonumber: "string",
  checkbox: "boolean",
  currency: "number",
  date: "string",
  datetime: "string",
  email: "string",
  encryptedtext: "string",
  hierarchy: "string",
  html: "string",
  lookup: "string",
  masterdetail: "string",
  metadatarelationship: "string",
  multiselectpicklist: "string",
  number: "number",
  percent: "number",
  phone: "string",
  picklist: "string",
  text: "string",
  textarea: "string",
  longtextarea: "string",
  time: "string",
  url: "string",
};

/**
 * The TypeScript type of a field, or undefined when it can't be known from the field alone (such as a
 * roll-up summary of a field's minimum) or the type isn't supported. Such fields are left undeclared
 * rather than risk a type that conflicts with the generated SObject definitions.
 */
export function fieldTsType(fieldType: string | undefined, summaryOperation: string | undefined): string | undefined {
  const type = fieldType?.toLowerCase();
  if (type === "summary") {
    const operation = summaryOperation?.toLowerCase();
    return operation === "count" || operation === "sum" ? "number" : undefined;
  }
  return type === undefined ? undefined : FIELD_TYPES[type];
}

/**
 * Documentation shared by a field's schema module and its Apex property: its description, and the
 * help text users see next to it.
 */
export function fieldDoc(description: string | undefined, inlineHelpText: string | undefined): (string | undefined)[] {
  return [docTag("description", description), docTag("inlineHelpText", inlineHelpText)];
}

/**
 * Declares SObject interfaces in the Apex namespace (or globally, when `namespace` is null). Interfaces
 * merge across files, so each object and field file declares the part of a type it knows about.
 */
export function addSObjectInterfaces(builder: TextBuilder, namespace: string | null, interfaces: SObjectInterface[]): void {
  const indent = namespace === null ? "" : "  ";
  if (namespace !== null) {
    builder.write(`declare namespace ${namespace} {\n`);
  }
  for (const { name, nameRange, doc, properties } of interfaces) {
    builder.write(`${jsDoc(indent, doc ?? [])}${indent}interface `);
    builder.writeMapped(name, nameRange ?? null);
    if (properties.length === 0) {
      builder.write(" {}\n");
      continue;
    }
    builder.write(" {\n");
    for (const property of properties) {
      builder.write(`${jsDoc(`${indent}  `, property.doc ?? [])}${indent}  `);
      builder.writeMapped(property.name, property.nameRange ?? null);
      builder.write("?: ");
      builder.writeMapped(property.type, property.typeRange ?? null);
      builder.write(";\n");
    }
    builder.write(`${indent}}\n`);
  }
  // every SObject registers, so references can look one up without an error when it isn't declared:
  // those whose names library types have shadow them (`Location`, over `System.Location`), and installed
  // packages' classes fall back to them
  if (interfaces.length > 0) {
    builder.write(
      registration(
        indent,
        SOBJECTS_REGISTRY,
        interfaces.map(({ name }) => name),
      ),
    );
  }
  if (namespace !== null) {
    builder.write("}\n");
  }
}
