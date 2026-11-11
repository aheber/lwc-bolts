// Caches installed packages' metadata from an org in the project, in the shape the content mapper reads a
// local copy: a folder for each namespace, with the Metadata API's names (`dlrs__RollupController.cls`,
// `lwc/dlrs__manageRollups`). Everything comes from queries of the org's setup objects, not a metadata
// retrieve: they cover every namespace at once, find what the Metadata API's list leaves out, and describe
// what a retrieve would hide or download. The org hides most managed source, so what's cached is what LWC in
// the project can use: global Apex (the generated declarations of its global members), exposed components
// (stubs), and the package's objects, fields, labels, resources, assets, channels and permissions, written
// as the metadata files the mapper reads, with only the elements it reads.
//
// It has no editor or CLI dependency: cacheManagedMetadata takes any connection that can query, such as the
// Salesforce CLI's, so the sf plugin and an editor command can both cache an org's packages. It's its own
// entry point, `@lwc-bolts/project-setup/managed`.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addInclude,
  contentMapperOptions,
  findProjectConfig,
  lwcFolderConfig,
  normalizePath,
  readPackageDirectories,
  type ProjectConfig,
} from "./index.ts";

export const DEFAULT_OUTPUT_DIR = "managed-apps";

/** A query's options, as the Salesforce CLI's connection (jsforce's) takes them. */
export interface QueryOptions {
  readonly autoFetch?: boolean;
  readonly maxFetch?: number;
}

/**
 * What caching needs of a connection to the org: SOQL queries, of the data and the Tooling APIs. The
 * Salesforce CLI's connection (`Org.getConnection()`, jsforce's) is one.
 */
export interface OrgConnection {
  query(soql: string, options?: QueryOptions): PromiseLike<{ readonly records: readonly object[] }>;
  readonly tooling: { query(soql: string, options?: QueryOptions): PromiseLike<{ readonly records: readonly object[] }> };
}

/** A data API query's records, as the type the query selects. */
async function query<T>(conn: OrgConnection, soql: string, options?: QueryOptions): Promise<{ records: T[] }> {
  return { records: [...(await conn.query(soql, options)).records] as T[] };
}

/** A Tooling API query's records, as the type the query selects. */
async function toolingQuery<T>(conn: OrgConnection, soql: string, options?: QueryOptions): Promise<{ records: T[] }> {
  return { records: [...(await conn.tooling.query(soql, options)).records] as T[] };
}

/** Why the cache can't be written, with a code for the caller to report it by. */
export class CacheError extends Error {
  readonly code: "NotSetUp" | "InvalidOutputDir" | "InvalidProjectConfig";

  constructor(message: string, code: CacheError["code"]) {
    super(message);
    this.name = "CacheError";
    this.code = code;
  }
}

const relative = (root: string, file: string) => normalizePath(path.relative(root, file));

/**
 * The content mapper's metadata types the cache has. Labels are a CustomLabels file. The tests check they're
 * all the mapper's `METADATA_TYPES`.
 */
export const CACHED_TYPES = [
  "ApexClass",
  "ContentAsset",
  "CustomField",
  "CustomLabels",
  "CustomObject",
  "CustomPermission",
  "LightningComponentBundle",
  "LightningMessageChannel",
  "StaticResource",
] as const;
export type CachedType = (typeof CACHED_TYPES)[number];

/** The types to cache: the ones the project's `disabledMetadataTypes` option doesn't turn off. */
export function cachedTypes(disabledMetadataTypes: readonly string[]): Set<CachedType> {
  const disabled = new Set(disabledMetadataTypes);
  return new Set(CACHED_TYPES.filter((type) => !disabled.has(type)));
}

/** What the Metadata API writes for managed source the subscriber can't see, and the ApexClass object has. */
const HIDDEN = "(hidden)";
const METADATA_NAMESPACE = "http://soap.sforce.com/2006/04/metadata";

/** One cached item: the files that make it, relative to its namespace's folder. */
export interface CachedItem {
  readonly namespace: string;
  readonly type: CachedType;
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  /** How many of the type it holds, when that isn't one: a CustomLabels file holds a namespace's labels. */
  readonly count?: number;
}

/** What a namespace has that can't be used outside its package, so isn't cached. */
export interface LeftOut {
  readonly namespace: string;
  readonly what: string;
  readonly count: number;
}

export interface Queried {
  readonly items: CachedItem[];
  readonly leftOut: LeftOut[];
}

/** Whether `namespace` is an installed package's to cache, rather than the org's own or one not asked for. */
export type IsManaged = (namespace: string) => boolean;

/**
 * The org's own namespaces, whose metadata is the org's rather than an installed package's: the one on its
 * Organization record, and `recorded`, one known otherwise, such as the one the Salesforce CLI recorded for it.
 */
export async function orgNamespaces(conn: OrgConnection, recorded?: string | null): Promise<Set<string>> {
  const namespaces = new Set<string>();
  if (recorded) {
    namespaces.add(recorded.toLowerCase());
  }
  try {
    const { records } = await query<{ NamespacePrefix: string | null }>(conn, "SELECT NamespacePrefix FROM Organization");
    if (records[0]?.NamespacePrefix) {
      namespaces.add(records[0].NamespacePrefix.toLowerCase());
    }
  } catch {
    // the recorded one is all there is
  }
  return namespaces;
}

