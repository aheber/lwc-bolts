// Metadata of installed managed packages, cached in the project the way the Metadata API names it
// (`dlrs__Name`). Components import another namespace's metadata through it (`dlrs.Name`, `dlrs/name`,
// `dlrs__Name`), and their own namespace's without it, as a namespaced org and one with dlrs and acmesync
// installed showed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert, MetadataType, type Component, type ConvertOptions } from "../src/index.ts";
import { importNameParts, splitNamespace } from "../src/names.ts";
import { convertOne, typeCheck } from "./helpers.ts";

const ROLLUP_CONTROLLER = `global with sharing class RollupController {
    global class Result {
        @AuraEnabled global String message;
        @AuraEnabled global LookupRollupSummaryLog__c log;
        @AuraEnabled global dlrs.RollupSummary summary;
    }
    @AuraEnabled global static Result calculate(Id recordId) { return null; }
    @AuraEnabled(cacheable=true) global static List<Result> recent() { return null; }
    @AuraEnabled public static String internalStatus() { return null; }
}`;
const rollupController: Component = {
  path: "managed/dlrs/classes/dlrs__RollupController.cls",
  type: MetadataType.ApexClass,
  content: ROLLUP_CONTROLLER,
};
const labels: Component = {
  path: "managed/dlrs/labels/CustomLabels.labels-meta.xml",
  type: MetadataType.CustomLabels,
  content: `<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>dlrs__fflib_security_error_field_not_insertable</fullName><value>Not insertable</value></labels></CustomLabels>`,
};
const bundle = (name: string, exposed: boolean): Component => ({
  path: `managed/dlrs/lwc/${name}/${name}.js-meta.xml`,
  type: MetadataType.LightningComponentBundle,
  content: `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><isExposed>${exposed}</isExposed></LightningComponentBundle>`,
});

