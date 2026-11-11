import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { applySetup, findProjectConfig, planSetup, readPackageDirectories, type ProjectConfig } from "../src/index.ts";
import {
  cacheManagedMetadata,
  CacheError,
  cachedTypes,
  checkOutputDir,
  componentItem,
  fieldMetadataType,
  installCache,
  managedAssets,
  managedChannels,
  managedClasses,
  managedComponents,
  managedLabels,
  managedPermissions,
  managedResources,
  managedSchema,
  stagingDir,
  writeItems,
  type CachedItem,
  type OrgConnection,
} from "../src/managed.ts";

const requireProjectConfig = (root: string): ProjectConfig => findProjectConfig(root, readPackageDirectories(root) ?? [])!;

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-managed-test-")));
  tempDirs.push(dir);
  return dir;
}

/** A set-up SFDX project with these package directories. */
function sfdxProject(packages = ["force-app", "common"]): string {
  const dir = tempDir();
  writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: packages.map((p) => ({ path: p })) }));
  for (const directory of packages) {
    mkdirSync(path.join(dir, directory, "main/default/lwc/widget"), { recursive: true });
  }
  mkdirSync(path.join(dir, "node_modules/typescript"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.1.0-beta" }));
  const plan = planSetup(dir);
  assert.ok(!("error" in plan));
  applySetup(plan);
  return dir;
}

type Answer = (soql: string) => unknown[] | undefined;

/**
 * A connection whose queries `answers` answers: the first whose pattern the SOQL matches gives its records.
 * `queries` collects every query, as `api: soql`.
 */
function fakeConnection(answers: { soap?: [RegExp, Answer | unknown[]][]; tooling?: [RegExp, Answer | unknown[]][] }) {
  const queries: string[] = [];
  const api = (name: "soap" | "tooling") => async (soql: string) => {
    queries.push(`${name}: ${soql}`);
    const answer = answers[name]?.find(([pattern]) => pattern.test(soql))?.[1];
    if (answer === undefined) {
      throw new Error(`unexpected ${name} query: ${soql}`);
    }
    const records = typeof answer === "function" ? answer(soql) : answer;
    return { records: records ?? [], totalSize: records?.length ?? 0, done: true };
  };
  return { conn: { query: api("soap"), tooling: { query: api("tooling") } } as unknown as OrgConnection, queries };
}

const isManaged = (namespace: string) => namespace !== "own";
/** An item's file, by its path in its namespace's folder. */
const file = (items: readonly CachedItem[], name: string) =>
  items.flatMap((item) => Object.entries(item.files)).find(([each]) => each === name)?.[1];

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();

const xml = (type: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}</${type}>\n`;

describe("managed metadata", () => {
  it("caches the types the project doesn't disable", () => {
    assert.equal(cachedTypes([]).size, 9);
    const types = cachedTypes(["CustomLabels", "ApexClass", "LightningComponentBundle", "NotAType"]);
    assert.deepEqual([...types].sort(), [
      "ContentAsset",
      "CustomField",
      "CustomObject",
      "CustomPermission",
      "LightningMessageChannel",
      "StaticResource",
    ]);
  });

  it("caches other namespaces' global classes, counting hidden ones", async () => {
    const generated =
      "/*\nThis file is generated and isn't the actual source code for this\nmanaged global class.\n*/\nglobal class RollupService {}\n";
    const { conn, queries } = fakeConnection({
      soap: [
        [
          /FROM ApexClass WHERE NamespacePrefix != null/,
          [
            { Name: "RollupService", NamespacePrefix: "dlrs", ApiVersion: 66, Status: "Active", Body: generated },
            { Name: "Selector", NamespacePrefix: "dlrs", ApiVersion: 66, Status: "Active", Body: "(hidden)" },
            { Name: "Missing", NamespacePrefix: "dlrs", ApiVersion: 66, Status: "Active", Body: null },
            { Name: "Own", NamespacePrefix: "own", ApiVersion: 66, Status: "Active", Body: "public class Own {}" },
          ],
        ],
      ],
    });
    const { items, leftOut } = await managedClasses(conn, isManaged);
    assert.equal(queries.length, 1, "one query for every namespace");
    assert.deepEqual(leftOut, [{ namespace: "dlrs", what: "Apex classes that aren't global, whose source is hidden", count: 2 }]);
    assert.deepEqual(
      items.map((item) => [item.namespace, item.type, item.name]),
      [["dlrs", "ApexClass", "dlrs__RollupService"]],
    );
    assert.equal(file(items, "classes/dlrs__RollupService.cls"), generated);
    assert.equal(
      file(items, "classes/dlrs__RollupService.cls-meta.xml"),
      xml("ApexClass", "    <apiVersion>66.0</apiVersion>\n    <status>Active</status>\n"),
    );
  });

  it("caches exposed components as stubs, with their targets and target config properties", async () => {
    const { conn } = fakeConnection({
      tooling: [
        [
          /SELECT Metadata FROM LightningComponentBundle WHERE Id = '1'/,
          [
            {
              Metadata: {
                apiVersion: 66,
                masterLabel: "Manage Rollups",
                description: "Create & modify",
                targets: { target: ["lightning__RecordPage"] },
                targetConfigs: { targetConfig: [{ property: [{ name: "recordId" }, { name: "bad name" }] }] },
              },
            },
          ],
        ],
        [
          /FROM LightningComponentBundle WHERE NamespacePrefix != null/,
          [
            { Id: "1", DeveloperName: "manageRollups", NamespacePrefix: "dlrs", IsExposed: true },
            { Id: "2", DeveloperName: "combobox", NamespacePrefix: "dlrs", IsExposed: false },
            { Id: "3", DeveloperName: "card", NamespacePrefix: "own", IsExposed: true },
          ],
        ],
      ],
    });
    const { items, leftOut } = await managedComponents(conn, isManaged);
    assert.deepEqual(leftOut, [{ namespace: "dlrs", what: "components that aren't exposed", count: 1 }]);
    assert.deepEqual(
      items.map((item) => item.name),
      ["dlrs/manageRollups"],
    );
    const meta = file(items, "lwc/dlrs__manageRollups/dlrs__manageRollups.js-meta.xml")!;
    assert.match(meta, /<apiVersion>66\.0<\/apiVersion>/);
    assert.match(meta, /<description>Create &amp; modify<\/description>/);
    assert.match(meta, /<isExposed>true<\/isExposed>/);
    assert.match(meta, /<targets>\n {8}<target>lightning__RecordPage<\/target>\n {4}<\/targets>/);
    const js = file(items, "lwc/dlrs__manageRollups/dlrs__manageRollups.js")!;
    assert.match(js, /import \{ LightningElement, api \} from "lwc";/);
    assert.match(js, /export default class ManageRollups extends LightningElement \{\n {2}@api recordId;\n\}/);
  });

  it("maps a field's FieldDefinition type to its metadata type, a formula's to its result's", () => {
    const cases: [string, string | null, string | undefined][] = [
      ["Text(255)", "string", "Text"],
      ["Text(80)  (External ID) (Unique Case Insensitive)", "string", "Text"],
      ["Text Area(255)", "string", "TextArea"],
      ["Long Text Area(32768)", "string", "LongTextArea"],
      ["Rich Text Area(32768)", "string", "Html"],
      ["Picklist", "string", "Picklist"],
      ["Picklist (Multi-Select)", "string", "MultiselectPicklist"],
      ["Date/Time", "datetime", "DateTime"],
      ["Date", "date", "Date"],
      ["Number(18, 0)", "double", "Number"],
      ["Currency(16, 2)", "double", "Currency"],
      ["Percent(3, 0)", "double", "Percent"],
      ["Checkbox", "boolean", "Checkbox"],
      ["Lookup(AcmeSync Sync Event)", "id", "Lookup"],
      ["Master-Detail(Account)", "id", "MasterDetail"],
      ["Roll-Up Summary (COUNT Line)", "double", "Summary"],
      ["Auto Number", "string", "AutoNumber"],
      ["Formula (Text)", "string", "Text"],
      ["Formula (Checkbox)", "boolean", "Checkbox"],
      ["URL(255)", "string", "Url"],
      ["External Lookup", "string", "ExternalLookup"],
      ["Something New", "double", "Number"],
      ["Something New", null, undefined],
    ];
    for (const [dataType, valueTypeId, expected] of cases) {
      assert.equal(fieldMetadataType(dataType, valueTypeId), expected, dataType);
    }
  });

  it("caches objects and fields from the Tooling API, with lookups' child relationships from their metadata", async () => {
    const { conn, queries } = fakeConnection({
      tooling: [
        [
          /FROM CustomObject WHERE NamespacePrefix != null/,
          [
            { Id: "01I000000000001AAA", NamespacePrefix: "acmesync", Description: "Sync & more", SharingModel: "ReadWrite" },
            { Id: "01I000000000002AAA", NamespacePrefix: "own", Description: null, SharingModel: "Private" },
          ],
        ],
        [
          /FROM CustomField WHERE NamespacePrefix != null/,
          [
            {
              Id: "00N1",
              TableEnumOrId: "01I000000000001AAA",
              EntityDefinitionId: "01I000000000001",
              DeveloperName: "Original",
              NamespacePrefix: "acmesync",
              Description: "The first event",
              InlineHelpText: "Set on replays",
              SummaryOperation: null,
            },
            {
              Id: "00N2",
              TableEnumOrId: "Account",
              EntityDefinitionId: "Account",
              DeveloperName: "Events",
              NamespacePrefix: "acmesync",
              Description: null,
              InlineHelpText: null,
              SummaryOperation: "count",
            },
            {
              Id: "00N3",
              TableEnumOrId: "Account",
              EntityDefinitionId: "Account",
              DeveloperName: "Score",
              NamespacePrefix: "own",
              Description: null,
              InlineHelpText: null,
              SummaryOperation: null,
            },
          ],
        ],
        [
          /FROM EntityDefinition WHERE DurableId IN/,
          [
            { DurableId: "01I000000000001", QualifiedApiName: "acmesync__SyncEvent__c", Label: "Sync Event", PluralLabel: "Sync Events" },
            { DurableId: "Account", QualifiedApiName: "Account", Label: "Account", PluralLabel: "Accounts" },
          ],
        ],
        [
          /FROM FieldDefinition WHERE EntityDefinitionId IN \('01I000000000001','Account'\)/,
          [
            {
              EntityDefinitionId: "01I000000000001",
              QualifiedApiName: "acmesync__Original__c",
              Label: "Original",
              DataType: "Lookup(Sync Event)",
              ValueTypeId: "id",
              ReferenceTo: { referenceTo: ["acmesync__SyncEvent__c"] },
            },
            {
              EntityDefinitionId: "Account",
              QualifiedApiName: "acmesync__Events__c",
              Label: "Events",
              DataType: "Roll-Up Summary (COUNT Sync Event)",
              ValueTypeId: "double",
              ReferenceTo: { referenceTo: null },
            },
          ],
        ],
        [
          /SELECT Metadata FROM CustomField WHERE Id = '00N1'/,
          [{ Metadata: { type: "MasterDetail", referenceTo: "acmesync__SyncEvent__c", relationshipName: "Replays" } }],
        ],
      ],
    });
    const { items } = await managedSchema(conn, isManaged, { objects: true, fields: true });
    assert.deepEqual(
      items.map((item) => [item.namespace, item.type, item.name]),
      [
        ["acmesync", "CustomObject", "acmesync__SyncEvent__c"],
        ["acmesync", "CustomField", "acmesync__SyncEvent__c.acmesync__Original__c"],
        ["acmesync", "CustomField", "Account.acmesync__Events__c"],
      ],
    );
    assert.equal(
      file(items, "objects/acmesync__SyncEvent__c/acmesync__SyncEvent__c.object-meta.xml"),
      xml(
        "CustomObject",
        "    <description>Sync &amp; more</description>\n    <label>Sync Event</label>\n    <pluralLabel>Sync Events</pluralLabel>\n    <sharingModel>ReadWrite</sharingModel>\n",
      ),
    );
    assert.equal(
      file(items, "objects/acmesync__SyncEvent__c/fields/acmesync__Original__c.field-meta.xml"),
      xml(
        "CustomField",
        "    <fullName>acmesync__Original__c</fullName>\n    <description>The first event</description>\n    <inlineHelpText>Set on replays</inlineHelpText>\n" +
          "    <label>Original</label>\n    <referenceTo>acmesync__SyncEvent__c</referenceTo>\n    <relationshipName>Replays</relationshipName>\n    <type>MasterDetail</type>\n",
      ),
    );
    assert.equal(
      file(items, "objects/Account/fields/acmesync__Events__c.field-meta.xml"),
      xml(
        "CustomField",
        "    <fullName>acmesync__Events__c</fullName>\n    <label>Events</label>\n    <summaryOperation>count</summaryOperation>\n    <type>Summary</type>\n",
      ),
    );
    assert.equal(queries.filter((query) => query.includes("SELECT Metadata")).length, 1, "only lookups' metadata is queried");
    assert.ok(
      queries.some((query) => query.endsWith("FROM EntityDefinition WHERE DurableId IN ('01I000000000001','Account')")),
      "the objects' and the fields' objects' names, by 15-character id",
    );

    const { items: objectsOnly } = await managedSchema(conn, isManaged, { objects: true, fields: false });
    assert.deepEqual(
      objectsOnly.map((item) => item.type),
      ["CustomObject"],
    );
  });

  it("caches unprotected labels as a CustomLabels file for each namespace, counting protected ones", async () => {
    const label = (Name: string, NamespacePrefix: string, IsProtected: boolean) => ({
      Name,
      NamespacePrefix,
      MasterLabel: `${Name} label`,
      Value: `${Name} <value>`,
      Category: null,
      Language: "en_US",
      IsProtected,
    });
    const { conn } = fakeConnection({
      tooling: [
        [
          /FROM ExternalString WHERE NamespacePrefix != null/,
          [label("Hello", "dlrs", false), label("World", "dlrs", false), label("Secret", "dlrs", true), label("Own", "own", false)],
        ],
      ],
    });
    const { items, leftOut } = await managedLabels(conn, isManaged);
    assert.deepEqual(leftOut, [{ namespace: "dlrs", what: "protected labels", count: 1 }]);
    assert.deepEqual(
      items.map((item) => [item.namespace, item.type, item.count]),
      [["dlrs", "CustomLabels", 2]],
    );
    assert.equal(
      file(items, "labels/CustomLabels.labels-meta.xml"),
      xml(
        "CustomLabels",
        ["Hello", "World"]
          .map(
            (name) =>
              `    <labels>\n        <fullName>dlrs__${name}</fullName>\n        <language>en_US</language>\n        <protected>false</protected>\n` +
              `        <shortDescription>${name} label</shortDescription>\n        <value>${name} &lt;value&gt;</value>\n    </labels>\n`,
          )
          .join(""),
      ),
    );
  });

  it("caches permissions, channels with their fields, and resources and assets with empty content", async () => {
    const { conn } = fakeConnection({
      soap: [
        [/FROM CustomPermission/, [{ DeveloperName: "Admin", NamespacePrefix: "dlrs", MasterLabel: "Admin", Description: "Runs it" }]],
        [
          /FROM StaticResource/,
          [
            { Name: "jszip", NamespacePrefix: "dlrs", ContentType: "application/zip", Description: null, CacheControl: "Public" },
            { Name: "mine", NamespacePrefix: "own", ContentType: "text/plain", Description: null, CacheControl: "Private" },
          ],
        ],
        [/FROM ContentAsset/, [{ DeveloperName: "logo", NamespacePrefix: "acmesync", MasterLabel: "Logo" }]],
      ],
      tooling: [
        [
          /FROM LightningMessageChannel/,
          [
            {
              Id: "0Lm000000000001AAA",
              DeveloperName: "Sync",
              NamespacePrefix: "acmesync",
              IsExposed: false,
              MasterLabel: "Sync",
              Description: null,
            },
          ],
        ],
        [
          /FROM LightningMessageField WHERE LightningMessageChannelId IN \('0Lm000000000001AAA'\)/,
          [
            { LightningMessageChannelId: "0Lm000000000001", FieldName: "linkName", Description: "The link" },
            { LightningMessageChannelId: "0Lm000000000009", FieldName: "other", Description: null },
          ],
        ],
      ],
    });
    const permissions = (await managedPermissions(conn, isManaged)).items;
    assert.equal(
      file(permissions, "customPermissions/dlrs__Admin.customPermission-meta.xml"),
      xml("CustomPermission", "    <description>Runs it</description>\n    <label>Admin</label>\n"),
    );
    const channels = (await managedChannels(conn, isManaged)).items;
    assert.equal(
      file(channels, "messageChannels/acmesync__Sync.messageChannel-meta.xml"),
      xml(
        "LightningMessageChannel",
        "    <isExposed>false</isExposed>\n    <lightningMessageFields>\n        <description>The link</description>\n        <fieldName>linkName</fieldName>\n" +
          "    </lightningMessageFields>\n    <masterLabel>Sync</masterLabel>\n",
      ),
    );
    const resources = (await managedResources(conn, isManaged)).items;
    assert.deepEqual(
      resources.map((item) => item.name),
      ["dlrs__jszip"],
    );
    assert.equal(
      file(resources, "staticresources/dlrs__jszip.resource-meta.xml"),
      xml("StaticResource", "    <cacheControl>Public</cacheControl>\n    <contentType>application/zip</contentType>\n"),
    );
    assert.equal(file(resources, "staticresources/dlrs__jszip.resource"), "");
    const assets = (await managedAssets(conn, isManaged)).items;
    assert.equal(file(assets, "contentassets/acmesync__logo.asset-meta.xml"), xml("ContentAsset", "    <masterLabel>Logo</masterLabel>\n"));
    assert.equal(file(assets, "contentassets/acmesync__logo.asset"), "");

    const dir = tempDir();
    writeItems(dir, [...permissions, ...resources]);
    assert.deepEqual(files(dir), [
      "dlrs/customPermissions/dlrs__Admin.customPermission-meta.xml",
      "dlrs/staticresources/dlrs__jszip.resource",
      "dlrs/staticresources/dlrs__jszip.resource-meta.xml",
    ]);
  });

  it("only caches in a folder of the project outside its package directories", () => {
    const dir = sfdxProject();
    assert.equal(checkOutputDir(dir, "managed-apps"), path.join(dir, "managed-apps"));
    for (const outside of [".", "..", "../elsewhere", "force-app", "force-app/managed", "common/.."]) {
      assert.throws(() => checkOutputDir(dir, outside), /The cache folder must be/, outside);
    }
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "packages/app" }] }));
    assert.throws(() => checkOutputDir(dir, "packages"), /overlap/);
  });

  it("replaces the namespaces' folders, references the project config from cached lwc folders, and includes the cache", () => {
    const dir = sfdxProject();
    const outputDir = path.join(dir, "managed-apps");
    mkdirSync(path.join(outputDir, "dlrs/classes"), { recursive: true });
    writeFileSync(path.join(outputDir, "dlrs/classes/dlrs__Old.cls"), "");
    mkdirSync(path.join(outputDir, "other"), { recursive: true });
    const staging = stagingDir();
    tempDirs.push(staging);
    writeItems(staging, [componentItem({ namespace: "dlrs", name: "card", targets: [], properties: [] })]);

    const project = requireProjectConfig(dir);
    const result = installCache(dir, project, outputDir, staging, ["dlrs", "gone"]);
    assert.equal(existsSync(path.join(outputDir, "dlrs/classes")), false, "the namespace's folder is replaced");
    assert.ok(existsSync(path.join(outputDir, "dlrs/lwc/dlrs__card/dlrs__card.js")));
    assert.ok(existsSync(path.join(outputDir, "other")), "other namespaces' folders are left");
    assert.deepEqual(result.lwcConfigs, [path.join(outputDir, "dlrs/lwc/jsconfig.json")]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(outputDir, "dlrs/lwc/jsconfig.json"), "utf8")).references, [
      { path: "../../../force-app/main/default/lwc/jsconfig.json" },
    ]);
    const include = JSON.parse(readFileSync(project.path, "utf8")).include as string[];
    assert.deepEqual(include.slice(0, 3), ["../../../../force-app", "../../../../common", "../../../../managed-apps"]);
    assert.equal(result.included, true);

    const again = installCache(dir, requireProjectConfig(dir), outputDir, staging, []);
    assert.equal(again.included, false, "already included");
  });

  it("caches an org's packages in the project, the types it doesn't disable, and reports them", async () => {
    const dir = sfdxProject();
    const project = requireProjectConfig(dir);
    writeFileSync(
      project.path,
      readFileSync(project.path, "utf8").replace(
        '"extensions": [',
        '"options": { "disabledMetadataTypes": ["StaticResource", "CustomObject", "CustomField", "LightningMessageChannel"] },\n      "extensions": [',
      ),
    );
    mkdirSync(path.join(dir, "managed-apps/gone/classes"), { recursive: true });
    const generated = "global class RollupService {}\n";
    const { conn, queries } = fakeConnection({
      soap: [
        [
          /FROM ApexClass/,
          [
            { Name: "RollupService", NamespacePrefix: "dlrs", ApiVersion: 66, Status: "Active", Body: generated },
            { Name: "Selector", NamespacePrefix: "dlrs", ApiVersion: 66, Status: "Active", Body: "(hidden)" },
            { Name: "Mine", NamespacePrefix: "acme", ApiVersion: 66, Status: "Active", Body: "public class Mine {}" },
          ],
        ],
        [
          /FROM CustomPermission/,
          () => {
            throw new Error("no access");
          },
        ],
        [/FROM ContentAsset/, []],
      ],
      tooling: [
        [/SELECT Metadata FROM LightningComponentBundle/, [{ Metadata: { targets: { target: "lightning__Tab" } } }]],
        [/FROM LightningComponentBundle/, [{ Id: "1", DeveloperName: "manageRollups", NamespacePrefix: "dlrs", IsExposed: true }]],
        [/FROM ExternalString/, []],
      ],
    });
    const progress: string[] = [];
    const result = await cacheManagedMetadata(dir, conn, { orgNamespaces: ["ACME"], onProgress: (what) => progress.push(what) });
    assert.deepEqual(
      progress,
      ["Apex classes", "components", "labels", "custom permissions", "content assets"],
      "disabled types aren't queried",
    );
    assert.ok(!queries.some((query) => /StaticResource|CustomObject|CustomField|LightningMessageChannel/.test(query)));
    assert.deepEqual(result.namespaces, [
      {
        namespace: "dlrs",
        cached: { ApexClass: 1, LightningComponentBundle: 1 },
        leftOut: [{ what: "Apex classes that aren't global, whose source is hidden", count: 1 }],
        componentStubs: ["dlrs/manageRollups"],
      },
    ]);
    assert.deepEqual(result.failures, [{ what: "custom permissions", message: "no access" }]);
    assert.deepEqual(result.staleNamespaces, ["gone"]);
    assert.equal(result.outputDir, path.join(dir, "managed-apps"));
    assert.equal(result.included, true);
    assert.deepEqual(files(path.join(dir, "managed-apps/dlrs")), [
      "classes/dlrs__RollupService.cls",
      "classes/dlrs__RollupService.cls-meta.xml",
      "lwc/dlrs__manageRollups/dlrs__manageRollups.js",
      "lwc/dlrs__manageRollups/dlrs__manageRollups.js-meta.xml",
      "lwc/jsconfig.json",
    ]);
    assert.equal(existsSync(path.join(dir, "managed-apps/acme")), false, "the org's own namespace isn't cached");

    const only = await cacheManagedMetadata(dir, conn, { orgNamespaces: [], namespaces: ["other"], outputDir: "managed-cache" });
    assert.deepEqual([only.namespaces, only.staleNamespaces], [[], []]);
  });

  it("explains a project that isn't set up, and a cache folder it can't use", async () => {
    const { conn } = fakeConnection({});
    const dir = tempDir();
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    await assert.rejects(
      cacheManagedMetadata(dir, conn, { orgNamespaces: [] }),
      (error) => error instanceof CacheError && error.code === "NotSetUp",
    );
    await assert.rejects(
      cacheManagedMetadata(sfdxProject(), conn, { orgNamespaces: [], outputDir: "force-app/cache" }),
      (error) => error instanceof CacheError && error.code === "InvalidOutputDir",
    );
  });
});