/** Writes items into the namespaces' folders in `dir`. */
export function writeItems(dir: string, items: readonly CachedItem[]): void {
  for (const item of items) {
    for (const [file, content] of Object.entries(item.files)) {
      const destination = path.join(dir, item.namespace, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
  }
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An element, or nothing for a value that isn't set: `    <label>Log</label>\n`. */
function element(name: string, value: string | number | boolean | null | undefined, indent = "    "): string {
  return value === null || value === undefined || value === "" ? "" : `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`;
}

/** A metadata file: its root element of `type` with `body`, a string of elements. */
function metadataXml(type: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="${METADATA_NAMESPACE}">\n${body}</${type}>\n`;
}

/** Counts by namespace, as left-out entries for `what`. */
function leftOutCounts(namespaces: readonly string[], what: string): LeftOut[] {
  const counts = new Map<string, number>();
  namespaces.forEach((namespace) => counts.set(namespace, (counts.get(namespace) ?? 0) + 1));
  return [...counts].map(([namespace, count]) => ({ namespace, what, count }));
}

/** Runs `query` for each chunk of `values`, which an `IN (...)` filter takes: a query has a length limit. */
async function inChunks<T, R>(values: readonly T[], size: number, query: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < values.length; i += size) {
    results.push(...(await query(values.slice(i, i + size))));
  }
  return results;
}

const quoted = (values: readonly string[]) => values.map((value) => `'${value.replace(/'/g, "\\'")}'`).join(",");

export interface ApexClassRecord {
  Name: string;
  NamespacePrefix: string;
  ApiVersion: number;
  Status: string;
  Body: string | null;
}

/**
 * The installed packages' Apex classes, from the ApexClass object. A global class's body is generated, the
 * declarations of its global members (with their annotations, and `return null;` bodies), as a retrieve
 * gives it; every other class's is `(hidden)`, and LWC can't import those anyway, so they're only counted.
 */
export async function managedClasses(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await query<ApexClassRecord>(
    conn,
    "SELECT Name, NamespacePrefix, ApiVersion, Status, Body FROM ApexClass WHERE NamespacePrefix != null ORDER BY NamespacePrefix, Name",
    { autoFetch: true, maxFetch: 100_000 },
  );
  const managed = records.filter((record) => isManaged(record.NamespacePrefix));
  const hidden = managed.filter((record) => record.Body === null || record.Body.trim() === HIDDEN);
  return {
    items: managed.filter((record) => !hidden.includes(record)).map(classItem),
    leftOut: leftOutCounts(
      hidden.map((record) => record.NamespacePrefix),
      "Apex classes that aren't global, whose source is hidden",
    ),
  };
}

/** A class as the mapper reads a cached one: `classes/<ns>__<name>.cls` and its `-meta.xml`. */
export function classItem(record: ApexClassRecord): CachedItem {
  const name = `${record.NamespacePrefix}__${record.Name}`;
  return {
    namespace: record.NamespacePrefix,
    type: "ApexClass",
    name,
    files: {
      [`classes/${name}.cls`]: record.Body!,
      [`classes/${name}.cls-meta.xml`]: metadataXml(
        "ApexClass",
        element("apiVersion", record.ApiVersion.toFixed(1)) + element("status", record.Status),
      ),
    },
  };
}

/** An exposed component of an installed package, as the Tooling API describes it: its source is hidden. */
export interface ExposedComponent {
  readonly namespace: string;
  readonly name: string;
  readonly apiVersion?: number;
  readonly masterLabel?: string;
  readonly description?: string;
  readonly targets: readonly string[];
  /** Its `targetConfigs` properties, which are among its public (`@api`) properties. */
  readonly properties: readonly string[];
}

interface BundleRecord {
  Id: string;
  DeveloperName: string;
  NamespacePrefix: string;
  IsExposed: boolean;
}

interface BundleMetadata {
  apiVersion?: number;
  masterLabel?: string;
  description?: string | null;
  targets?: { target?: string[] | string } | null;
  targetConfigs?: unknown;
}

/**
 * The installed packages' components, from the Tooling API. Retrieving one gives `(hidden)` for every file,
 * its `.js-meta.xml` too, but the Tooling API says whether it's exposed, and its targets and target configs.
 * Only exposed components can be used outside their package, so only theirs are cached, as stubs (see
 * componentItem); the others are counted.
 */
export async function managedComponents(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await toolingQuery<BundleRecord>(
    conn,
    "SELECT Id, DeveloperName, NamespacePrefix, IsExposed FROM LightningComponentBundle WHERE NamespacePrefix != null",
    { autoFetch: true },
  );
  const managed = records.filter((record) => isManaged(record.NamespacePrefix));
  const items: CachedItem[] = [];
  for (const record of managed.filter((each) => each.IsExposed)) {
    const namespace = record.NamespacePrefix;
    // the Tooling API only returns Metadata one record at a time
    const { records: described } = await toolingQuery<{ Metadata: BundleMetadata }>(
      conn,
      `SELECT Metadata FROM LightningComponentBundle WHERE Id = '${record.Id}'`,
    );
    const metadata = described[0]?.Metadata ?? {};
    items.push(
      componentItem({
        namespace,
        name: record.DeveloperName,
        ...(metadata.apiVersion !== undefined && { apiVersion: metadata.apiVersion }),
        ...(metadata.masterLabel && { masterLabel: metadata.masterLabel }),
        ...(metadata.description && { description: metadata.description }),
        targets: [metadata.targets?.target ?? []].flat(),
        properties: propertyNames(metadata.targetConfigs),
      }),
    );
  }
  return {
    items,
    leftOut: leftOutCounts(
      managed.filter((record) => !record.IsExposed).map((record) => record.NamespacePrefix),
      "components that aren't exposed",
    ),
  };
}

/** The `property` names anywhere in a component's target configs. */
function propertyNames(targetConfigs: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, inProperty: boolean) => {
    if (Array.isArray(value)) {
      value.forEach((each) => visit(each, inProperty));
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (inProperty && typeof record.name === "string" && /^[A-Za-z_$][\w$]*$/.test(record.name)) {
        names.add(record.name);
      }
      for (const [key, child] of Object.entries(record)) {
        visit(child, key === "property");
      }
    }
  };
  visit(targetConfigs, false);
  return [...names];
}

/**
 * An exposed component as the mapper reads a cached one (`lwc/<ns>__<name>`): its `.js-meta.xml`, and a stub
 * module whose `@api` properties are the ones its target configs name. Its other public properties, methods
 * and events are unknown, as its source is hidden.
 */
export function componentItem(component: ExposedComponent): CachedItem {
  const name = `${component.namespace}__${component.name}`;
  const targets =
    component.targets.length > 0
      ? `    <targets>\n${component.targets.map((target) => element("target", target, "        ")).join("")}    </targets>\n`
      : "";
  const className = component.name[0]!.toUpperCase() + component.name.slice(1);
  const properties = component.properties.map((property) => `  @api ${property};\n`).join("");
  return {
    namespace: component.namespace,
    type: "LightningComponentBundle",
    name: `${component.namespace}/${component.name}`,
    files: {
      [`lwc/${name}/${name}.js-meta.xml`]: metadataXml(
        "LightningComponentBundle",
        element("apiVersion", component.apiVersion?.toFixed(1)) +
          element("description", component.description) +
          element("isExposed", true) +
          element("masterLabel", component.masterLabel) +
          targets,
      ),
      [`lwc/${name}/${name}.js`]:
        `// A stub of an installed package's exposed component, written by "sf lwc-bolts project managed retrieve": its\n` +
        `// source is hidden, so only the public properties its target configs name are known.\n` +
        `import { LightningElement${properties ? ", api" : ""} } from "lwc";\n\n` +
        `export default class ${className} extends LightningElement {\n${properties}}\n`,
    },
  };
}

interface CustomObjectRecord {
  Id: string;
  NamespacePrefix: string;
  Description: string | null;
  SharingModel: string | null;
}

interface EntityRecord {
  DurableId: string;
  QualifiedApiName: string;
  Label: string | null;
  PluralLabel: string | null;
}

interface CustomFieldRecord {
  Id: string;
  TableEnumOrId: string;
  EntityDefinitionId: string;
  DeveloperName: string;
  NamespacePrefix: string;
  Description: string | null;
  InlineHelpText: string | null;
  SummaryOperation: string | null;
}

interface FieldDefinitionRecord {
  EntityDefinitionId: string;
  QualifiedApiName: string;
  Label: string | null;
  DataType: string;
  ValueTypeId: string | null;
  ReferenceTo: { referenceTo: string[] | null } | null;
}

/** A field's metadata, as the Tooling API gives it one record at a time: what the other queries don't have. */
interface FieldMetadata {
  type?: string | null;
  referenceTo?: string | null;
  relationshipName?: string | null;
}

/** An installed package's field: the parts of its metadata the mapper reads. */
export interface ManagedField {
  readonly namespace: string;
  /** Its object's API name, which may be another namespace's, or a standard object's (`Account`). */
  readonly object: string;
  /** Its API name, `dlrs__Error__c`. */
  readonly name: string;
  readonly label?: string;
  /** Its metadata type, such as `Text`, `Lookup` or `Summary`. */
  readonly type?: string;
  readonly summaryOperation?: string;
  readonly referenceTo?: string;
  /** A lookup's child relationship, without the namespace: `Children` for `dlrs__Children__r`. */
  readonly relationshipName?: string;
  readonly description?: string;
  readonly inlineHelpText?: string;
}

/**
 * Field metadata types for FieldDefinition's `DataType`, which describes a type as Setup shows it: `Text(255)`,
 * `Lookup(Account)`, `Roll-Up Summary (COUNT Line)`. More specific ones come first (`Text Area` before `Text`).
 */
const DATA_TYPES: readonly (readonly [RegExp, string])[] = [
  [/^Lookup\b/, "Lookup"],
  [/^Master-Detail\b/, "MasterDetail"],
  [/^Hierarchy\b/, "Hierarchy"],
  [/^External Lookup\b/, "ExternalLookup"],
  [/^Indirect Lookup\b/, "IndirectLookup"],
  [/^Metadata Relationship\b/, "MetadataRelationship"],
  [/^Roll-Up Summary\b/, "Summary"],
  [/^Auto Number\b/, "AutoNumber"],
  [/^Picklist \(Multi-Select\)/, "MultiselectPicklist"],
  [/^Picklist\b/, "Picklist"],
  [/^Long Text Area\b/, "LongTextArea"],
  [/^Rich Text Area\b/, "Html"],
  [/^Text Area\b/, "TextArea"],
  [/^Text \(Encrypted\)/, "EncryptedText"],
  [/^Text\b/, "Text"],
  [/^Date\/Time\b/, "DateTime"],
  [/^Date\b/, "Date"],
  [/^Time\b/, "Time"],
  [/^Checkbox\b/, "Checkbox"],
  [/^Number\b/, "Number"],
  [/^Currency\b/, "Currency"],
  [/^Percent\b/, "Percent"],
  [/^Email\b/, "Email"],
  [/^Phone\b/, "Phone"],
  [/^URL\b/, "Url"],
  [/^Geolocation\b/, "Location"],
];

/** Metadata types for a FieldDefinition `ValueTypeId`, for a `DataType` that isn't one of DATA_TYPES. */
const VALUE_TYPES: Readonly<Record<string, string>> = {
  boolean: "Checkbox",
  date: "Date",
  datetime: "DateTime",
  double: "Number",
  id: "Lookup",
  int: "Number",
  long: "Number",
  string: "Text",
  time: "Time",
};

/**
 * A field's metadata type for its FieldDefinition `DataType`. A formula field's is the type of its result, as
 * in its metadata (`Formula (Checkbox)` is `Checkbox`).
 */
export function fieldMetadataType(dataType: string, valueTypeId?: string | null): string | undefined {
  const formula = /^Formula \((.*)\)$/.exec(dataType.trim());
  const described = (formula?.[1] ?? dataType).trim();
  return DATA_TYPES.find(([pattern]) => pattern.test(described))?.[1] ?? (valueTypeId ? VALUE_TYPES[valueTypeId.toLowerCase()] : undefined);
}

/** A lookup that has a child relationship: a custom field of a relationship type. */
const isCustomLookup = (field: ManagedField) => field.name.endsWith("__c") && /^(Lookup|MasterDetail|Hierarchy)$/.test(field.type ?? "");

/**
 * The installed packages' objects and fields, from the Tooling API's setup objects rather than describes,
 * which only show what the running user can access. CustomObject and CustomField have the descriptions,
 * help text, sharing models and rollup operations; EntityDefinition the objects' names and labels;
 * FieldDefinition the fields' labels, types and references. A lookup's child relationship name is only in
 * its metadata, which the Tooling API returns one field at a time.
 */
export async function managedSchema(
  conn: OrgConnection,
  isManaged: IsManaged,
  { objects: withObjects, fields: withFields }: { objects: boolean; fields: boolean },
): Promise<Queried> {
  const objectRecords = (
    await toolingQuery<CustomObjectRecord>(
      conn,
      "SELECT Id, NamespacePrefix, Description, SharingModel FROM CustomObject WHERE NamespacePrefix != null",
      { autoFetch: true, maxFetch: 50_000 },
    )
  ).records.filter((record) => isManaged(record.NamespacePrefix));
  const fieldRecords = withFields
    ? (
        await toolingQuery<CustomFieldRecord>(
          conn,
          "SELECT Id, TableEnumOrId, EntityDefinitionId, DeveloperName, NamespacePrefix, Description, InlineHelpText, SummaryOperation " +
            "FROM CustomField WHERE NamespacePrefix != null",
          { autoFetch: true, maxFetch: 100_000 },
        )
      ).records.filter((record) => isManaged(record.NamespacePrefix))
    : [];

  // EntityDefinition's ids are 15 characters; a custom object's field has its object's id as TableEnumOrId
  const id15 = (id: string) => id.slice(0, 15);
  const entityIds = [
    ...new Set([
      ...(withObjects ? objectRecords.map((record) => id15(record.Id)) : []),
      ...fieldRecords.map((record) => record.EntityDefinitionId),
    ]),
  ];
  // EntityDefinition doesn't support queryMore, so each chunk must fit in one batch
  const entities = new Map(
    (
      await inChunks(
        entityIds,
        200,
        async (chunk) =>
          (
            await toolingQuery<EntityRecord>(
              conn,
              `SELECT DurableId, QualifiedApiName, Label, PluralLabel FROM EntityDefinition WHERE DurableId IN (${quoted(chunk)})`,
            )
          ).records,
      )
    ).map((entity) => [entity.DurableId, entity]),
  );

  const items: CachedItem[] = [];
  if (withObjects) {
    for (const record of objectRecords) {
      const entity = entities.get(id15(record.Id));
      if (entity !== undefined) {
        items.push(
          objectItem({
            namespace: record.NamespacePrefix,
            name: entity.QualifiedApiName,
            label: entity.Label,
            pluralLabel: entity.PluralLabel,
            description: record.Description,
            sharingModel: record.SharingModel,
          }),
        );
      }
    }
  }
  if (fieldRecords.length === 0) {
    return { items, leftOut: [] };
  }

  const definitions = new Map(
    (
      await inChunks(
        [...new Set(fieldRecords.map((record) => record.EntityDefinitionId))],
        20,
        async (chunk) =>
          (
            await toolingQuery<FieldDefinitionRecord>(
              conn,
              "SELECT EntityDefinitionId, QualifiedApiName, Label, DataType, ValueTypeId, ReferenceTo FROM FieldDefinition " +
                `WHERE EntityDefinitionId IN (${quoted(chunk)})`,
              { autoFetch: true, maxFetch: 100_000 },
            )
          ).records,
      )
    ).map((definition) => [`${definition.EntityDefinitionId}.${definition.QualifiedApiName}`, definition]),
  );
  const fields = fieldRecords.map((record) => {
    const name = `${record.NamespacePrefix}__${record.DeveloperName}__c`;
    const definition = definitions.get(`${record.EntityDefinitionId}.${name}`);
    const type = definition && fieldMetadataType(definition.DataType, definition.ValueTypeId);
    const field: ManagedField = {
      namespace: record.NamespacePrefix,
      object: entities.get(record.EntityDefinitionId)?.QualifiedApiName ?? record.TableEnumOrId,
      name,
      ...(definition?.Label && { label: definition.Label }),
      ...(type && { type }),
      ...(record.SummaryOperation && { summaryOperation: record.SummaryOperation }),
      ...(definition?.ReferenceTo?.referenceTo?.[0] && { referenceTo: definition.ReferenceTo.referenceTo[0] }),
      ...(record.Description && { description: record.Description }),
      ...(record.InlineHelpText && { inlineHelpText: record.InlineHelpText }),
    };
    return { record, field };
  });
  // a few at a time, as each lookup is a query of its own
  const described: ManagedField[] = [];
  const lookups = fields.filter(({ field }) => isCustomLookup(field));
  for (let i = 0; i < lookups.length; i += 5) {
    described.push(
      ...(await Promise.all(
        lookups.slice(i, i + 5).map(async ({ record, field }) => {
          const { records } = await toolingQuery<{ Metadata: FieldMetadata | null }>(
            conn,
            `SELECT Metadata FROM CustomField WHERE Id = '${record.Id}'`,
          );
          const metadata = records[0]?.Metadata ?? {};
          return {
            ...field,
            ...(metadata.type && { type: metadata.type }),
            ...(metadata.referenceTo && { referenceTo: metadata.referenceTo }),
            ...(metadata.relationshipName && { relationshipName: metadata.relationshipName }),
          };
        }),
      )),
    );
  }
  const byName = new Map(described.map((field) => [`${field.object}.${field.name}`, field]));
  items.push(...fields.map(({ field }) => fieldItem(byName.get(`${field.object}.${field.name}`) ?? field)));
  return { items, leftOut: [] };
}

/** An object as the mapper reads a cached one: `objects/<name>/<name>.object-meta.xml`. */
export function objectItem(object: {
  namespace: string;
  name: string;
  label?: string | null;
  pluralLabel?: string | null;
  description?: string | null;
  sharingModel?: string | null;
}): CachedItem {
  return {
    namespace: object.namespace,
    type: "CustomObject",
    name: object.name,
    files: {
      [`objects/${object.name}/${object.name}.object-meta.xml`]: metadataXml(
        "CustomObject",
        element("description", object.description) +
          element("label", object.label) +
          element("pluralLabel", object.pluralLabel) +
          element("sharingModel", object.sharingModel),
      ),
    },
  };
}

/** A field as the mapper reads a cached one: `objects/<object>/fields/<name>.field-meta.xml`. */
export function fieldItem(field: ManagedField): CachedItem {
  return {
    namespace: field.namespace,
    type: "CustomField",
    name: `${field.object}.${field.name}`,
    files: {
      [`objects/${field.object}/fields/${field.name}.field-meta.xml`]: metadataXml(
        "CustomField",
        element("fullName", field.name) +
          element("description", field.description) +
          element("inlineHelpText", field.inlineHelpText) +
          element("label", field.label) +
          element("referenceTo", field.referenceTo) +
          element("relationshipName", field.relationshipName) +
          element("summaryOperation", field.summaryOperation) +
          element("type", field.type),
      ),
    },
  };
}

export interface ExternalStringRecord {
  Name: string;
  NamespacePrefix: string;
  MasterLabel: string | null;
  Value: string | null;
  Category: string | null;
  Language: string | null;
  IsProtected: boolean;
}

/**
 * The installed packages' labels, from the Tooling API's ExternalString, as a CustomLabels file for each
 * namespace. A package's protected labels can't be used outside it, so they're only counted.
 */
export async function managedLabels(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await toolingQuery<ExternalStringRecord>(
    conn,
    "SELECT Name, NamespacePrefix, MasterLabel, Value, Category, Language, IsProtected FROM ExternalString WHERE NamespacePrefix != null",
    { autoFetch: true, maxFetch: 100_000 },
  );
  const managed = records.filter((record) => isManaged(record.NamespacePrefix));
  const byNamespace = new Map<string, ExternalStringRecord[]>();
  for (const record of managed.filter((each) => !each.IsProtected)) {
    byNamespace.set(record.NamespacePrefix, [...(byNamespace.get(record.NamespacePrefix) ?? []), record]);
  }
  return {
    items: [...byNamespace].map(([namespace, labels]) => labelsItem(namespace, labels)),
    leftOut: leftOutCounts(
      managed.filter((record) => record.IsProtected).map((record) => record.NamespacePrefix),
      "protected labels",
    ),
  };
}

/** A namespace's labels as the mapper reads cached ones: `labels/CustomLabels.labels-meta.xml`, with `<ns>__<name>`s. */
export function labelsItem(namespace: string, labels: readonly ExternalStringRecord[]): CachedItem {
  const body = labels
    .map(
      (label) =>
        "    <labels>\n" +
        element("fullName", `${label.NamespacePrefix}__${label.Name}`, "        ") +
        element("categories", label.Category, "        ") +
        element("language", label.Language, "        ") +
        element("protected", false, "        ") +
        element("shortDescription", label.MasterLabel, "        ") +
        element("value", label.Value, "        ") +
        "    </labels>\n",
    )
    .join("");
  return {
    namespace,
    type: "CustomLabels",
    name: "CustomLabels",
    count: labels.length,
    files: { "labels/CustomLabels.labels-meta.xml": metadataXml("CustomLabels", body) },
  };
}

/** The installed packages' custom permissions, from the CustomPermission object. */
export async function managedPermissions(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await query<{
    DeveloperName: string;
    NamespacePrefix: string;
    MasterLabel: string | null;
    Description: string | null;
  }>(conn, "SELECT DeveloperName, NamespacePrefix, MasterLabel, Description FROM CustomPermission WHERE NamespacePrefix != null", {
    autoFetch: true,
    maxFetch: 50_000,
  });
  return {
    items: records
      .filter((record) => isManaged(record.NamespacePrefix))
      .map((record) => {
        const name = `${record.NamespacePrefix}__${record.DeveloperName}`;
        return {
          namespace: record.NamespacePrefix,
          type: "CustomPermission",
          name,
          files: {
            [`customPermissions/${name}.customPermission-meta.xml`]: metadataXml(
              "CustomPermission",
              element("description", record.Description) + element("label", record.MasterLabel),
            ),
          },
        };
      }),
    leftOut: [],
  };
}

/** The installed packages' message channels and their fields, from the Tooling API. */
export async function managedChannels(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const channels = (
    await toolingQuery<{
      Id: string;
      DeveloperName: string;
      NamespacePrefix: string;
      IsExposed: boolean;
      MasterLabel: string | null;
      Description: string | null;
    }>(
      conn,
      "SELECT Id, DeveloperName, NamespacePrefix, IsExposed, MasterLabel, Description FROM LightningMessageChannel WHERE NamespacePrefix != null",
      {
        autoFetch: true,
      },
    )
  ).records.filter((record) => isManaged(record.NamespacePrefix));
  const fields = await inChunks(
    channels.map((channel) => channel.Id),
    200,
    async (chunk) =>
      (
        await toolingQuery<{ LightningMessageChannelId: string; FieldName: string; Description: string | null }>(
          conn,
          `SELECT LightningMessageChannelId, FieldName, Description FROM LightningMessageField WHERE LightningMessageChannelId IN (${quoted(chunk)})`,
          { autoFetch: true },
        )
      ).records,
  );
  return {
    items: channels.map((channel) => {
      const name = `${channel.NamespacePrefix}__${channel.DeveloperName}`;
      const channelFields = fields
        .filter((field) => field.LightningMessageChannelId.slice(0, 15) === channel.Id.slice(0, 15))
        .map(
          (field) =>
            "    <lightningMessageFields>\n" +
            element("description", field.Description, "        ") +
            element("fieldName", field.FieldName, "        ") +
            "    </lightningMessageFields>\n",
        )
        .join("");
      return {
        namespace: channel.NamespacePrefix,
        type: "LightningMessageChannel",
        name,
        files: {
          [`messageChannels/${name}.messageChannel-meta.xml`]: metadataXml(
            "LightningMessageChannel",
            element("description", channel.Description) +
              element("isExposed", channel.IsExposed) +
              channelFields +
              element("masterLabel", channel.MasterLabel),
          ),
        },
      };
    }),
    leftOut: [],
  };
}

/**
 * The installed packages' static resources, from the StaticResource object, without their content: the
 * mapper only reads the `-meta.xml`, and the content can be large, or JavaScript that the cache's include
 * would have TypeScript check. SDR, which the mapper finds metadata with, still needs a content file, so
 * each gets an empty one.
 */
export async function managedResources(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await query<{
    Name: string;
    NamespacePrefix: string;
    ContentType: string | null;
    Description: string | null;
    CacheControl: string | null;
  }>(conn, "SELECT Name, NamespacePrefix, ContentType, Description, CacheControl FROM StaticResource WHERE NamespacePrefix != null", {
    autoFetch: true,
    maxFetch: 50_000,
  });
  return {
    items: records
      .filter((record) => isManaged(record.NamespacePrefix))
      .map((record) => {
        const name = `${record.NamespacePrefix}__${record.Name}`;
        return {
          namespace: record.NamespacePrefix,
          type: "StaticResource",
          name,
          files: {
            [`staticresources/${name}.resource-meta.xml`]: metadataXml(
              "StaticResource",
              element("cacheControl", record.CacheControl) +
                element("contentType", record.ContentType) +
                element("description", record.Description),
            ),
            [`staticresources/${name}.resource`]: "",
          },
        };
      }),
    leftOut: [],
  };
}

/** The installed packages' content assets, from the ContentAsset object, with an empty content file as resources have. */
export async function managedAssets(conn: OrgConnection, isManaged: IsManaged): Promise<Queried> {
  const { records } = await query<{ DeveloperName: string; NamespacePrefix: string; MasterLabel: string | null }>(
    conn,
    "SELECT DeveloperName, NamespacePrefix, MasterLabel FROM ContentAsset WHERE NamespacePrefix != null",
    { autoFetch: true, maxFetch: 50_000 },
  );
  return {
    items: records
      .filter((record) => isManaged(record.NamespacePrefix))
      .map((record) => {
        const name = `${record.NamespacePrefix}__${record.DeveloperName}`;
        return {
          namespace: record.NamespacePrefix,
          type: "ContentAsset",
          name,
          files: {
            [`contentassets/${name}.asset-meta.xml`]: metadataXml("ContentAsset", element("masterLabel", record.MasterLabel)),
            [`contentassets/${name}.asset`]: "",
          },
        };
      }),
    leftOut: [],
  };
}

/**
 * Checks the cache folder is one the command can replace namespace folders in: a folder of the project's
 * own, outside its package directories (deploys would include it) and not containing one.
 */
export function checkOutputDir(root: string, outputDir: string): string {
  const absolute = path.resolve(root, outputDir);
  const fromRoot = normalizePath(path.relative(root, absolute));
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || path.isAbsolute(fromRoot)) {
    throw new CacheError(`The cache folder must be a folder in the project, but ${outputDir} isn't.`, "InvalidOutputDir");
  }
  for (const directory of readPackageDirectories(root) ?? []) {
    if (fromRoot === directory || fromRoot.startsWith(`${directory}/`) || directory.startsWith(`${fromRoot}/`)) {
      throw new CacheError(
        `The cache folder must be outside the package directories, so deploys leave it alone, but ${fromRoot} and ${directory} overlap.`,
        "InvalidOutputDir",
      );
    }
  }
  return absolute;
}

