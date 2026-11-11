// End-to-end: drive the TypeScript 7.1 API (`typescript@beta`, `typescript/sync`) with content mappers
// enabled against copies of the fixture SFDX projects. Requires `npm run build` (run by `npm test`).
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { DiagnosticDirectivePolicy, SpanMap, SpanMapKind } from "typescript/ast";
import { API, DiagnosticCategory, type Diagnostic, type Program } from "typescript/sync";
import { parse } from "jsonc-parser";
import { applySetup, findLwcFolders, planSetup, readPackageDirectories } from "@lwc-bolts/project-setup";
import { cacheManagedMetadata, orgNamespaces } from "@lwc-bolts/project-setup/managed";
import { dlrsOrg } from "../../../tests/fixtures/dlrs-org.ts";
import { exampleProject, fixturesDir, installContentMapperFromSource, mapperManifest } from "./fixtures.ts";

const fixtures = fixturesDir;

/**
 * The recommended registration: `.xml` rather than each `-meta.xml` suffix, because TypeScript 7.1 beta
 * rejects mixed-case extensions such as `.customPermission-meta.xml` on case-insensitive file systems
 * (see the todo test below). `include` is scoped to the metadata folders to limit which XML is mapped.
 */
const EXTENSIONS = [".cls", ".xml"];
const METADATA_FOLDERS = ["classes", "labels", "objects", "staticresources", "contentassets", "customPermissions", "messageChannels"].map(
  (folder) => `force-app/main/default/${folder}`,
);

const LWC_TYPES = `declare module "lwc" {
  export type WireAdapterConstructor<Config, Value> = new (callback: (value: Value) => void) => {
    connect(): void;
    disconnect(): void;
    update(config: Config): void;
  };
}
`;

/** "This location is in virtual code produced by the content mapper ..." */
const VIRTUAL_CODE_LOCATION = 18074;

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Copies a fixture project into a temp dir wired up to resolve this package, plus extra files. */
function setupProject(fixture: string, files: Record<string, string>, extensions = EXTENSIONS, options?: Record<string, unknown>): string {
  // realpath so file names match what the compiler reports (macOS tmpdir is behind a /var symlink).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-e2e-")));
  tempDirs.push(dir);
  // Skip the fixture's own install (used to open it in VS Code), which tests replace with this package run
  // from source, and the Salesforce extensions' .sfdx folder, if they've generated one.
  cpSync(path.join(fixtures, fixture), dir, {
    recursive: true,
    filter: (source) => !["node_modules", ".sfdx"].includes(path.basename(source)),
  });
  installContentMapperFromSource(dir);
  const tsconfig = {
    compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, allowJs: true, types: [] },
    include: [...METADATA_FOLDERS, "types", "src"],
    contentMappers: [{ package: "@lwc-bolts/typescript-content-mapper", extensions, ...(options && { options }) }],
  };
  files = { "tsconfig.json": JSON.stringify(tsconfig, null, 2), "types/lwc.d.ts": LWC_TYPES, ...files };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/**
 * Loads the project's tsconfig.json (or `config`) in a snapshot (content mappers are configured there, not
 * in compiler options) with external code allowed, and hands its program to `inspect`.
 */
function withProgram<T>(dir: string, inspect: (program: Program) => T, config = "tsconfig.json"): T {
  const configFileName = path.join(dir, config);
  using api = new API({ cwd: dir, runExternalCode: true });
  using snapshot = api.createSnapshot({ openProjects: [configFileName] });
  const project = snapshot.getConfiguredProject(configFileName);
  assert.ok(project, `project for ${configFileName} was not loaded`);
  return inspect(project.program);
}

interface Reported {
  file: string;
  line: number;
  column: number;
  code: number;
  text: string;
  inVirtualCode: boolean;
}