describe("installed packages' metadata", () => {
  it("splits a name's namespace from it, by the number of its parts", () => {
    assert.deepEqual(splitNamespace("dlrs__RollupController"), { namespace: "dlrs", name: "RollupController" });
    assert.deepEqual(splitNamespace("dlrs__fflib_security_error"), { namespace: "dlrs", name: "fflib_security_error" });
    assert.deepEqual(splitNamespace("dlrs__LookupRollupSummaryLog__c"), { namespace: "dlrs", name: "LookupRollupSummaryLog__c" });
    assert.deepEqual(splitNamespace("Notes__c"), { namespace: undefined, name: "Notes__c" });
    assert.deepEqual(splitNamespace("RollupController"), { namespace: undefined, name: "RollupController" });
    // a compound field's part isn't a namespace
    assert.deepEqual(splitNamespace("Site__Latitude__s"), { namespace: undefined, name: "Site__Latitude__s" });
    // imports name another namespace, and leave out their own
    assert.deepEqual(importNameParts("dlrs__RollupController", undefined), { namespace: "dlrs", name: "RollupController" });
    assert.deepEqual(importNameParts("dlrs__RollupController", "acme"), { namespace: "dlrs", name: "RollupController" });
    assert.deepEqual(importNameParts("ACME__Billing", "acme"), { namespace: undefined, name: "Billing" });
  });

  it("declares another namespace's labels through it, and the project's own as c", async () => {
    const [managed] = await convert([labels]);
    assert.match(managed?.text ?? "", /^declare module "@salesforce\/label\/dlrs\.fflib_security_error_field_not_insertable" \{$/m);
    assert.match(managed?.text ?? "", /const lblfflib_security_error_field_not_insertable: string;/);
    const own = await convertOne(
      {
        path: "force-app/labels/CustomLabels.labels-meta.xml",
        type: MetadataType.CustomLabels,
        content: "<CustomLabels><labels><fullName>acme__Greeting</fullName><value>Hi</value></labels></CustomLabels>",
      },
      { projectNamespace: "acme" },
    );
    assert.match(own.text, /^declare module "@salesforce\/label\/c\.Greeting" \{$/m);
  });

  it("declares a package's class in its namespace, with its global AuraEnabled methods", async () => {
    const converted = await convertOne(rollupController);
    const { text } = converted;
    assert.match(
      text,
      /^declare namespace Apex\.dlrs \{\n  interface RollupController \{\}\n  namespace RollupController \{\n    interface Result \{/m,
    );
    // the package's object, and another of its classes
    // it registers itself and its nested type
    assert.match(
      text,
      /^  interface __lwcClasses \{ "rollupcontroller": RollupController; "rollupcontroller\.result": RollupController\.Result; \}$/m,
    );
    assert.match(text, /^declare module "@salesforce\/apex\/dlrs\.RollupController\.calculate" \{$/m);
    assert.match(text, /Promise<Apex\.dlrs\.RollupController\.Result>/);
    assert.match(text, /^declare module "@salesforce\/apex\/dlrs\.RollupController\.recent" \{$/m);
    // not global, so other namespaces can't import it
    assert.doesNotMatch(text, /internalStatus/);
    assert.equal(converted.diagnostics, undefined);
  });

  it("resolves a package class's unqualified names to the package's classes, then library types and SObjects", async () => {
    const auditor: Component = {
      path: "managed/dlrs/classes/dlrs__RollupAuditor.cls",
      type: MetadataType.ApexClass,
      content: `global class RollupAuditor extends Base {
    @AuraEnabled global RollupSummary summary;
    @AuraEnabled global Account account;
    @AuraEnabled global Exception error;
}`,
    };
    const converted = await convertOne(auditor);
    // the class registers itself in its package's registry, which its references look in first
    assert.match(converted.text, /^  interface __lwcClasses \{ "rollupauditor": RollupAuditor; \}$/m);
    // a base the copy may not have is `{}` rather than `unknown`, which an interface can't extend
    assert.match(converted.text, /^  interface RollupAuditor extends Apex\.dlrs\.__lwcRefs\.RollupAuditor\.base \{$/m);
    assert.match(converted.text, /^  type base = .* \? T : \{\};$/m);

    const packageClasses: Component[] = [
      {
        path: "managed/dlrs/classes/dlrs__RollupSummary.cls",
        type: MetadataType.ApexClass,
        content: "global class RollupSummary { @AuraEnabled global Boolean fromPackage; }",
      },
      {
        path: "managed/dlrs/classes/dlrs__Base.cls",
        type: MetadataType.ApexClass,
        content: "global virtual class Base { @AuraEnabled global Boolean packageBase; }",
      },
    ];
    // a package can't see the project's classes, only standard and custom objects
    const project: Component[] = [
      {
        path: "force-app/classes/RollupSummary.cls",
        type: MetadataType.ApexClass,
        content: "public class RollupSummary { @AuraEnabled public Boolean fromProject; }",
      },
      {
        path: "force-app/classes/Base.cls",
        type: MetadataType.ApexClass,
        content: "public virtual class Base { @AuraEnabled public Boolean projectBase; }",
      },
      {
        path: ".sfdx/tools/sobjects/standardObjects/Account.cls",
        type: MetadataType.ApexClass,
        isSobject: true,
        content: "global class Account { global String Name; }",
      },
    ];
    const consumer = (packageHasThem: boolean) => `type Auditor = Apex.dlrs.RollupAuditor;
type Summary = NonNullable<Auditor["summary"]>;
const summary: ${packageHasThem ? `"fromPackage" extends keyof Summary ? true : false` : `unknown extends Auditor["summary"] ? true : false`} = true;
const packageBase: "packageBase" extends keyof Auditor ? true : false = ${packageHasThem};
const projectBase: "projectBase" extends keyof Auditor ? true : false = false;
const name: string | undefined = ({} as Auditor).account?.Name;
// System.Exception, which has no properties
const error: keyof NonNullable<Auditor["error"]> = {} as never;
export { summary, packageBase, projectBase, name, error };`;
    const check = async (components: Component[], packageHasThem: boolean) =>
      typeCheck(
        (await convert([auditor, ...components])).map((c) => c.text),
        consumer(packageHasThem),
      );
    // the package's classes, when the package has them
    assert.deepEqual(await check([...packageClasses, ...project], true), []);
    // `unknown`, and no base, when it doesn't: never the project's, and never an error in the cache
    assert.deepEqual(await check(project, false), []);
    // and the expectations tell the two apart
    assert.notDeepEqual(await check(project, true), []);
  });

  it("extends a package base class that's also a field's type, whether or not the copy has it", async () => {
    const child: Component = {
      path: "managed/dlrs/classes/dlrs__Child.cls",
      type: MetadataType.ApexClass,
      content:
        "global class Child extends Base { @AuraEnabled global Base parent; @AuraEnabled global List<Base> siblings; @AuraEnabled global Boolean own; }",
    };
    const base: Component = {
      path: "managed/dlrs/classes/dlrs__Base.cls",
      type: MetadataType.ApexClass,
      content: "global virtual class Base { @AuraEnabled global Integer depth; }",
    };
    const consumer = (hasBase: boolean) => `type Child = Apex.dlrs.Child;
const own: boolean | undefined = ({} as Child).own;
const inherited: "depth" extends keyof Child ? true : false = ${hasBase};
const parent: ${hasBase ? `number | undefined` : `unknown`} = ({} as Child).parent${hasBase ? "?.depth" : ""};
const siblings: ${hasBase ? `number | undefined` : `unknown`} = ({} as Child).siblings${hasBase ? "?.[0]?.depth" : ""};
export { own, inherited, parent, siblings };`;
    const check = async (components: Component[], hasBase: boolean) =>
      typeCheck(
        (await convert(components)).map((c) => c.text),
        consumer(hasBase),
      );
    assert.deepEqual(await check([child, base], true), []);
    assert.deepEqual(await check([child], false), []);
    // and the expectations tell the two apart
    assert.notDeepEqual(await check([child], true), []);
  });

  it("resolves another package class's nested types, and unknown ones to unknown", async () => {
    const scheduler: Component = {
      path: "managed/dlrs/classes/dlrs__RollupScheduler.cls",
      type: MetadataType.ApexClass,
      content: `global class RollupScheduler {
    @AuraEnabled global RollupController.Result last;
    @AuraEnabled global dlrs.RollupController.Result qualified;
    @AuraEnabled global acmesync.SyncEvent other;
}`,
    };
    const consumer = (cached: boolean) => `type Scheduler = Apex.dlrs.RollupScheduler;
const last: ${cached ? `"message" extends keyof NonNullable<Scheduler["last"]> ? true : false` : `unknown extends Scheduler["last"] ? true : false`} = true;
const qualified: ${cached ? `"message" extends keyof NonNullable<Scheduler["qualified"]> ? true : false` : `unknown extends Scheduler["qualified"] ? true : false`} = true;
// another package's type, which a dlrs class can't know about
const other: unknown extends Scheduler["other"] ? true : false = true;
export { last, qualified, other };`;
    const check = async (components: Component[], cached: boolean) =>
      typeCheck(
        (await convert([scheduler, ...components])).map((c) => c.text),
        consumer(cached),
      );
    assert.deepEqual(await check([rollupController], true), []);
    // without the class in the copy, unknown, and no error in the cache
    assert.deepEqual(await check([], false), []);
    assert.notDeepEqual(await check([], true), []);
  });

  it("keeps the project's references to a package's nested types direct", async () => {
    const [, project] = await convert([
      rollupController,
      {
        path: "force-app/classes/Rollups.cls",
        type: MetadataType.ApexClass,
        content: "public class Rollups {\n    @AuraEnabled public dlrs.RollupController.Result result;\n}",
      },
    ]);
    assert.match(project?.text ?? "", /result\?: Apex\.dlrs\.RollupController\.Result;/);
  });

  it("lets the project's classes reference a package's classes through its namespace", async () => {
    const converted = await convert([
      rollupController,
      {
        path: "force-app/classes/Rollups.cls",
        type: MetadataType.ApexClass,
        content: "public class Rollups {\n    @AuraEnabled public static dlrs.RollupController.Result run() { return null; }\n}",
      },
      { path: "force-app/classes/RollupSummary.cls", type: MetadataType.ApexClass, content: "public class RollupSummary {}" },
    ]);
    assert.match(converted[1]?.text ?? "", /Promise<Apex\.dlrs\.RollupController\.Result>/);
    // the package's class doesn't merge with the project's class of the same name
    assert.match(converted[2]?.text ?? "", /^declare namespace Apex \{\n  interface RollupSummary \{\}/m);
  });

  it("declares an exposed component of another namespace through it, and nothing for one that isn't", async () => {
    const [exposed, hidden] = await convert([bundle("dlrs__manageRollups", true), bundle("dlrs__autocompleteCombobox", false)]);
    assert.match(
      exposed?.text ?? "",
      /^declare module "dlrs\/manageRollups" \{\n  const manageRollups: typeof import\("\.\/dlrs__manageRollups\.js"\);/m,
    );
    assert.deepEqual([hidden?.text, hidden?.mapData, hidden?.diagnostics], ["", [], undefined]);
  });

  it("also declares a component of a namespace that isn't lower case under its lower-case name, as a template's tag names it", async () => {
    const bundleOf = (namespace: string, name: string): Component => ({
      path: `managed/${namespace}/lwc/${namespace}__${name}/${namespace}__${name}.js-meta.xml`,
      type: MetadataType.LightningComponentBundle,
      content: `<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><isExposed>true</isExposed></LightningComponentBundle>`,
    });
    const [mixed, lower] = await convert([bundleOf("SBQQ", "quoteLine"), bundleOf("dlrs", "manageRollups")]);
    assert.deepEqual(
      [...(mixed?.text ?? "").matchAll(/^declare module "([^"]+)"/gm)].map(([, module]) => module),
      ["SBQQ/quoteLine", "sbqq/quoteLine"],
    );
    assert.deepEqual(
      [...(lower?.text ?? "").matchAll(/^declare module "([^"]+)"/gm)].map(([, module]) => module),
      ["dlrs/manageRollups"],
    );
  });

  it("keeps another namespace in resources, permissions, channels and assets, and leaves out the project's", async () => {
    const files: [string, MetadataType, string][] = [
      [
        "staticresources/dlrs__DLRS_Logo.resource-meta.xml",
        MetadataType.StaticResource,
        "<StaticResource><cacheControl>Public</cacheControl></StaticResource>",
      ],
      [
        "customPermissions/dlrs__Recalculate.customPermission-meta.xml",
        MetadataType.CustomPermission,
        "<CustomPermission><label>Recalculate</label></CustomPermission>",
      ],
      [
        "messageChannels/dlrs__RollupChanged.messageChannel-meta.xml",
        MetadataType.LightningMessageChannel,
        "<LightningMessageChannel><masterLabel>Rollup Changed</masterLabel></LightningMessageChannel>",
      ],
      [
        "contentassets/dlrs__Guide.asset-meta.xml",
        MetadataType.ContentAsset,
        "<ContentAsset><masterLabel>Guide</masterLabel></ContentAsset>",
      ],
    ];
    const modules = async (namespace: string, options: ConvertOptions) =>
      (
        await convert(
          files.map(([file, type, content]) => ({ path: `force-app/${file.replace("dlrs__", `${namespace}__`)}`, type, content })),
          options,
        )
      ).map((converted) => /^declare module "([^"]+)"/m.exec(converted.text)?.[1]);
    assert.deepEqual(await modules("dlrs", {}), [
      "@salesforce/resourceUrl/dlrs__DLRS_Logo",
      "@salesforce/customPermission/dlrs__Recalculate",
      "@salesforce/messageChannel/dlrs__RollupChanged__c",
      "@salesforce/contentAssetUrl/dlrs__Guide",
    ]);
    assert.deepEqual(await modules("acme", { projectNamespace: "acme" }), [
      "@salesforce/resourceUrl/DLRS_Logo",
      "@salesforce/customPermission/Recalculate",
      "@salesforce/messageChannel/RollupChanged__c",
      "@salesforce/contentAssetUrl/Guide",
    ]);
  });

  it("types an LWC's imports of a package's metadata, in a project with or without a namespace", async () => {
    for (const projectNamespace of [undefined, "acme"]) {
      const options = projectNamespace === undefined ? {} : { projectNamespace };
      const converted = await convert(
        [
          rollupController,
          { path: "managed/dlrs/classes/dlrs__RollupSummary.cls", type: MetadataType.ApexClass, content: "global class RollupSummary {}" },
          labels,
          bundle("dlrs__manageRollups", true),
          bundle("dlrs__autocompleteCombobox", false),
          {
            path: "managed/dlrs/objects/dlrs__LookupRollupSummaryLog__c/fields/dlrs__ErrorMessage__c.field-meta.xml",
            type: MetadataType.CustomField,
            content: "<CustomField><fullName>dlrs__ErrorMessage__c</fullName><type>LongTextArea</type></CustomField>",
          },
          {
            path: "force-app/objects/dlrs__LookupRollupSummaryLog__c/fields/Notes__c.field-meta.xml",
            type: MetadataType.CustomField,
            content: "<CustomField><fullName>Notes__c</fullName><type>Text</type></CustomField>",
          },
        ],
        options,
      );
      assert.deepEqual(
        converted.map((c) => c.diagnostics),
        converted.map(() => undefined),
      );
      const notes = projectNamespace === undefined ? "Notes__c" : "acme__Notes__c";
      assert.deepEqual(
        typeCheck(
          converted.map((c) => c.text),
          `import calculate from "@salesforce/apex/dlrs.RollupController.calculate";
import NOT_INSERTABLE from "@salesforce/label/dlrs.fflib_security_error_field_not_insertable";
import ERROR_MESSAGE from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.dlrs__ErrorMessage__c";
import NOTES from "@salesforce/schema/dlrs__LookupRollupSummaryLog__c.Notes__c";
import ManageRollups from "dlrs/manageRollups";
// @ts-expect-error not global, so not importable
import internalStatus from "@salesforce/apex/dlrs.RollupController.internalStatus";
// @ts-expect-error not exposed, so not importable
import AutocompleteCombobox from "dlrs/autocompleteCombobox";
const result = await calculate({ recordId: "001" });
const message: string | undefined = result.message;
// the package's object and class, which its class names without the namespace
const loggedError: string | undefined = result.log?.dlrs__ErrorMessage__c;
const summary: Apex.dlrs.RollupSummary | undefined = result.summary;
const label: string = NOT_INSERTABLE;
const errorField: "dlrs__ErrorMessage__c" = ERROR_MESSAGE.fieldApiName;
const notesField: "${notes}" = NOTES.fieldApiName;
const record = {} as Apex.dlrs__LookupRollupSummaryLog__c;
const notes: string | undefined = record.${notes};
export { message, loggedError, summary, label, errorField, notesField, notes, ManageRollups, internalStatus, AutocompleteCombobox };`,
          // the declarations are checked at the project's root, where the bundle's import looks for its module
          { "dlrs__manageRollups.js": "export default class ManageRollups {}\n" },
        ),
        [],
        String(projectNamespace),
      );
    }
  });

  it("keeps an installed package's SObject definitions in the Apex namespace, with its schema modules", async () => {
    const definition: Component = {
      path: ".sfdx/tools/sobjects/customObjects/dlrs__LookupRollupSummaryLog__c.cls",
      type: MetadataType.ApexClass,
      isSobject: true,
      content:
        "global class dlrs__LookupRollupSummaryLog__c {\n    global String dlrs__ErrorMessage__c;\n    global String acme__Notes__c;\n}",
    };
    for (const projectNamespace of [undefined, "acme"]) {
      const [converted] = await convert([definition], projectNamespace === undefined ? {} : { projectNamespace });
      const text = converted?.text ?? "";
      // an SObject, not one of the package's classes
      assert.match(text, /^declare namespace Apex \{\n  interface dlrs__LookupRollupSummaryLog__c \{/m);
      assert.doesNotMatch(text, /Apex\.dlrs\b|namespace dlrs\b/);
      assert.match(text, /^  interface __lwcSObjects \{ "dlrs__lookuprollupsummarylog__c": dlrs__LookupRollupSummaryLog__c; \}$/m);
      assert.match(text, /^declare module "\*@salesforce\/schema\/dlrs__LookupRollupSummaryLog__c\.dlrs__ErrorMessage__c" \{/m);
      // the project's own field on it: without the namespace when it's the project's
      const notes = projectNamespace === undefined ? "acme__Notes__c" : "Notes__c";
      assert.match(text, new RegExp(`^declare module "\\*@salesforce/schema/dlrs__LookupRollupSummaryLog__c\\.${notes}" \\{`, "m"));
    }
  });

  it("names a lookup's child relationship in the lookup field's namespace, whatever the parent's", async () => {
    const lookup = (object: string, name: string, referenceTo: string, relationship: string, folder = "managed/acmesync"): Component => ({
      path: `${folder}/objects/${object}/fields/${name}.field-meta.xml`,
      type: MetadataType.CustomField,
      content: `<CustomField xmlns="http://soap.sforce.com/2006/04/metadata"><fullName>${name}</fullName><referenceTo>${referenceTo}</referenceTo><relationshipName>${relationship}</relationshipName><type>Lookup</type></CustomField>`,
    });
    const fields = [
      // a package's self-lookup, as acmesync's Sync Event has
      lookup("acmesync__SyncEvent__c", "acmesync__Original__c", "acmesync__SyncEvent__c", "Replays"),
      // a package's lookup to a standard object
      lookup("acmesync__SyncEvent__c", "acmesync__Account__c", "Account", "SyncEvents"),
      // the subscriber's lookup to a package's object, from its own object and from the package's
      lookup("Order__c", "SyncEvent__c", "acmesync__SyncEvent__c", "Orders", "force-app/main/default"),
      lookup("acmesync__SyncEvent__c", "Parent__c", "acmesync__SyncEvent__c", "Children", "force-app/main/default"),
    ];
    const relationships = (text: string, parent: string) =>
      [...text.matchAll(new RegExp(`^  interface ${parent} \\{\\n    (\\w+)\\?: Apex\\.(\\w+)\\[\\];`, "gm"))].map(([, name, child]) => [
        name,
        child,
      ]);
    for (const projectNamespace of [undefined, "acme"]) {
      const options = projectNamespace === undefined ? {} : { projectNamespace };
      const [selfLookup, toAccount, toPackage, onPackage] = await convert(fields, options);
      assert.deepEqual(relationships(selfLookup!.text, "acmesync__SyncEvent__c"), [["acmesync__Replays__r", "acmesync__SyncEvent__c"]]);
      assert.deepEqual(relationships(toAccount!.text, "Account"), [["acmesync__SyncEvents__r", "acmesync__SyncEvent__c"]]);
      // the subscriber's are in the project's namespace, if it has one
      const own = (name: string) => (projectNamespace === undefined ? name : `${projectNamespace}__${name}`);
      assert.deepEqual(relationships(toPackage!.text, "acmesync__SyncEvent__c"), [[own("Orders__r"), own("Order__c")]]);
      assert.deepEqual(relationships(onPackage!.text, "acmesync__SyncEvent__c"), [[own("Children__r"), "acmesync__SyncEvent__c"]]);
      assert.deepEqual(typeCheck([selfLookup!.text, toAccount!.text, toPackage!.text, onPackage!.text]), []);
    }
  });

  it("declares a package's classes in its namespace whatever the Apex namespace", async () => {
    for (const [apexNamespace, prefix] of [
      [null, ""],
      ["Org.Apex", "Org.Apex."],
    ] as const) {
      const converted = await convert(
        [
          rollupController,
          { path: "managed/dlrs/classes/dlrs__RollupSummary.cls", type: MetadataType.ApexClass, content: "global class RollupSummary {}" },
        ],
        { apexNamespace },
      );
      const text = converted[0]?.text ?? "";
      assert.match(text, new RegExp(`^declare namespace ${prefix.replaceAll(".", "\\.")}dlrs \\{$`, "m"));
      assert.match(text, new RegExp(`Promise<${prefix.replaceAll(".", "\\.")}dlrs\\.RollupController\\.Result>`));
      assert.deepEqual(
        typeCheck(
          converted.map((c) => c.text),
          `import calculate from "@salesforce/apex/dlrs.RollupController.calculate";
const message: string | undefined = (await calculate({ recordId: "001" })).message;
export { message };`,
        ),
        [],
        String(apexNamespace),
      );
    }
  });

  it("declares a package's global continuation methods through its namespace", async () => {
    const [converted] = await convert([
      {
        path: "managed/dlrs/classes/dlrs__RollupCallouts.cls",
        type: MetadataType.ApexClass,
        content: `global class RollupCallouts {
    @AuraEnabled(continuation=true cacheable=true)
    global static Object start() {
        Continuation con = new Continuation(40);
        con.continuationMethod = 'finish';
        return con;
    }
    @AuraEnabled(cacheable=true)
    global static String finish(List<String> labels, Object state) { return null; }
}`,
      },
    ]);
    assert.match(
      converted?.text ?? "",
      /^declare module "@salesforce\/apexContinuation\/dlrs\.RollupCallouts\.start" \{\n(  .*\n)*  const start: \{\n    \(\): Promise<string>;/m,
    );
  });

  it("declares and registers a package's enums and interfaces in its namespace", async () => {
    const converted = await convert([
      {
        path: "managed/dlrs/classes/dlrs__RollupMode.cls",
        type: MetadataType.ApexClass,
        content: "global enum RollupMode { REALTIME, SCHEDULED }",
      },
      {
        path: "managed/dlrs/classes/dlrs__Calculator.cls",
        type: MetadataType.ApexClass,
        content: "global interface Calculator { Decimal calculate(); }",
      },
      {
        path: "managed/dlrs/classes/dlrs__RollupJob.cls",
        type: MetadataType.ApexClass,
        content: "global class RollupJob {\n    @AuraEnabled global RollupMode mode;\n    @AuraEnabled global Calculator calculator;\n}",
      },
    ]);
    assert.match(
      converted[0]?.text ?? "",
      /^declare namespace Apex\.dlrs \{\n  type RollupMode = "REALTIME" \| "SCHEDULED";\n  interface __lwcClasses \{ "rollupmode": RollupMode; \}\n\}/m,
    );
    assert.match(
      converted[1]?.text ?? "",
      /^  interface Calculator extends Record<string, unknown> \{\}\n  interface __lwcClasses \{ "calculator": Calculator; \}$/m,
    );
    assert.deepEqual(
      typeCheck(
        converted.map((c) => c.text),
        `const job = {} as Apex.dlrs.RollupJob;
const mode: "REALTIME" | "SCHEDULED" | undefined = job.mode;
const result: unknown = job.calculator?.anything;
// @ts-expect-error not one of the enum's values
const wrong: Apex.dlrs.RollupJob["mode"] = "HOURLY";
export { mode, result, wrong };`,
      ),
      [],
    );
  });
});