/** A staging folder in the system's temp folder, from which the namespaces' folders replace the cache's. */
export function stagingDir(): string {
  return mkdtempSync(path.join(tmpdir(), "lwc-bolts-managed-"));
}

export interface InstallResult {
  /** The `lwc` folders that got a config referencing the project config. */
  readonly lwcConfigs: readonly string[];
  /** Whether the cache folder was added to the project config's `include`. */
  readonly included: boolean;
}

/**
 * Replaces each staged namespace's folder in the cache, gives each cached `lwc` folder a config that
 * references the project config (so a cached component opens in the project), and adds the cache to the
 * project config's `include`.
 */
export function installCache(
  root: string,
  project: ProjectConfig,
  outputDir: string,
  staging: string,
  namespaces: readonly string[],
): InstallResult {
  mkdirSync(outputDir, { recursive: true });
  for (const namespace of namespaces) {
    const destination = path.join(outputDir, namespace);
    rmSync(destination, { recursive: true, force: true });
    const staged = path.join(staging, namespace);
    if (existsSync(staged)) {
      cpSync(staged, destination, { recursive: true });
    }
  }
  const lwcConfigs: string[] = [];
  for (const namespace of readdirSync(outputDir, { withFileTypes: true })) {
    const folder = path.join(outputDir, namespace.name, "lwc");
    if (namespace.isDirectory() && !namespace.name.startsWith(".") && existsSync(folder)) {
      const file = path.join(folder, project.file);
      writeFileSync(file, lwcFolderConfig(folder, project.path)!);
      lwcConfigs.push(file);
    }
  }
  const text = addInclude(project.text, project.folder, root, relative(root, outputDir));
  if (text === undefined) {
    throw new CacheError(
      `${relative(root, project.path)} isn't valid JSON, so the cache wasn't added to its include.`,
      "InvalidProjectConfig",
    );
  }
  if (text !== project.text) {
    writeFileSync(project.path, text);
  }
  return { lwcConfigs, included: text !== project.text };
}