/** All errors, in the order `tsc` collects them, summarized with 1-based positions relative to `dir`. */
function errors(program: Program, dir: string): Reported[] {
  const diagnostics: Diagnostic[] = [
    ...program.getProgramDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  return diagnostics
    .filter((d) => d.category === DiagnosticCategory.Error)
    .map((d) => ({
      file: d.fileName ? path.relative(dir, d.fileName) : "",
      line: (d.startPosition?.line ?? -1) + 1,
      column: (d.startPosition?.character ?? -1) + 1,
      code: d.code,
      text: d.text,
      inVirtualCode: d.messageChain?.some((m) => m.code === VIRTUAL_CODE_LOCATION) ?? false,
    }));
}

const CONSUMER = `import getFile1Data from "@salesforce/apex/File1.getFile1Data";
import getFile2Data from "@salesforce/apex/File2.getFile2Data";
import startRequest from "@salesforce/apexContinuation/File3.startRequest";
import bolt from "@salesforce/resourceUrl/bolt";
import pkg from "@salesforce/resourceUrl/pkg";
import lblAustralia from "@salesforce/label/c.Australia";
import lblAccount from "@salesforce/label/c.Account";
import Test_Object__c from "@salesforce/schema/Test_Object__c";
import Test_Text__c from "@salesforce/schema/Test_Object__c.Test_Text__c";
import test1 from "@salesforce/contentAssetUrl/test1";
import hasTestPerm from "@salesforce/customPermission/TestPerm";
import RECORD_SELECTED from "@salesforce/messageChannel/RecordSelected__c";

const label: string = lblAustralia;
const urls: string[] = [bolt, pkg, test1, lblAccount];
const objectApiName: "Test_Object__c" = Test_Object__c.objectApiName;
const fieldApiName: "Test_Text__c" = Test_Text__c.fieldApiName;
getFile1Data({ prop1: "hello", prop2: 123 });
getFile2Data({ prop1: 1, prop2: true });
startRequest();
const canDisableDlrs: true | undefined = hasTestPerm;
const channel: string = RECORD_SELECTED;
export { label, urls, objectApiName, fieldApiName, canDisableDlrs, channel };
`;

describe("TypeScript 7.1 API with content mappers (typescript@beta)", () => {
  it("type checks LWC imports against the generated metadata modules", () => {
    const dir = setupProject("example-project", { "src/consumer.ts": CONSUMER });
    // Includes the generated Apex declarations: File1 and File2 reference each other across files.
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("reports misuse of metadata modules", () => {
    const dir = setupProject("example-project", {
      "src/misuse.ts": `import lblAustralia from "@salesforce/label/c.Australia";
import getFile1Data from "@salesforce/apex/File1.getFile1Data";
import missing from "@salesforce/label/c.DoesNotExist";
const n: number = lblAustralia;
getFile1Data({ prop1: 1, prop2: 2 });
`,
    });
    const reported = withProgram(dir, (program) => errors(program, dir)).filter((d) => d.file === "src/misuse.ts");
    assert.deepEqual(
      reported.map((d) => [d.line, d.code]),
      [
        [3, 2307], // cannot find module
        [4, 2322], // a label's string isn't a number
        [5, 2322], // prop1 must be a string
      ],
    );
  });

  it("exposes the generated declarations and span map on the source file", () => {
    const dir = setupProject("example-project", {});
    const cls = path.join(dir, "force-app/main/default/classes/File1.cls");
    const original = readFileSync(cls, "utf8");
    withProgram(dir, (program) => {
      const file = program.getSourceFile(cls);
      assert.ok(file);
      assert.equal(file.originalText, original);
      assert.equal(file.contentMapper, `${mapperManifest.name}@${mapperManifest.version}`);
      assert.match(file.text, /^declare namespace Apex \{\n  interface File1 \{\}\n\}\n/);
      assert.match(file.text, /declare module "@salesforce\/apex\/File1\.getFile1Data" \{/);
      assert.ok(file.spanMap);

      // `const getFile1Data` is a verbatim copy of the Apex method name.
      const constName = file.spanMap.virtualToOriginalPosition(file.text.indexOf("getFile1Data:"));
      assert.equal(constName.position, original.indexOf("getFile1Data"));
      assert.ok(SpanMap.isExact(constName.fidelity));

      // The module specifier is an alias: a different text naming the same Apex method.
      const specifierStart = file.text.indexOf(`"@salesforce/apex/`);
      const specifier = file.spanMap.virtualToOriginalPosition(specifierStart);
      assert.equal(specifier.position, original.indexOf("getFile1Data"));
      assert.ok(SpanMap.isSingleSegment(specifier.fidelity) && !SpanMap.isExact(specifier.fidelity));
      const segment = file.spanMap.segments.find((s) => s.virtualStart === specifierStart);
      assert.equal(segment?.kind, SpanMapKind.Alias);

      // Scaffolding such as `Promise<...>` has no original counterpart.
      assert.ok(SpanMap.isNone(file.spanMap.virtualToOriginalPosition(file.text.indexOf("Promise")).fidelity));
    });
  });

  // sf2ts maps Apex field types to their declaration, so a type the project doesn't declare (here an Apex
  // class that doesn't exist and an SObject) is an error in the .cls source.
  const UNDECLARED_TYPES_CLS = "force-app/main/default/classes/File4.cls";
  const UNDECLARED_TYPES = "public class File4 {\n    @AuraEnabled public Widget item;\n    @AuraEnabled public List<Account> accts;\n}\n";
  const undeclaredTypesProject = (options?: Record<string, unknown>) =>
    setupProject(
      "example-project",
      {
        [UNDECLARED_TYPES_CLS]: UNDECLARED_TYPES,
        [`${UNDECLARED_TYPES_CLS}-meta.xml`]: readFileSync(
          path.join(exampleProject, "force-app/main/default/classes/File1.cls-meta.xml"),
          "utf8",
        ),
      },
      EXTENSIONS,
      options,
    );

  it("suppresses errors in the files with the suppressDiagnosticsExtensions", () => {
    const dir = undeclaredTypesProject({ suppressDiagnosticsExtensions: [".CLS"] });
    const cls = path.join(dir, UNDECLARED_TYPES_CLS);
    withProgram(dir, (program) => {
      assert.deepEqual(
        program.getSemanticDiagnostics().filter((d) => d.fileName === cls),
        [],
      );
      assert.deepEqual(
        program.getSourceFile(cls)?.diagnosticDirectives?.map((d) => d.policy),
        [DiagnosticDirectivePolicy.Ignore],
      );
    });
  });

  it("maps diagnostics back to the original metadata", () => {
    const cls = UNDECLARED_TYPES_CLS;
    const source = UNDECLARED_TYPES;
    const dir = undeclaredTypesProject();
    const diagnostics = withProgram(dir, (program) => program.getSemanticDiagnostics().filter((d) => d.fileName === path.join(dir, cls)));
    // Positions are in the original Apex source, not the generated declarations (`Apex.Widget`,
    // `Apex.Account[]`), and the diagnostics carry no "virtual code" note.
    assert.deepEqual(
      diagnostics.map((d) => [d.code, d.text, source.slice(d.pos, d.end), d.startPosition, d.messageChain]),
      [
        [2694, "Namespace 'Apex' has no exported member 'Widget'.", "Widget", { line: 1, character: 24 }, undefined],
        [2694, "Namespace 'Apex' has no exported member 'Account'.", "List<Account>", { line: 2, character: 24 }, undefined],
      ],
    );
  });

  it("declares SObjects from the project's object and field metadata", () => {
    const cls = "force-app/main/default/classes/TestObjects.cls";
    const dir = setupProject("example-project", {
      [cls]:
        "public class TestObjects {\n    @AuraEnabled(cacheable=true)\n    public static List<Test_Object__c> list() { return null; }\n}\n",
      [`${cls}-meta.xml`]: readFileSync(path.join(exampleProject, "force-app/main/default/classes/File1.cls-meta.xml"), "utf8"),
      "src/test-objects.ts": `import list from "@salesforce/apex/TestObjects.list";
export const texts: Promise<(string | undefined)[]> = list().then((records) => records.map((r) => r.Test_Text__c));
export const checked = (record: Apex.Test_Object__c): boolean | undefined => record.Test_Checkbox__c;
export const name = (record: Apex.Test_Object_2__c): string | undefined => record.Name;
// @ts-expect-error Test_Text__c is a string
export const wrong: number | undefined = ({} as Apex.Test_Object__c).Test_Text__c;
`,
    });
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("declares SObjects from the generated definitions in .sfdx/tools/sobjects", () => {
    const definitions = ".sfdx/tools/sobjects";
    const cls = "force-app/main/default/classes/Customers.cls";
    const dir = setupProject("example-project", {
      [`${definitions}/standardObjects/Account.cls`]: `// This file is generated as an Apex representation of the
//     corresponding sObject and its fields.

global class Account {
    global String Name;
    global List<Contact> Contacts;
    global SObject Owner;

    global Account ()
    {
    }
}
`,
      [`${definitions}/standardObjects/Contact.cls`]: "global class Contact {\n    global String Name;\n    global Account Account;\n}\n",
      [`${definitions}/customObjects/Widget__c.cls`]: "global class Widget__c {\n    global Account Account__r;\n}\n",
      [cls]: "public class Customers {\n    @AuraEnabled(cacheable=true)\n    public static List<Account> list() { return null; }\n}\n",
      [`${cls}-meta.xml`]: readFileSync(path.join(exampleProject, "force-app/main/default/classes/File1.cls-meta.xml"), "utf8"),
      "src/customers.ts": `import list from "@salesforce/apex/Customers.list";
import ACCOUNT from "@salesforce/schema/Account";
import ACCOUNT_NAME from "@salesforce/schema/Account.Name";
export const objectApiName: "Account" = ACCOUNT.objectApiName;
export const fieldApiName: "Name" = ACCOUNT_NAME.fieldApiName;
export const names: Promise<(string | undefined)[]> = list().then((accounts) => accounts.map((a) => a.Name));
export const contacts = (account: Apex.Account): (string | undefined)[] => (account.Contacts ?? []).map((c) => c.Name);
export const owner = (widget: Apex.Widget__c): unknown => widget.Account__r?.Owner?.Id;
// @ts-expect-error SObject fields are typed
export const wrong: number | undefined = ({} as Apex.Account).Name;
`,
    });
    const tsconfigPath = path.join(dir, "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    tsconfig.include.push(definitions);
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
    // Without the definitions, List<Account> is reported in Customers.cls (see "maps diagnostics back").
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it(
    "type checks the default SObject definitions, whose relationships name objects they don't define",
    {
      skip: "child relationships (List<AccountContactRole>) to objects without a definition are reported (TS2694); the Salesforce extensions' default set, before a refresh from an org, has many",
    },
    () => {
      // The shape of the default set (19 standard objects): Account's relationships name objects outside it. A
      // lookup to one (Owner) already type checks; a child relationship (AccountContactRoles) doesn't.
      const definitions = ".sfdx/tools/sobjects/standardObjects";
      const dir = setupProject("example-project", {
        [`${definitions}/Account.cls`]: `global class Account {
    global String Name;
    global List<AccountContactRole> AccountContactRoles;
    global List<Contact> Contacts;
    global User Owner;
}
`,
        [`${definitions}/Contact.cls`]: "global class Contact {\n    global String Name;\n    global Account Account;\n}\n",
        "src/accounts.ts": `export const contacts = (account: Apex.Account): (string | undefined)[] => (account.Contacts ?? []).map((c) => c.Name);
// @ts-expect-error SObject fields are typed
export const wrong: number | undefined = ({} as Apex.Account).Name;
`,
      });
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push(".sfdx/tools/sobjects");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)),
        [],
      );
    },
  );

  it("types polymorphic relationships from the describes in .sfdx/tools/soqlMetadata", () => {
    const definitions = ".sfdx/tools/sobjects/standardObjects";
    const definition = (name: string, fields: string) => `global class ${name} {\n${fields}\n}\n`;
    const dir = setupProject("example-project", {
      [`${definitions}/Task.cls`]: definition(
        "Task",
        "    global SObject What;\n    global Id WhatId;\n    global SObject Who;\n    global Id WhoId;",
      ),
      [`${definitions}/Name.cls`]: definition("Name", "    global Id Id;\n    global String Name;\n    global String Type;"),
      [`${definitions}/Account.cls`]: definition("Account", "    global Id Id;\n    global String Name;\n    global String Industry;"),
      [`${definitions}/Case.cls`]: definition("Case", "    global Id Id;\n    global String CaseNumber;"),
      [`${definitions}/Contact.cls`]: definition("Contact", "    global Id Id;\n    global String Email;"),
      [`${definitions}/Lead.cls`]: definition("Lead", "    global Id Id;\n    global String Email;"),
      ".sfdx/tools/soqlMetadata/standardObjects/Task.json": JSON.stringify({
        fields: [
          { name: "WhatId", referenceTo: ["Account", "Case"], relationshipName: "What" },
          { name: "WhoId", referenceTo: ["Contact", "Lead"], relationshipName: "Who" },
        ],
      }),
      "src/tasks.ts": `declare const task: Apex.Task;
// the Name object's fields, which a query returns for any target, even Case
export const what: string | undefined = task.What?.Name;
export const type: string | undefined = task.What?.Type;
// a field every target has
export const email: string | undefined = task.Who?.Email;
// @ts-expect-error Industry is only on Account
export const industry = task.What?.Industry;
`,
    });
    const tsconfigPath = path.join(dir, "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    tsconfig.include.push(".sfdx/tools/sobjects");
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("maps custom permissions through the .xml registration", () => {
    const dir = setupProject("example-project", {});
    const xml = path.join(dir, "force-app/main/default/customPermissions/TestPerm.customPermission-meta.xml");
    const original = readFileSync(xml, "utf8");
    withProgram(dir, (program) => {
      const file = program.getSourceFile(xml);
      assert.ok(file?.spanMap);
      assert.match(file.text, /declare module "@salesforce\/customPermission\/TestPerm"/);
      // The declaration maps to the permission's label, which is where go-to-definition lands.
      const constStart = file.text.indexOf("hasTestPerm");
      const constName = file.spanMap.virtualToOriginalPosition(constStart);
      assert.equal(constName.position, original.indexOf("Can do cool stuff!"));
      // A label isn't a name for the permission, so the span is an atom rather than an alias.
      const segment = file.spanMap.segments.find((s) => s.virtualStart === constStart);
      assert.equal(segment?.kind, SpanMapKind.Atom);
    });
  });

  it("maps companion XML files under `include` to empty output", () => {
    const dir = setupProject("example-project", {});
    const companion = path.join(dir, "force-app/main/default/classes/File1.cls-meta.xml");
    withProgram(dir, (program) => {
      const file = program.getSourceFile(companion);
      assert.ok(file, "the .xml registration sends companion files to the mapper");
      assert.equal(file.text, "");
      assert.equal(file.originalText, readFileSync(companion, "utf8"));
    });
  });

  it("declares Apex types globally when apexNamespace is null", () => {
    const dir = setupProject("example-project", { "src/consumer.ts": CONSUMER }, EXTENSIONS, {
      apexNamespace: null,
    });
    withProgram(dir, (program) => {
      assert.deepEqual(errors(program, dir), []);
      const file2 = program.getSourceFile(path.join(dir, "force-app/main/default/classes/File2.cls"));
      assert.match(file2!.text, /^interface File2 \{/);
    });
  });

  it("leaves disabled metadata types out of the program's modules", () => {
    const dir = setupProject("example-project", { "src/consumer.ts": CONSUMER }, EXTENSIONS, {
      disabledMetadataTypes: ["CustomPermission", "ContentAsset"],
    });
    const reported = withProgram(dir, (program) => errors(program, dir));
    assert.deepEqual(
      reported.map((d) => [d.file, d.line, d.code]),
      [
        ["src/consumer.ts", 10, 2307], // @salesforce/contentAssetUrl/test1
        ["src/consumer.ts", 11, 2307], // @salesforce/customPermission/TestPerm
      ],
    );
  });

  it("reports invalid options on their values in tsconfig.json", () => {
    const dir = setupProject("example-project", { "src/consumer.ts": CONSUMER }, EXTENSIONS, {
      apexNamespace: "my-ns",
      disabledMetadataTypes: ["CustomPermission", "customLabels"],
      typo: true,
    });
    const reported = withProgram(dir, (program) => errors(program, dir));
    // The tsconfig is written with 2-space indentation, one option value per line.
    const tsconfig = readFileSync(path.join(dir, "tsconfig.json"), "utf8").split("\n");
    const at = (needle: string) => {
      const line = tsconfig.findIndex((l) => l.includes(needle));
      return [line + 1, tsconfig[line]!.indexOf(needle) + 1];
    };
    assert.deepEqual(
      reported.filter((d) => d.file === "tsconfig.json").map((d) => [d.line, d.column, d.code, d.text]),
      [
        [...at(`"my-ns"`), 1103, "'apexNamespace' must be an identifier or a dotted path of identifiers, but got 'my-ns'."],
        [...at(`"customLabels"`), 1105, "Metadata type names are case-sensitive. Did you mean 'CustomLabels'?"],
        // TypeScript reports a path on its value, so an unknown option is flagged at `true`, not its name.
        [
          at(`"typo"`)[0],
          at(`"typo"`)[1]! + `"typo": `.length,
          1102,
          "Unknown option 'typo'. Expected one of: apexNamespace, inaccessibleApexProperties, disabledMetadataTypes, respectForceIgnore, suppressDiagnosticsExtensions, lwcConfigFile.",
        ],
      ],
    );
    // Valid values still apply, and invalid ones fall back to their defaults.
    assert.deepEqual(
      reported.filter((d) => d.file !== "tsconfig.json").map((d) => [d.file, d.line, d.code]),
      [["src/consumer.ts", 11, 2307]],
    );
  });

  it("leaves files denied by .forceignore out of the program's modules", () => {
    const dir = setupProject("example-project", {
      "src/consumer.ts": CONSUMER,
      ".forceignore": "**/jsconfig.json\n**/TestPerm.customPermission-meta.xml\n",
    });
    const reported = withProgram(dir, (program) => errors(program, dir));
    assert.deepEqual(
      reported.map((d) => [d.file, d.line, d.code]),
      [["src/consumer.ts", 11, 2307]], // @salesforce/customPermission/TestPerm
    );
  });

  it("maps files denied by .forceignore when respectForceIgnore is off", () => {
    const dir = setupProject(
      "example-project",
      { "src/consumer.ts": CONSUMER, ".forceignore": "**/jsconfig.json\n**/TestPerm.customPermission-meta.xml\n" },
      EXTENSIONS,
      { respectForceIgnore: false },
    );
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("loads projects without a .forceignore, which the mapper still watches", () => {
    const dir = setupProject("decomposed-labels", {
      "src/consumer.ts": `import lblAustralia from "@salesforce/label/c.Australia";\nexport const label: string = lblAustralia;\n`,
    });
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  describe("c/ component modules", () => {
    const bundleMeta = (label?: string) => `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>false</isExposed>${label === undefined ? "" : `\n    <masterLabel>${label}</masterLabel>`}
</LightningComponentBundle>
`;
    // Components outside the fixture's lwc folder, which needs the real `lwc` types.
    const COMPONENTS = {
      "force-app/components/lwc/recordCard/recordCard.js": `export default class RecordCard {\n  recordId = "";\n}\n`,
      "force-app/components/lwc/recordCard/recordCard.js-meta.xml": bundleMeta("Record Card"),
      "force-app/components/lwc/utils/utils.ts": `export const data = { key: "value" };\nexport function format(value: unknown): string {\n  return String(value);\n}\n`,
      "force-app/components/lwc/utils/utils.js-meta.xml": bundleMeta(),
    };
    const COMPONENT_CONSUMER = `import RecordCard from "c/recordCard";
import { data, format } from "c/utils";
const card: RecordCard = new RecordCard();
export const id: string = card.recordId;
export const key: string = data.key;
export const formatted: string = format(1);
// @ts-expect-error data.key is a string, so c/utils isn't \`any\`
export const wrong: number = data.key;
`;

    it("resolves c/<name> to each bundle's component, without paths", () => {
      const dir = setupProject("example-project", { ...COMPONENTS, "src/components.ts": COMPONENT_CONSUMER }, EXTENSIONS);
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push("force-app/components");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      withProgram(dir, (program) => {
        assert.deepEqual(errors(program, dir), []);
        // go-to-definition on "c/recordCard" lands on the bundle's label
        const metaFile = path.join(dir, "force-app/components/lwc/recordCard/recordCard.js-meta.xml");
        const file = program.getSourceFile(metaFile);
        assert.ok(file?.spanMap);
        const specifier = file.spanMap.virtualToOriginalPosition(file.text.indexOf(`"c/recordCard"`));
        assert.equal(specifier.position, file.originalText!.indexOf("Record Card"));
        // the export is named after the component's default export, or the bundle without one
        assert.match(file.text, /const RecordCard: typeof import\("\.\/recordCard\.js"\);\n  export = RecordCard;/);
        const utils = program.getSourceFile(path.join(dir, "force-app/components/lwc/utils/utils.js-meta.xml"));
        assert.match(utils!.text, /const utils: typeof import\("\.\/utils\.js"\);/);
      });
    });

    it("drops a component's module when its bundle metadata is gone", () => {
      const { "force-app/components/lwc/utils/utils.js-meta.xml": _, ...withoutUtilsMeta } = COMPONENTS;
      const dir = setupProject("example-project", { ...withoutUtilsMeta, "src/components.ts": COMPONENT_CONSUMER }, EXTENSIONS);
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push("force-app/components");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      const reported = withProgram(dir, (program) => errors(program, dir)).filter((d) => d.file === "src/components.ts");
      assert.deepEqual(
        reported.map((d) => [d.line, d.code]),
        [
          [2, 2307], // c/utils
          [7, 2578], // the @ts-expect-error no longer has an error to expect
        ],
      );
    });
  });

  describe("templates", () => {
    const meta = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>false</isExposed>
</LightningComponentBundle>
`;
    const COMPONENT = `export default class Orders {
  /** @type {{ id: string, name: string, total?: number }[]} */
  rows = [];
  /** @type {{ data?: { currency: string } }} */
  settings = {};
  title = "Orders";
  handleClick() {}
}
`;
    const bundle = "force-app/components/lwc/orders";
    /** A project with the orders bundle; `templates` are its templates by path in the bundle. */
    const setup = (templates: string | Record<string, string>) => {
      const files = Object.entries(typeof templates === "string" ? { "orders.html": templates } : templates);
      const dir = setupProject(
        "example-project",
        {
          [`${bundle}/orders.js`]: COMPONENT,
          [`${bundle}/orders.js-meta.xml`]: meta,
          ...Object.fromEntries(files.map(([file, content]) => [`${bundle}/${file}`, content])),
        },
        [...EXTENSIONS, ".html"],
      );
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push("force-app/components");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      return dir;
    };

    it("type checks a valid template", () => {
      const dir = setup(`<template>
    <h1 onclick={handleClick}>{title}</h1>
    <template lwc:if={settings.data}>{settings.data.currency}</template>
    <template for:each={rows} for:item="row" for:index="i"><p key={row.id}>{row.name} {row.total} {i}</p></template>
</template>
`);
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)),
        [],
      );
    });

    it("reports bindings the component doesn't have, in the template", () => {
      const template = `<template>
    <h1 onclick={handleClik}>{titel}</h1>
    <p>{settings.data.currency}</p>
    <template for:each={rows} for:item="row"><p key={row.id}>{row.nmae}</p></template>
    <p>{row.name}</p>
</template>
`;
      const dir = setup(template);
      const reported = withProgram(dir, (program) => errors(program, dir));
      assert.deepEqual(
        reported.map((d) => [d.file, d.line, d.column, d.code, d.inVirtualCode]),
        [
          ["force-app/components/lwc/orders/orders.html", 2, 18, 2551, false], // handleClik, did you mean handleClick?
          ["force-app/components/lwc/orders/orders.html", 2, 31, 2551, false], // titel, did you mean title?
          ["force-app/components/lwc/orders/orders.html", 3, 8, 18048, false], // settings.data is possibly undefined
          ["force-app/components/lwc/orders/orders.html", 4, 67, 2339, false], // row.nmae
          ["force-app/components/lwc/orders/orders.html", 5, 9, 2551, false], // row is only in its loop: did you mean rows?
        ],
      );
      // go-to-definition on a binding opens the component's member
      withProgram(dir, (program) => {
        const file = program.getSourceFile(path.join(dir, "force-app/components/lwc/orders/orders.html"));
        assert.ok(file?.spanMap);
        assert.equal(file.originalText, template);
      });
    });

    it("reports a loop over a list that isn't iterable once, in the template", () => {
      const dir = setup(`<template>
    <template for:each={settings} for:item="row"><p key={row}></p></template>
    <template iterator:it={settings}><p key={it.value}></p></template>
</template>
`);
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.column, d.code, d.inVirtualCode]),
        [
          [`${bundle}/orders.html`, 2, 24, 2488, false], // settings has no [Symbol.iterator]()
          [`${bundle}/orders.html`, 3, 27, 2488, false],
        ],
      );
    });

    it("checks complex expressions, reporting their problems where they are in the template", () => {
      const dir = setup({
        "orders.js-meta.xml": meta.replace("62.0", "66.0"),
        "orders.html": `<template>
    <p class="{title ?? 'none'}">{rows.length + 1}</p>
    <p class="{titel + 'x'}">one {
        rows.map((row) => row.nmae)
    }</p>
    <button onclick="{(event) => handleClik(event)}"></button>
    <template for:each="{title && settings}" for:item="row"><p key={row}></p></template>
    <p>{title.nope ?? handleClik}</p>
</template>
`,
      });
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.column, d.code, d.inVirtualCode]),
        [
          [`${bundle}/orders.html`, 3, 16, 2551, false], // titel, did you mean title?
          [`${bundle}/orders.html`, 4, 31, 2339, false], // row.nmae
          [`${bundle}/orders.html`, 6, 34, 2551, false], // handleClik, did you mean handleClick?
          [`${bundle}/orders.html`, 7, 25, 2488, false], // an object has no [Symbol.iterator]()
          [`${bundle}/orders.html`, 8, 15, 2339, false], // title.nope
          [`${bundle}/orders.html`, 8, 23, 2551, false], // handleClik, did you mean handleClick?
        ],
      );
    });

    it("parses a template at its bundle's API version, and a child's at the child's", () => {
      const template = `<template>
    <p>{rows.length + 1}</p>
</template>
`;
      const reported = (version: string) => {
        const dir = setup({ "orders.js-meta.xml": meta.replace("62.0", version), "orders.html": template });
        return withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.code, d.inVirtualCode]);
      };
      assert.deepEqual(reported("66.0"), []);
      assert.deepEqual(reported("65.0"), [[`${bundle}/orders.html`, 2, 1002, false]]); // lwc-bolts1002, the compiler's error
    });

    it("accepts dynamic components and lwc:on", () => {
      const dir = setup(`<template>
    <lwc:component lwc:is={title}></lwc:component>
    <div lwc:on={rows}></div>
</template>
`);
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.line, d.code]),
        [
          [2, 2322], // a string isn't a constructor
          [3, 2322], // an array isn't listeners by event
        ],
      );
    });

    it("checks templates in the bundle's subfolders against its component", () => {
      const valid = "<template>\n    <h1 onclick={handleClick}>{title}</h1>\n</template>\n";
      const invalid = "<template>\n    <h1>{titel}</h1>\n</template>\n";
      // every template in a subfolder
      let dir = setup({ "templates/orders.html": valid, "templates/compact.html": invalid });
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.column, d.code]),
        [[`${bundle}/templates/compact.html`, 2, 10, 2551]], // titel, did you mean title?
      );
      // a template at the root, and others in subfolders
      dir = setup({ "orders.html": valid, "views/compact.html": valid, "views/mobile/tiny.html": invalid });
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.column, d.code]),
        [[`${bundle}/views/mobile/tiny.html`, 2, 10, 2551]],
      );
    });

    it("finds a child component in an lwc folder nested in another's subfolders", () => {
      // as source-deploy-retrieve resolves lwc/folder1/lwc/cmpA: the bundle is under the last lwc folder
      const nested = "force-app/components/lwc/folder1/lwc/card";
      const dir = setup('<template>\n    <c-card><p slot="headr"></p></c-card>\n</template>\n');
      for (const [file, content] of Object.entries({
        "card.js": "export default class Card {}\n",
        "card.html": '<template><slot name="header"></slot></template>\n',
        "card.js-meta.xml": meta,
      })) {
        mkdirSync(path.join(dir, nested), { recursive: true });
        writeFileSync(path.join(dir, nested, file), content);
      }
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)).map((d) => [d.file, d.line, d.column, d.code]),
        [[`${bundle}/orders.html`, 2, 22, 2322]], // card has no slot named headr
      );
    });
  });

  describe("lwc:ref and event handlers", () => {
    const meta = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>false</isExposed>
</LightningComponentBundle>
`;
    const lwc = "force-app/components/lwc";
    const CHILD = `export default class Card {
  /** @type {string} */
  title = "";
  expanded = false;
  focusFirst() {}
  toggle() {
    this.dispatchEvent(new CustomEvent("toggle", { detail: { expanded: this.expanded, title: this.title } }));
  }
  /** @param {Event} event */
  dispatchEvent(event) { return !!event; }
}
`;
    const PARENT = `export default class Orders {
  /** @param {CustomEvent<{ expanded: boolean }>} event */
  handleToggle(event) { return event.detail.expanded; }
  /** @param {CustomEvent<{ expanded: string }>} event */
  handleWrongToggle(event) { return event.detail.expanded; }
}
`;
    const setup = (parentJs: string, template: string) => {
      const dir = setupProject(
        "example-project",
        {
          [`${lwc}/card/card.js`]: CHILD,
          [`${lwc}/card/card.js-meta.xml`]: meta,
          [`${lwc}/orders/orders.js`]: parentJs,
          [`${lwc}/orders/orders.js-meta.xml`]: meta,
          [`${lwc}/orders/orders.html`]: template,
        },
        [...EXTENSIONS, ".html"],
      );
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push("force-app/components");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      return dir;
    };
    const TEMPLATE = `<template>
    <c-card lwc:ref="card" ontoggle={handleToggle}></c-card>
    <input lwc:ref="search" onkeyup={handleKey} />
</template>
`;

    it("types this.refs from the template, so the component needn't declare it", () => {
      const parent = `export default class Orders {
  /** @param {CustomEvent<{ expanded: boolean }>} event */
  handleToggle(event) { return event.detail.expanded; }
  /** @param {KeyboardEvent} event */
  handleKey(event) { return event.key; }
  read() {
    /** @type {(string | undefined)[]} */
    const values = [this.refs?.search.value, this.refs?.card.title];
    this.refs?.card.focusFirst();
    // @ts-expect-error not a ref in the template
    this.refs?.missing;
    // @ts-expect-error value is a string
    /** @type {number | undefined} */ const n = this.refs?.search.value;
    return [values, n];
  }
}
`;
      const dir = setup(parent, TEMPLATE);
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)),
        [],
      );
    });

    it("accepts any method as a handler, whatever event it takes, and reports one that doesn't exist", () => {
      const template = `<template>
    <c-card ontoggle={handleWrongToggle}></c-card>
    <input onkeyup={handleToggle} />
    <input onchange={missing} />
</template>
`;
      const dir = setup(PARENT, template);
      const reported = withProgram(dir, (program) => errors(program, dir)).filter((d) => d.file.endsWith("orders.html"));
      assert.deepEqual(
        reported.map((d) => [d.line, d.column, d.code]),
        [[4, 22, 2339]], // Orders has no missing
      );
    });
  });

  describe("child component properties, base components and slots", () => {
    const meta = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>false</isExposed>
</LightningComponentBundle>
`;
    const lwc = "force-app/components/lwc";
    const setup = (template: string) => {
      const dir = setupProject(
        "example-project",
        {
          [`${lwc}/card/card.js`]: `export default class Card {\n  title = "";\n  expanded = false;\n  #secret = 1;\n}\n`,
          [`${lwc}/card/card.html`]: `<template><h2>{title}</h2><slot name="footer"></slot><slot></slot></template>\n`,
          [`${lwc}/card/card.js-meta.xml`]: meta,
          [`${lwc}/orders/orders.js`]: `export default class Orders {\n  heading = "Orders";\n  count = 1;\n}\n`,
          [`${lwc}/orders/orders.js-meta.xml`]: meta,
          [`${lwc}/orders/orders.html`]: template,
        },
        [...EXTENSIONS, ".html"],
      );
      const tsconfigPath = path.join(dir, "tsconfig.json");
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
      tsconfig.include.push("force-app/components");
      writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
      return dir;
    };

    it("type checks valid properties, base components and slots", () => {
      const dir = setup(`<template>
    <c-card title={heading} expanded class="x">
        <p slot="footer">footer</p>
        <span>body</span>
    </c-card>
    <lightning-input label={heading} max-length="10" disabled></lightning-input>
</template>
`);
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)),
        [],
      );
    });

    it("reports properties, values, components and slots the children don't have, in the template", () => {
      const dir = setup(`<template>
    <c-card titel="x" title={count} secret="y">
        <p slot="headr">x</p>
    </c-card>
    <c-crad></c-crad>
    <lightning-button labl="x" disabled={heading}></lightning-button>
</template>
`);
      const reported = withProgram(dir, (program) => errors(program, dir));
      assert.deepEqual(
        reported.map((d) => [d.file.split("/").pop(), d.line, d.column, d.code]),
        [
          ["orders.html", 2, 13, 2561], // titel: did you mean to write 'title'?
          ["orders.html", 2, 23, 2322], // a number isn't a string
          ["orders.html", 2, 37, 2353], // #secret isn't a public member
          ["orders.html", 3, 18, 2322], // no slot named headr
          ["orders.html", 6, 23, 2561], // labl: did you mean to write 'label'?
          ["orders.html", 6, 32, 2322], // disabled takes a boolean
          ["orders.html", 5, 6, 2307], // c-crad doesn't exist
        ],
      );
    });
  });

  it("compiles every base component's definition, and types refs to them", async () => {
    const { LIGHTNING_COMPONENTS } = await import("@lwc-bolts/lightning-base-components");
    const tags = Object.keys(LIGHTNING_COMPONENTS);
    const ref = (tag: string) => tag.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
    const handled = Object.entries(LIGHTNING_COMPONENTS).flatMap(([tag, component]) =>
      Object.keys(component.events).map((event) => `<${tag} on${event}={handleAny}></${tag}>`),
    );
    const meta = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>62.0</apiVersion>
    <isExposed>false</isExposed>
</LightningComponentBundle>
`;
    const lwc = "force-app/components/lwc";
    const dir = setupProject(
      "example-project",
      {
        [`${lwc}/all/all.js`]: `export default class All {
  /** @param {Event} event */
  handleAny(event) { return event; }
  check() {
    /** @type {boolean | undefined} */
    const valid = this.refs?.lightningInput.reportValidity();
    this.refs?.lightningInput.setCustomValidity("message");
    /** @type {string | number | undefined} */
    const label = this.refs?.lightningInput.label;
    // @ts-expect-error not a method of lightning-input
    this.refs?.lightningInput.reportValidty();
    return [valid, label];
  }
}
`,
        [`${lwc}/all/all.js-meta.xml`]: meta,
        [`${lwc}/all/all.html`]: `<template>\n${tags.map((tag) => `    <${tag} lwc:ref="${ref(tag)}"></${tag}>`).join("\n")}\n${handled.join("\n")}\n</template>\n`,
      },
      [...EXTENSIONS, ".html"],
    );
    const tsconfigPath = path.join(dir, "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    tsconfig.include.push("force-app/components");
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it(
    "supports registering .customPermission-meta.xml directly",
    {
      skip: true,
      todo: "TypeScript 7.1 beta rejects mixed-case content mapper extensions (TS6054) on case-insensitive file systems; drop the .xml workaround once this passes",
    },
    () => {
      const dir = setupProject(
        "example-project",
        {
          "src/consumer.ts": `import hasTestPerm from "@salesforce/customPermission/TestPerm";\nexport const b: true | undefined = hasTestPerm;\n`,
        },
        [".cls", ".customPermission-meta.xml"],
      );
      assert.deepEqual(
        withProgram(dir, (program) => errors(program, dir)),
        [],
      );
    },
  );
});

describe("installed managed packages", () => {
  // the dlrs package's metadata, cached outside the package directories (see the fixture's README entry)
  const tsconfig = (options?: Record<string, unknown>) =>
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, allowJs: true, types: [] },
      include: ["force-app", "managed", "types", "src"],
      contentMappers: [{ package: "@lwc-bolts/typescript-content-mapper", extensions: EXTENSIONS, ...(options && { options }) }],
    });
  const consumer = (notes: string) => `import calculate from "@salesforce/apex/dlrs.RollupController.calculate";
import NOT_INSERTABLE from "@salesforce/label/dlrs.fflib_security_error_field_not_insertable";
import DLRS_LOGO from "@salesforce/resourceUrl/dlrs__DLRS_Logo";
import LOG from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c";
import ERROR_MESSAGE from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.dlrs__ErrorMessage__c";
import NOTES from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.Notes__c";
import ManageRollups from "dlrs/manageRollups";
// @ts-expect-error not global, so other namespaces can't import it
import internalStatus from "@salesforce/apex/dlrs.RollupController.internalStatus";
// @ts-expect-error not exposed, so other namespaces can't import it
import AutocompleteCombobox from "dlrs/autocompleteCombobox";
// @ts-expect-error another namespace's label is imported through it
import unqualified from "@salesforce/label/c.fflib_security_error_field_not_insertable";
const result = await calculate({ recordId: "a00000000000000AAA" });
const message: string | undefined = result.message;
const loggedError: string | undefined = result.log?.dlrs__ErrorMessage__c;
// the package's RollupSummary, which its class names without the namespace
const processed: number | undefined = result.summary?.recordsProcessed;
const label: string = NOT_INSERTABLE;
const logo: string = DLRS_LOGO;
const objectApiName: "dlrs__LookupRollupSummaryLog__c" = LOG.objectApiName;
const errorField: "dlrs__ErrorMessage__c" = ERROR_MESSAGE.fieldApiName;
const notesField: "${notes}" = NOTES.fieldApiName;
const notes: string | undefined = ({} as Apex.dlrs__LookupRollupSummaryLog__c).${notes};
const component: typeof ManageRollups.prototype.recordId = "a00000000000000AAA";
export { message, loggedError, processed, label, logo, objectApiName, errorField, notesField, notes, component, internalStatus, AutocompleteCombobox, unqualified };
`;

  it("types a project's imports of a package's cached metadata", () => {
    const dir = setupProject("managed-packages", { "tsconfig.json": tsconfig(), "src/consumer.ts": consumer("Notes__c") });
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("types a project's imports of the metadata project-setup caches from an org with the package", async () => {
    const dir = setupProject("managed-packages", { "tsconfig.json": tsconfig(), "src/consumer.ts": consumer("Notes__c") });
    // the fixture's hand-written cache, replaced by one cached from the org
    rmSync(path.join(dir, "managed"), { recursive: true });
    const { conn } = dlrsOrg(fixtures);
    const result = await cacheManagedMetadata(dir, conn, { orgNamespaces: await orgNamespaces(conn), outputDir: "managed" });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
      result.namespaces.map((report) => report.namespace),
      ["dlrs"],
    );
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });

  it("keeps the package's namespace, and names the project's own fields with the project's", () => {
    const dir = setupProject("managed-packages", {
      "tsconfig.json": tsconfig(),
      "sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace: "acme" }),
      "src/consumer.ts": consumer("acme__Notes__c"),
    });
    assert.deepEqual(
      withProgram(dir, (program) => errors(program, dir)),
      [],
    );
  });
});

/** The fixture SFDX projects. */
const fixtureNames = readdirSync(fixtures).filter((name) => existsSync(path.join(fixtures, name, "sfdx-project.json")));
/** A project's files, relative to it, without installs and the Salesforce tools' generated folders. */
const filesIn = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => !/(^|\/)(node_modules|\.sfdx|\.sf)(\/|$)/.test(file) && statSync(path.join(dir, file)).isFile());

/** The files with these extensions in `dir` that the program for `config` leaves out. */
function unmapped(dir: string, config: string, extensions: readonly string[], files = filesIn(dir)): string[] {
  const mapped = files.filter((file) => extensions.some((extension) => file.endsWith(extension)));
  assert.ok(mapped.length > 0);
  return withProgram(dir, (program) => mapped.filter((file) => program.getSourceFile(path.join(dir, file)) === undefined), config);
}

/**
 * The imports the components in `dir` can't resolve with the program for `config`: of the project's and
 * installed packages' metadata, and other components, which the mapper declares.
 */
function unresolvedImports(dir: string, config: string, files = filesIn(dir)): string[] {
  const components = files.filter((file) => /(^|\/)lwc\/[^/]+\/[^/]+\.(js|ts)$/.test(file));
  assert.ok(components.length > 0);
  // checked, which the config doesn't do for JavaScript, so an import that can't be found is reported
  // rather than being `any`
  for (const component of components.filter((file) => file.endsWith(".js"))) {
    writeFileSync(path.join(dir, component), `// @ts-check\n${readFileSync(path.join(dir, component), "utf8")}`);
  }
  // @salesforce/..., c/... and another namespace's (dlrs/...) modules, which the mapper declares; lwc and
  // lightning/... come from installs and the Salesforce extensions' typings, which tests don't copy
  const declared = /'(@salesforce\/|(?!lightning\/)[a-z][A-Za-z0-9]*\/)/;
  // standard objects and fields (Account.Name) are declared by the SObject definitions the Salesforce
  // extensions generate in .sfdx, which isn't committed; a custom field on one (Account.Rating__c) isn't
  const standardSchema = /'@salesforce\/schema\/[A-Za-z0-9]+(\.[A-Za-z0-9]+)?'/;
  return withProgram(dir, (program) => errors(program, dir), config)
    .filter(({ file, code, text }) => components.includes(file) && code === 2307 && declared.test(text) && !standardSchema.test(text))
    .map(({ file, text }) => `${file}: ${text}`);
}

describe("the fixtures' own configs", () => {
  // Each fixture is opened in VS Code with its committed config, not one written for a test, so that config
  // has to bring in all of the project's metadata, including an installed package's cached copy. It's the
  // project config in the default package directory's lwc folder, which the other lwc folders reference.
  /** The fixture's project config: the one in its default package directory's lwc folder that registers the mapper. */
  const projectConfig = (fixture: string): string => {
    const found = ["tsconfig.json", "jsconfig.json"]
      .map((file) => `force-app/main/default/lwc/${file}`)
      .find(
        (file) =>
          existsSync(path.join(fixtures, fixture, file)) &&
          readFileSync(path.join(fixtures, fixture, file), "utf8").includes("contentMappers"),
      );
    assert.ok(found, `the ${fixture} fixture has no project config`);
    return found;
  };
  /** A fixture's files, as committed. */
  const projectFiles = (fixture: string) => filesIn(path.join(fixtures, fixture));
  /** The extensions the fixture's config registers the content mapper for. */
  const mappedExtensions = (fixture: string): string[] => {
    const file = path.join(fixtures, fixture, projectConfig(fixture));
    const { contentMappers = [] } = parse(readFileSync(file, "utf8")) as { contentMappers?: { extensions?: string[] }[] };
    return contentMappers.flatMap(({ extensions = [] }) => extensions);
  };

  it("finds every fixture", () => {
    assert.deepEqual(fixtureNames.sort(), ["decomposed-labels", "example-project", "managed-packages"]);
  });

  it("are each offered by the repo's launch configuration to run the extension on", () => {
    const launch = parse(readFileSync(path.join(fixtures, "../../.vscode/launch.json"), "utf8"));
    const input = launch.inputs.find((candidate: { id: string }) => candidate.id === "testFixture");
    assert.deepEqual([...input.options].sort(), [...fixtureNames].sort());
    assert.ok(input.options.includes(input.default));
  });

  for (const fixture of fixtureNames) {
    describe(fixture, () => {
      it("includes every file the content mapper converts", () => {
        const extensions = mappedExtensions(fixture);
        const config = projectConfig(fixture);
        assert.ok(extensions.length > 0, `${config} doesn't register the content mapper`);
        assert.deepEqual(unmapped(setupProject(fixture, {}), config, extensions, projectFiles(fixture)), []);
      });

      it("resolves its components' imports of the project's and installed packages' metadata", () => {
        assert.deepEqual(unresolvedImports(setupProject(fixture, {}), projectConfig(fixture), projectFiles(fixture)), []);
      });
    });
  }
});

describe("the lwc folders' jsconfig.json", () => {
  const projectConfig = "force-app/main/default/lwc/jsconfig.json";
  const reference = { path: "../../../../force-app/main/default/lwc/jsconfig.json" };
  const components = {
    "force-app": "force-app/main/default/lwc/comp1/comp1.js",
    common: "common/main/default/lwc/baseCard/baseCard.js",
    sales: "sales/lwc/salesOrderList/salesOrderList.js",
  };
  /** The jsconfig.json the Salesforce extensions write in a `<package>/main/default/lwc` folder. */
  const salesforce = readFileSync(path.join(fixtures, "decomposed-labels/force-app/main/default/lwc/jsconfig.json"), "utf8");

  /** The configs components open in with these files in the example project, and the errors reported on its jsconfig.json files. */
  function openComponents(files: Record<string, string>, opened: readonly string[]): { projects: string[]; jsconfigErrors: number[] } {
    const dir = setupProject("example-project", files);
    const paths = opened.map((file) => path.join(dir, file));
    using api = new API({ cwd: dir, runExternalCode: true });
    using snapshot = api.createSnapshot({ openFiles: paths });
    return {
      projects: paths.map((file) => path.relative(dir, snapshot.getDefaultProjectForFile(file)?.configFileName ?? "")),
      jsconfigErrors: snapshot
        .getProjects()
        .flatMap((p) => p.program.getProgramDiagnostics())
        .filter((d) => d.fileName?.endsWith("jsconfig.json"))
        .map((d) => d.code),
    };
  }

  it("opens every package's components in the default package's jsconfig.json, in one program", () => {
    const dir = setupProject("example-project", {});
    const paths = Object.values(components).map((file) => path.join(dir, file));
    using api = new API({ cwd: dir, runExternalCode: true });
    using snapshot = api.createSnapshot({ openFiles: paths });
    assert.deepEqual(
      paths.map((file) => path.relative(dir, snapshot.getDefaultProjectForFile(file)?.configFileName ?? "")),
      Object.values(components).map(() => projectConfig),
    );
    assert.deepEqual(
      snapshot.getProjects().map((p) => path.relative(dir, p.configFileName ?? "")),
      [projectConfig],
    );
  });

  it("opens them there with the rest of the Salesforce extensions' config kept", () => {
    // what the Lightning Bolts extension leaves of theirs once they've merged their template into the files
    const project = JSON.parse(readFileSync(path.join(fixtures, "example-project", projectConfig), "utf8"));
    const { typeAcquisition } = JSON.parse(salesforce);
    const kept = { compilerOptions: {}, include: [], typeAcquisition, files: [], references: [reference] };
    assert.deepEqual(
      openComponents(
        {
          [projectConfig]: JSON.stringify({ ...project, typeAcquisition }, null, 4),
          "common/main/default/lwc/jsconfig.json": JSON.stringify(kept, null, 4),
        },
        [components.common, components["force-app"]],
      ),
      { projects: [projectConfig, projectConfig], jsconfigErrors: [] },
    );
  });

  it("opens a package's components in a project of their own with the Salesforce extensions' config", () => {
    const common = "common/main/default/lwc/jsconfig.json";
    assert.deepEqual(openComponents({ [common]: salesforce }, [components.common]).projects, [common]);
    // and with just a reference added, TypeScript wants the project config to be composite
    const referencing = JSON.stringify({ ...JSON.parse(salesforce), references: [reference] });
    assert.ok(openComponents({ [common]: referencing }, [components.common]).jsconfigErrors.includes(6306));
  });
});

describe("projects set up by project-setup", () => {
  // What "Set Up Project" promises: a project with no configs of its own works once it's set up, and an
  // installed package's metadata once it's cached from the org.
  for (const fixture of fixtureNames) {
    it(`${fixture}: includes every file the content mapper converts, and resolves its components' imports`, async () => {
      const dir = setupProject(fixture, {});
      const packageDirectories = readPackageDirectories(dir)!;
      for (const folder of findLwcFolders(dir, packageDirectories)) {
        rmSync(path.join(folder, "jsconfig.json"), { force: true });
        rmSync(path.join(folder, "tsconfig.json"), { force: true });
      }
      const cache = path.join(dir, "managed");
      const withPackage = existsSync(cache);
      rmSync(cache, { recursive: true, force: true });
      mkdirSync(path.join(dir, "node_modules/typescript"), { recursive: true });
      writeFileSync(path.join(dir, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.1.0-beta" }));
      const plan = planSetup(dir);
      assert.ok(!("error" in plan), "error" in plan ? plan.error : "");
      applySetup(plan);
      if (withPackage) {
        const { conn } = dlrsOrg(fixtures);
        assert.deepEqual((await cacheManagedMetadata(dir, conn, { orgNamespaces: [], outputDir: "managed" })).failures, []);
      }
      const config = path.relative(dir, plan.projectConfig.path);
      const { contentMappers } = JSON.parse(readFileSync(plan.projectConfig.path, "utf8")) as {
        contentMappers: { extensions: string[] }[];
      };
      assert.deepEqual(unmapped(dir, config, contentMappers[0]!.extensions), []);
      assert.deepEqual(unresolvedImports(dir, config), []);
      // the lwc types setup writes: the Salesforce extensions' reject @api and @wire, and the Apex wire adapters
      const lwcErrors = withProgram(dir, (program) => errors(program, dir), config).filter(({ code }) => code === 1240 || code === 2315);
      assert.deepEqual(lwcErrors, []);
    });
  }
});
