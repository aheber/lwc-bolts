// A stand-in for an org with the dlrs package installed, answering the queries project-setup's managed
// metadata cache makes as such an org would, with what the managed-packages fixture caches by hand in
// `managed/dlrs`. Integration tests cache from it and check the result works, without an org.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { OrgConnection } from "@lwc-bolts/project-setup/managed";

const OBJECT_ID = "01I000000000001AAA";
/**
 * Answers by query, the first whose pattern the SOQL matches; every other query has no records. `cached`
 * reads one of the managed-packages fixture's cached files.
 */
const soap = (cached: (file: string) => string): [RegExp, unknown[]][] => [
  [/FROM Organization/, [{ NamespacePrefix: null }]],
  [
    /FROM ApexClass/,
    ["RollupController", "RollupSummary"].map((name) => ({
      Name: name,
      NamespacePrefix: "dlrs",
      ApiVersion: 64,
      Status: "Active",
      Body: cached(`classes/dlrs__${name}.cls`),
    })),
  ],
  [
    /FROM StaticResource/,
    [{ Name: "DLRS_Logo", NamespacePrefix: "dlrs", ContentType: "image/svg+xml", Description: "DLRS logo", CacheControl: "Public" }],
  ],
];
const TOOLING: [RegExp, unknown[]][] = [
  [
    /SELECT Metadata FROM LightningComponentBundle WHERE Id = '0Rb1'/,
    [
      {
        Metadata: {
          apiVersion: 64,
          masterLabel: "Manage Rollups",
          targetConfigs: { targetConfig: [{ property: [{ name: "recordId" }] }] },
        },
      },
    ],
  ],
  [
    /FROM LightningComponentBundle/,
    [
      { Id: "0Rb1", DeveloperName: "manageRollups", NamespacePrefix: "dlrs", IsExposed: true },
      { Id: "0Rb2", DeveloperName: "autocompleteCombobox", NamespacePrefix: "dlrs", IsExposed: false },
    ],
  ],
  [
    /FROM CustomObject/,
    [{ Id: OBJECT_ID, NamespacePrefix: "dlrs", Description: "Logs errors from rollup calculations", SharingModel: "ReadWrite" }],
  ],
  [
    /FROM CustomField WHERE NamespacePrefix != null/,
    ["ErrorMessage", "ParentId"].map((name, i) => ({
      Id: `00N${i}`,
      TableEnumOrId: OBJECT_ID,
      EntityDefinitionId: OBJECT_ID.slice(0, 15),
      DeveloperName: name,
      NamespacePrefix: "dlrs",
      Description: null,
      InlineHelpText: null,
      SummaryOperation: null,
    })),
  ],
  [
    /FROM EntityDefinition/,
    [
      {
        DurableId: OBJECT_ID.slice(0, 15),
        QualifiedApiName: "dlrs__LookupRollupSummaryLog__c",
        Label: "Lookup Rollup Summary Log",
        PluralLabel: "Lookup Rollup Summary Logs",
      },
    ],
  ],
  [
    /FROM FieldDefinition/,
    [
      ["dlrs__ErrorMessage__c", "Error Message", "Long Text Area(32768)"],
      ["dlrs__ParentId__c", "Parent Id", "Text(18)"],
    ].map(([name, label, dataType]) => ({
      EntityDefinitionId: OBJECT_ID.slice(0, 15),
      QualifiedApiName: name,
      Label: label,
      DataType: dataType,
      ValueTypeId: "string",
      ReferenceTo: { referenceTo: null },
    })),
  ],
  [
    /FROM ExternalString/,
    [
      ["fflib_security_error_field_not_insertable", "You do not have permission to insert field {1} on {0}"],
      ["fflib_security_error_field_not_readable", "You do not have permission to read the field {1} on {0}"],
    ].map(([name, value]) => ({
      Name: name,
      NamespacePrefix: "dlrs",
      MasterLabel: name,
      Value: value,
      Category: null,
      Language: "en_US",
      IsProtected: false,
    })),
  ],
];

/**
 * A connection to the org, and the queries it was asked, as `api: soql`. `fixturesDir` is the folder of the
 * fixture projects, this one's.
 */
export function dlrsOrg(fixturesDir: string): { conn: OrgConnection; queries: string[] } {
  const cached = (file: string) => readFileSync(path.join(fixturesDir, "managed-packages/managed/dlrs", file), "utf8");
  const queries: string[] = [];
  const api = (name: "soap" | "tooling", answers: [RegExp, unknown[]][]) => async (soql: string) => {
    queries.push(`${name}: ${soql}`);
    const records = answers.find(([pattern]) => pattern.test(soql))?.[1] ?? [];
    return { records, totalSize: records.length, done: true };
  };
  return { conn: { query: api("soap", soap(cached)), tooling: { query: api("tooling", TOOLING) } } as unknown as OrgConnection, queries };
}