/** What was cached for a namespace, and what wasn't. */
export interface NamespaceReport {
  readonly namespace: string;
  /** How many of each type were cached. */
  readonly cached: Partial<Record<CachedType, number>>;
  /** What can't be used outside the package, so wasn't cached. */
  readonly leftOut: { readonly what: string; readonly count: number }[];
  /** Exposed components, cached as stubs (`dlrs/manageRollups`): their source is hidden. */
  readonly componentStubs: string[];
}

export interface CacheOptions {
  /** The cache folder, relative to the project: DEFAULT_OUTPUT_DIR unless given. */
  readonly outputDir?: string;
  /** Only these namespaces; other namespaces' folders are left as they are. Every one but the org's otherwise. */
  readonly namespaces?: readonly string[];
  /** The org's own namespaces, whose metadata isn't cached (see orgNamespaces). */
  readonly orgNamespaces: Iterable<string>;
  /** Called as each kind of metadata is queried, such as "Apex classes", to show progress. */
  readonly onProgress?: (what: string) => void;
}

export interface CacheResult {
  /** The cache folder. */
  readonly outputDir: string;
  /** The project config the cache was added to. */
  readonly projectConfig: string;
  readonly namespaces: NamespaceReport[];
  /** The cached `lwc` folders' configs, which reference the project config. */
  readonly lwcConfigs: readonly string[];
  /** Whether the cache was added to the project config's `include`. */
  readonly included: boolean;
  /** Folders of namespaces the org has none of the cached types in, when every namespace was cached: uninstalled packages, perhaps. */
  readonly staleNamespaces: string[];
  /** The queries that failed; the others' metadata is still cached. */
  readonly failures: { readonly what: string; readonly message: string }[];
}

/** The queries, each for the types it caches; one that fails is reported, and the others still run. */
const QUERIES: readonly {
  readonly types: readonly CachedType[];
  readonly what: string;
  readonly query: (conn: OrgConnection, isManaged: IsManaged, types: ReadonlySet<CachedType>) => Promise<Queried>;
}[] = [
  { types: ["ApexClass"], what: "Apex classes", query: managedClasses },
  { types: ["LightningComponentBundle"], what: "components", query: managedComponents },
  {
    types: ["CustomObject", "CustomField"],
    what: "objects and fields",
    query: (conn, isManaged, types) =>
      managedSchema(conn, isManaged, { objects: types.has("CustomObject"), fields: types.has("CustomField") }),
  },
  { types: ["CustomLabels"], what: "labels", query: managedLabels },
  { types: ["CustomPermission"], what: "custom permissions", query: managedPermissions },
  { types: ["LightningMessageChannel"], what: "message channels", query: managedChannels },
  { types: ["StaticResource"], what: "static resources", query: managedResources },
  { types: ["ContentAsset"], what: "content assets", query: managedAssets },
];

/**
 * Caches the installed packages' metadata from the org `conn` connects to in the SFDX project at `root`:
 * every namespace but the org's own (or only `namespaces`), the types the content mapper reads that the
 * project's `disabledMetadataTypes` option doesn't turn off. Each namespace's folder in the cache is
 * replaced, each cached `lwc` folder gets a config that references the project config, and the cache is
 * added to the project config's `include`. Throws a CacheError when the project isn't set up or the cache
 * folder can't be used.
 */
export async function cacheManagedMetadata(root: string, conn: OrgConnection, options: CacheOptions): Promise<CacheResult> {
  const project = findProjectConfig(root);
  if (project === undefined) {
    throw new CacheError(`${path.basename(root)} isn't set up for the content mapper: no lwc folder config registers it.`, "NotSetUp");
  }
  const outputDir = checkOutputDir(root, options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const configured = contentMapperOptions(project.text) ?? {};
  const disabled = Array.isArray(configured.disabledMetadataTypes)
    ? configured.disabledMetadataTypes.filter((type): type is string => typeof type === "string")
    : [];
  const types = cachedTypes(disabled);
  const own = new Set([...options.orgNamespaces].map((namespace) => namespace.toLowerCase()));
  const wanted = options.namespaces?.map((namespace) => namespace.toLowerCase());
  const isManaged = (namespace: string) =>
    !own.has(namespace.toLowerCase()) && (wanted === undefined || wanted.includes(namespace.toLowerCase()));

  const items: CachedItem[] = [];
  const leftOut: LeftOut[] = [];
  const failures: { what: string; message: string }[] = [];
  for (const { types: queried, what, query } of QUERIES) {
    if (!queried.some((type) => types.has(type))) {
      continue;
    }
    options.onProgress?.(what);
    try {
      const result = await query(conn, isManaged, types);
      items.push(...result.items);
      leftOut.push(...result.leftOut);
    } catch (error) {
      failures.push({ what, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const namespaces = [...new Set([...items, ...leftOut].map((entry) => entry.namespace))].sort();
  const reports = namespaces.map((namespace): NamespaceReport => {
    const cached: Partial<Record<CachedType, number>> = {};
    for (const item of items.filter((each) => each.namespace === namespace)) {
      cached[item.type] = (cached[item.type] ?? 0) + (item.count ?? 1);
    }
    return {
      namespace,
      cached,
      leftOut: leftOut.filter((entry) => entry.namespace === namespace).map(({ what, count }) => ({ what, count })),
      componentStubs: items
        .filter((item) => item.namespace === namespace && item.type === "LightningComponentBundle")
        .map((item) => item.name),
    };
  });

  const staging = stagingDir();
  let install;
  try {
    writeItems(staging, items);
    install = installCache(root, project, outputDir, staging, namespaces);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const staleNamespaces =
    wanted === undefined
      ? readdirSync(outputDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !namespaces.includes(entry.name))
          .map((entry) => entry.name)
      : [];
  return { outputDir, projectConfig: project.path, namespaces: reports, ...install, staleNamespaces, failures };
}
