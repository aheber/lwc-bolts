// The mapper's own behaviour: the protocol, which files it converts as which components, and what it passes
// sf2ts. sf2ts is replaced by a stand-in that records what it's asked to convert, so these tests don't depend
// on what sf2ts declares; e2e.test.ts runs the mapper with sf2ts under TypeScript.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { METADATA_TYPES, OptionDiagnosticCode, parseOptions, type MetadataType as OptionsMetadataType } from "../src/options.ts";
import { convert, MetadataType, type Component, type ConvertOptions } from "@lwc-bolts/sf2ts";
import { SfdxProject } from "@lwc-bolts/sfdx-project";
import { ContentMapper, RpcError, RpcErrorCode, templateComponentModule } from "../src/mapper.ts";
import { DiagnosticCode, transformComponent, type Convert } from "../src/transform.ts";
import { DiagnosticDirectivePolicy, type TransformResult } from "../src/protocol.ts";
import { exampleProject, fixturesDir } from "./fixtures.ts";

const metadata = (project: string, relative: string) => path.join(project, "force-app/main/default", relative);
const EMPTY = { text: "", extension: ".ts", mappings: [] };

/** A stand-in for sf2ts's `convert` that records each component it's asked to convert, and converts it to `text`. */
function spyConvert(text = "converted") {
  const calls: { component: Component; options: ConvertOptions }[] = [];
  const convert: Convert = async (components, options = {}) =>
    components.map((component) => {
      calls.push({ component, options });
      return { ...component, text, mapData: [] };
    });
  return { convert, calls };
}

/** A mapper converting with a {@link spyConvert}, with a project opened for the tsconfig.json in `configDir` (or inferred). */
async function openMapper(
  configDir: string | undefined,
  { encoding = "utf-16", options }: { encoding?: "utf-8" | "utf-16"; options?: unknown } = {},
) {
  const { convert, calls } = spyConvert();
  const mapper = new ContentMapper({ convert });
  await mapper.handle("initialize", { positionEncodings: encoding === "utf-8" ? ["utf-8"] : ["utf-8", "utf-16"] });
  const configFileName = configDir === undefined ? "" : path.join(configDir, "tsconfig.json");
  const opened = (await mapper.handle("openProject", { configFileName, projectHandle: "p", options, compilerOptions: {} })) as {
    configIdentity: string;
    watchedFiles?: string[];
    optionDiagnostics?: { path: unknown[]; code: number }[];
  };
  const transform = async (fileName: string, content = readFileSync(fileName, "utf8")) =>
    (await mapper.handle("transform", { fileName, content, projectHandle: "p" })) as TransformResult;
  /** What the mapper asked sf2ts to convert `fileName` as, and with which options; undefined when it converted nothing. */
  const converted = async (fileName: string, content?: string) => {
    const before = calls.length;
    const result = await transform(fileName, content);
    assert.ok(calls.length - before <= 1, "one conversion per transform");
    if (calls.length === before) {
      assert.deepEqual(result, EMPTY, "nothing converted, so nothing to say");
    }
    return calls[before];
  };
  return { mapper, opened, transform, converted };
}

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of the example project with these files added, for tests that change its files. */
function copyProject(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-mapper-")));
  tempDirs.push(dir);
  cpSync(exampleProject, dir, { recursive: true, filter: (source) => !["node_modules", ".sfdx"].includes(path.basename(source)) });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const BUNDLE_META = `<?xml version="1.0" encoding="UTF-8"?>\n<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion></LightningComponentBundle>\n`;

describe("initialize", () => {
  it("prefers UTF-16 and echoes the protocol version when sent", async () => {
    const mapper = new ContentMapper();
    assert.deepEqual(await mapper.handle("initialize", { protocolVersion: 1, positionEncodings: ["utf-8", "utf-16"] }), {
      protocolVersion: 1,
      positionEncoding: "utf-16",
      diagnosticSource: "lwc-bolts",
    });
  });

  it("falls back to UTF-8", async () => {
    const mapper = new ContentMapper();
    assert.deepEqual(await mapper.handle("initialize", { positionEncodings: ["utf-8"] }), {
      positionEncoding: "utf-8",
      diagnosticSource: "lwc-bolts",
    });
  });

  it("rejects hosts without a supported encoding", async () => {
    await assert.rejects(new ContentMapper().handle("initialize", { positionEncodings: [] }), RpcError);
  });
});

describe("openProject", () => {
  it("reports the identity and watched files of the SFDX project above the tsconfig", async () => {
    const { opened } = await openMapper(path.join(exampleProject, "force-app/main/default/lwc"));
    const sfdx = await SfdxProject.load(exampleProject);
    assert.deepEqual(opened, { configIdentity: sfdx.identity, watchedFiles: sfdx.watchedFiles });
  });

  it("reports a stable identity outside an SFDX project, and converts nothing there", async () => {
    const { opened, converted } = await openMapper(path.parse(fixturesDir).root);
    assert.deepEqual(opened, { configIdentity: "no-sfdx-project" });
    assert.equal(await converted(metadata(exampleProject, "classes/File1.cls")), undefined);
  });

  it("discovers an inferred project's SFDX project from each file", async () => {
    const { opened, converted } = await openMapper(undefined);
    assert.deepEqual(opened, { configIdentity: "inferred" });
    const file = metadata(exampleProject, "labels/CustomLabels.labels-meta.xml");
    assert.equal((await converted(file))?.component.type, MetadataType.CustomLabels);
  });
});

describe("what files are converted as", async () => {
  const { converted } = await openMapper(exampleProject);

  const primaryFiles: [string, MetadataType][] = [
    ["classes/File1.cls", MetadataType.ApexClass],
    ["labels/CustomLabels.labels-meta.xml", MetadataType.CustomLabels],
    ["objects/Test_Object__c/Test_Object__c.object-meta.xml", MetadataType.CustomObject],
    ["objects/Test_Object__c/fields/Test_Text__c.field-meta.xml", MetadataType.CustomField],
    ["customPermissions/TestPerm.customPermission-meta.xml", MetadataType.CustomPermission],
    ["staticresources/bolt.resource-meta.xml", MetadataType.StaticResource],
    ["contentassets/test1.asset-meta.xml", MetadataType.ContentAsset],
    ["messageChannels/RecordSelected.messageChannel-meta.xml", MetadataType.LightningMessageChannel],
  ];
  for (const [relative, type] of primaryFiles) {
    it(`converts ${path.basename(relative)} as ${type}`, async () => {
      const file = metadata(exampleProject, relative);
      assert.deepEqual((await converted(file))?.component, { path: file, type, content: readFileSync(file, "utf8") });
    });
  }

  it("converts comp1.js-meta.xml as LightningComponentBundle, with its module's default export", async () => {
    const file = metadata(exampleProject, "lwc/comp1/comp1.js-meta.xml");
    assert.deepEqual((await converted(file))?.component, {
      path: file,
      type: MetadataType.LightningComponentBundle,
      content: readFileSync(file, "utf8"),
      defaultExportName: "Comp1",
    });
  });

  it("converts nothing for companion files, other XML and unsupported metadata", async () => {
    // Projects register `.xml`, so any XML under `include` is sent to the mapper.
    for (const relative of [
      "classes/File1.cls-meta.xml",
      "contentassets/test1.asset",
      "staticresources/bolt.webp",
      "classes/notes.xml",
      "lwc/comp1/notes.xml",
      "lwc/comp1/comp1.js",
    ]) {
      assert.equal(await converted(metadata(exampleProject, relative), `<?xml version="1.0"?><notes/>`), undefined, relative);
    }
  });

  describe("SObject definitions", () => {
    // Generated in .sfdx by the Salesforce extensions ("SFDX: Refresh SObject Definitions").
    const content = "global class Account {\n    global String Name;\n}\n";

    it("converts standard and custom objects' definitions as SObject definitions", async () => {
      // a copy, without the .sfdx folder the Salesforce extensions may have generated in the fixture
      const dir = copyProject();
      const { converted } = await openMapper(dir);
      for (const relative of ["standardObjects/Account.cls", "customObjects/Widget__c.cls"]) {
        const file = path.join(dir, ".sfdx/tools/sobjects", relative);
        assert.deepEqual((await converted(file, content))?.component, {
          path: file,
          type: MetadataType.ApexClass,
          content,
          isSobject: true,
        });
      }
    });

    it("converts nothing for other generated Apex", async () => {
      // the Apex language server's copy of the standard library, and anything else under .sfdx
      for (const relative of ["tools/264/StandardApexLibrary/System/Address.cls", "tools/sobjects/Account.cls", "Account.cls"]) {
        assert.equal(await converted(path.join(exampleProject, ".sfdx", relative), content), undefined, relative);
      }
    });

    it("passes the polymorphic relationships the project reads from the describes", async () => {
      const dir = copyProject({
        ...Object.fromEntries(
          ["Task", "Account", "Case"].map((object) => [
            `.sfdx/tools/sobjects/standardObjects/${object}.cls`,
            `global class ${object} {}\n`,
          ]),
        ),
        ".sfdx/tools/soqlMetadata/standardObjects/Task.json": JSON.stringify({
          fields: [{ referenceTo: ["Account", "Case"], relationshipName: "What" }],
        }),
      });
      const task = path.join(dir, ".sfdx/tools/sobjects/standardObjects/Task.cls");
      const relationships = (await SfdxProject.load(dir)).polymorphicRelationships(task);
      assert.ok(relationships);
      const { converted } = await openMapper(dir);
      const { component } = (await converted(task))!;
      assert.deepEqual(component, {
        path: task,
        type: MetadataType.ApexClass,
        content: readFileSync(task, "utf8"),
        isSobject: true,
        ...relationships,
      });
    });
  });

  describe("templates", () => {
    it("converts a bundle's templates, including those in its subfolders, with the bundle", async () => {
      const dir = copyProject({
        "sales/lwc/panel/panel.js": "export default class Panel {}\n",
        "sales/lwc/panel/panel.js-meta.xml": BUNDLE_META,
        "sales/lwc/panel/templates/panel.html": "<template></template>",
        "sales/lwc/panel/views/mobile/tiny.html": "<template></template>",
      });
      const { converted } = await openMapper(dir);
      const bundle = path.join(dir, "sales/lwc/panel");
      for (const [template, componentModule] of [
        ["templates/panel.html", "../panel.js"],
        ["views/mobile/tiny.html", "../../panel.js"],
      ] as const) {
        const file = path.join(bundle, template);
        // importing the bundle's component relative to the template, with the bundle's API version, from its
        // .js-meta.xml, and its other template
        assert.deepEqual((await converted(file))?.component, {
          path: file,
          type: MetadataType.LightningComponentBundle,
          content: "<template></template>",
          bundleName: "panel",
          componentModule,
          apiVersion: 62,
          alternateTemplates: true,
        });
      }
    });

    it("trusts SDR that a bundle has a component, without looking for it", async () => {
      const dir = copyProject({ "sales/lwc/noComponent/noComponent.html": "<template></template>" });
      const { converted } = await openMapper(dir);
      // TypeScript then reports the missing module in the template
      const file = path.join(dir, "sales/lwc/noComponent/noComponent.html");
      // nor its .js-meta.xml: the template is parsed at the compiler's latest
      assert.deepEqual((await converted(file))?.component, {
        path: file,
        type: MetadataType.LightningComponentBundle,
        content: "<template></template>",
        bundleName: "noComponent",
        componentModule: "./noComponent.js",
        alternateTemplates: false,
      });
    });

    it("converts nothing for other HTML", async () => {
      const dir = copyProject({ "sales/staticresources/page.html": "" });
      const { converted } = await openMapper(dir);
      for (const file of [path.join(dir, "sales/staticresources/page.html"), path.join(dir, "sales/lwc/salesOrderList/unsaved.html")]) {
        assert.equal(await converted(file, "<template>{x}</template>"), undefined, "not in a bundle, or not on disk");
      }
    });

    it("counts only the templates SDR resolves, without those .forceignore denies, unless respectForceIgnore is off", async () => {
      const dir = copyProject({
        "sales/lwc/panel/panel.js": "export default class Panel {}\n",
        "sales/lwc/panel/panel.js-meta.xml": BUNDLE_META,
        "sales/lwc/panel/panel.html": "<template></template>",
        "sales/lwc/panel/drafts/draft.html": "<template></template>",
        ".forceignore": "**/jsconfig.json\n**/drafts/**\n",
      });
      const file = path.join(dir, "sales/lwc/panel/panel.html");
      const alternate = async (respectForceIgnore: boolean) =>
        (await (await openMapper(dir, { options: { respectForceIgnore } })).converted(file))?.component;
      assert.equal(((await alternate(true)) as { alternateTemplates?: boolean }).alternateTemplates, false);
      assert.equal(((await alternate(false)) as { alternateTemplates?: boolean }).alternateTemplates, true);
    });

    it("names a .js-meta.xml's export after its module's default export, when it has a named one", async () => {
      const dir = copyProject({
        "sales/lwc/panel/panel.ts": "export default class MainPanel {}\n",
        "sales/lwc/panel/panel.js-meta.xml": BUNDLE_META,
        "sales/lwc/anonymous/anonymous.js": "export default class {}\n",
        "sales/lwc/anonymous/anonymous.js-meta.xml": BUNDLE_META,
        "sales/lwc/noModule/noModule.js-meta.xml": BUNDLE_META,
      });
      const { converted } = await openMapper(dir);
      const exported = async (bundle: string) =>
        ((await converted(path.join(dir, "sales/lwc", bundle, `${bundle}.js-meta.xml`)))?.component as { defaultExportName?: string })
          .defaultExportName;
      assert.equal(await exported("panel"), "MainPanel", "a TypeScript module");
      assert.equal(await exported("anonymous"), undefined);
      assert.equal(await exported("noModule"), undefined);
    });
  });
});

describe("options passed to sf2ts", () => {
  it("validates apexNamespace as sf2ts does, so sf2ts never rejects a namespace the options accept", async () => {
    const words = (
      "break case catch class const continue debugger default delete do else enum export extends false finally for " +
      "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
      "implements interface let package private protected public static yield await async of type namespace module Apex"
    ).split(" ");
    for (const apexNamespace of words.flatMap((word) => [word, `Acme.${word}`])) {
      const reported = parseOptions({ apexNamespace }).diagnostics.length > 0;
      const rejected = await convert([], { apexNamespace }).then(
        () => false,
        () => true,
      );
      assert.equal(rejected, reported, apexNamespace);
    }
  });

  const cls = metadata(exampleProject, "classes/File1.cls");
  const apexOptions = async (options?: unknown) => {
    const { options: passed } = (await (await openMapper(exampleProject, { options })).converted(cls))!;
    return { apexNamespace: passed.apexNamespace, inaccessibleApexProperties: passed.inaccessibleApexProperties };
  };

  it("passes the Apex options, or their defaults", async () => {
    assert.deepEqual(await apexOptions(), { apexNamespace: "Apex", inaccessibleApexProperties: "include as deprecated" });
    assert.deepEqual(await apexOptions({ apexNamespace: "Acme.Apex", inaccessibleApexProperties: "exclude" }), {
      apexNamespace: "Acme.Apex",
      inaccessibleApexProperties: "exclude",
    });
    assert.deepEqual(await apexOptions({ apexNamespace: null }), {
      apexNamespace: null,
      inaccessibleApexProperties: "include as deprecated",
    });
  });

  it("suppresses TypeScript's diagnostics in the whole output of files with the suppressDiagnosticsExtensions", async () => {
    const content = "// é\n" + readFileSync(cls, "utf8");
    const label = metadata(exampleProject, "labels/CustomLabels.labels-meta.xml");
    const directives = async (extensions?: unknown, encoding?: "utf-8" | "utf-16", fileName = cls) => {
      const options = extensions === undefined ? undefined : { suppressDiagnosticsExtensions: extensions };
      return (await (await openMapper(exampleProject, { options, encoding })).transform(fileName, content)).diagnosticDirectives;
    };
    assert.equal(await directives(), undefined, "none by default");
    // "converted" is spyConvert's output; the original's length is in the host's encoding.
    assert.deepEqual(await directives([".cls"]), {
      directives: [[0, content.length, 0, "converted".length, DiagnosticDirectivePolicy.Ignore]],
      unusedExpectDirectiveDiagnostics: [],
    });
    assert.equal((await directives([".cls"], "utf-8"))?.directives[0]?.[1], Buffer.byteLength(content));
    assert.ok(await directives([".CLS"]), "case-insensitive");
    assert.ok(await directives([".Labels-Meta.XML"], undefined, label), "a compound extension");
    assert.equal(await directives([".xml"], undefined, cls), undefined, "only the extensions listed");
  });

  it("passes the project's namespace from sfdx-project.json", async () => {
    const project = copyProject();
    const projectFile = path.join(project, "sfdx-project.json");
    writeFileSync(projectFile, JSON.stringify({ ...JSON.parse(readFileSync(projectFile, "utf8")), namespace: "acme" }));
    const { converted } = await openMapper(project);
    assert.equal((await converted(metadata(project, "classes/File1.cls")))?.options.projectNamespace, "acme");
    assert.ok(!("projectNamespace" in (await (await openMapper(exampleProject)).converted(cls))!.options), "without one");
  });

  it("reports invalid options, and passes the defaults instead", async () => {
    const { opened, converted } = await openMapper(exampleProject, {
      options: { apexNamespace: "my-namespace", inaccessibleApexProperties: "no", disabledMetadataTypes: ["customPermission", "Flow", 3] },
    });
    assert.deepEqual(
      opened.optionDiagnostics?.map((d) => [d.path, d.code]),
      [
        [["apexNamespace"], OptionDiagnosticCode.InvalidApexNamespace],
        [["inaccessibleApexProperties"], OptionDiagnosticCode.InvalidInaccessibleApexProperties],
        [["disabledMetadataTypes", 0], OptionDiagnosticCode.UnknownMetadataType],
        [["disabledMetadataTypes", 1], OptionDiagnosticCode.UnknownMetadataType],
        [["disabledMetadataTypes", 2], OptionDiagnosticCode.InvalidDisabledMetadataTypes],
      ],
    );
    const { options } = (await converted(cls))!;
    assert.deepEqual([options.apexNamespace, options.inaccessibleApexProperties], ["Apex", "include as deprecated"]);
    assert.ok(await converted(metadata(exampleProject, "customPermissions/TestPerm.customPermission-meta.xml")), "nothing disabled");
  });
});

describe("disabledMetadataTypes", () => {
  it("names the metadata types sf2ts converts", () => {
    // the options' list and sf2ts's are kept separately; each type must be in both
    const same: [MetadataType, OptionsMetadataType] extends [OptionsMetadataType, MetadataType] ? true : false = true;
    assert.ok(same);
    assert.deepEqual([...METADATA_TYPES].sort(), Object.keys(MetadataType).sort());
  });

  it("converts nothing of the disabled types", async () => {
    const { converted } = await openMapper(exampleProject, { options: { disabledMetadataTypes: ["CustomPermission", "ApexClass"] } });
    for (const relative of ["customPermissions/TestPerm.customPermission-meta.xml", "classes/File1.cls"]) {
      assert.equal(await converted(metadata(exampleProject, relative)), undefined, relative);
    }
    assert.ok(await converted(metadata(exampleProject, "labels/CustomLabels.labels-meta.xml")));
  });

  it("disables SObject definitions with ApexClass, and templates with LightningComponentBundle", async () => {
    const definition = path.join(exampleProject, ".sfdx/tools/sobjects/standardObjects/Account.cls");
    const apexOff = await openMapper(exampleProject, { options: { disabledMetadataTypes: ["ApexClass"] } });
    assert.equal(await apexOff.converted(definition, "global class Account {}\n"), undefined);
    const bundlesOff = await openMapper(exampleProject, { options: { disabledMetadataTypes: ["LightningComponentBundle"] } });
    assert.equal(await bundlesOff.converted(path.join(exampleProject, "sales/lwc/salesOrderList/salesOrderList.html")), undefined);
  });

  it("applies in inferred projects", async () => {
    const { converted } = await openMapper(undefined, { options: { disabledMetadataTypes: ["CustomLabels"] } });
    assert.equal(await converted(metadata(exampleProject, "labels/CustomLabels.labels-meta.xml")), undefined);
  });
});

describe(".forceignore", () => {
  const files = {
    ".forceignore": "**/TestPerm.customPermission-meta.xml\n**/File2.cls\n**/drafts/**\n",
    "sales/lwc/salesOrderList/drafts/draft.html": "<template></template>",
  };

  it("converts nothing it denies, and sees edits to it once the project is reopened", async () => {
    const dir = copyProject(files);
    const perm = metadata(dir, "customPermissions/TestPerm.customPermission-meta.xml");
    const cls = metadata(dir, "classes/File2.cls");
    const { converted } = await openMapper(dir);
    assert.equal(await converted(perm), undefined);
    assert.equal(await converted(cls), undefined);
    assert.equal(await converted(path.join(dir, "sales/lwc/salesOrderList/drafts/draft.html")), undefined);
    assert.ok(await converted(metadata(dir, "classes/File1.cls")));

    // TypeScript reopens the project when a watched file changes; SDR re-reads .forceignore when it does.
    writeFileSync(path.join(dir, ".forceignore"), "**/File2.cls\n");
    const reopened = await openMapper(dir);
    assert.ok(await reopened.converted(perm));
    assert.equal(await reopened.converted(cls), undefined);
  });

  it("converts what it denies with respectForceIgnore off, in configured and inferred projects", async () => {
    const dir = copyProject(files);
    for (const configDir of [dir, undefined]) {
      const { opened, converted } = await openMapper(configDir, { options: { respectForceIgnore: false } });
      assert.equal(opened.optionDiagnostics, undefined);
      assert.ok(await converted(metadata(dir, "customPermissions/TestPerm.customPermission-meta.xml")), String(configDir));
      assert.ok(await converted(path.join(dir, "sales/lwc/salesOrderList/drafts/draft.html")), String(configDir));
    }
  });
});

describe("templateComponentModule", () => {
  const bundle = path.join(path.sep, "project", "force-app", "lwc", "orders");

  it("imports the bundle's component from a template in the bundle's folder", () => {
    assert.equal(templateComponentModule(path.join(bundle, "orders.html"), bundle), "./orders.js");
    // an alternate template, with any extension's case; the caller decides what's a template
    assert.equal(templateComponentModule(path.join(bundle, "compact.HTML"), bundle), "./orders.js");
  });

  it("imports it from templates in the bundle's subfolders, with / on every platform", () => {
    assert.equal(templateComponentModule(path.join(bundle, "templates", "orders.html"), bundle), "../orders.js");
    assert.equal(templateComponentModule(path.join(bundle, "views", "mobile", "compact.html"), bundle), "../../orders.js");
  });

  it("doesn't look for the component, or at the folders around the bundle", () => {
    // no files exist here, and the bundle isn't in an lwc folder
    assert.equal(
      templateComponentModule(path.join(path.sep, "elsewhere", "panel", "panel.html"), path.join(path.sep, "elsewhere", "panel")),
      "./panel.js",
    );
  });
});

describe("transformComponent", () => {
  const content = "public class ✓ File1 {}";
  const component: Component = { path: "/p/classes/File1.cls", type: MetadataType.ApexClass, content };
  /** A stand-in for sf2ts's `convert` that converts any component to `output`. */
  const convertingTo =
    (output: { text: string; mapData?: { sourcePos: number; destPos: number }[]; diagnostics?: unknown[] }): Convert =>
    async (components) =>
      components.map((c) => ({ ...c, mapData: [], ...output }) as Awaited<ReturnType<Convert>>[number]);
  const file1 = content.indexOf("File1");
  const output = {
    text: "interface File1 {}",
    // "File1" in the text, from "File1" in the content
    mapData: [
      { sourcePos: file1, destPos: 10 },
      { sourcePos: file1 + 5, destPos: 15 },
    ],
    diagnostics: [
      { kind: "ConversionFailed", message: "failed", start: file1, length: 5 },
      { kind: "TemplateError", message: "LWC1165", start: 0, length: 6 },
    ],
  };

  it("returns the converted text as .ts, its mapped pieces as spans, and its diagnostics with the mapper's codes", async () => {
    const result = await transformComponent(component, "utf-16", {}, convertingTo(output));
    assert.equal(result.text, output.text);
    assert.equal(result.extension, ".ts");
    assert.deepEqual(
      result.mappings.map(([vs, vl, os, ol]) => [vs, vl, os, ol]),
      [[10, 5, file1, 5]],
    );
    assert.deepEqual(result.diagnostics, [
      { messageText: "failed", start: file1, length: 5, code: DiagnosticCode.ConversionFailed },
      { messageText: "LWC1165", start: 0, length: 6, code: DiagnosticCode.TemplateError },
    ]);
  });

  it("encodes positions in the original in UTF-8 bytes for a UTF-8 host", async () => {
    const result = await transformComponent(component, "utf-8", {}, convertingTo(output));
    const bytes = Buffer.from(content, "utf8");
    const [, , os, ol] = result.mappings[0]!;
    assert.equal(bytes.subarray(os, os + ol).toString(), "File1");
    const { start, length } = result.diagnostics![0]!;
    assert.equal(bytes.subarray(start, start + length).toString(), "File1");
  });

  it("returns empty output without diagnostics for a component that converts to nothing", async () => {
    assert.deepEqual(await transformComponent(component, "utf-16", {}, convertingTo({ text: "" })), EMPTY);
  });

  it("passes the component and options to convert", async () => {
    const { convert, calls } = spyConvert();
    const options = { apexNamespace: null };
    await transformComponent(component, "utf-16", options, convert);
    assert.deepEqual(calls, [{ component, options }]);
  });
});

describe("protocol errors", () => {
  const isCode = (code: number) => (error: RpcError) => error instanceof RpcError && error.code === code;
  const cls = metadata(exampleProject, "classes/File1.cls");

  it("rejects transforms before initialize", async () => {
    const mapper = new ContentMapper();
    await mapper.handle("openProject", { configFileName: "", projectHandle: "p" });
    await assert.rejects(
      mapper.handle("transform", { fileName: cls, content: "", projectHandle: "p" }),
      isCode(RpcErrorCode.InternalError),
    );
  });

  it("rejects transforms after the project is closed, and closing it again is harmless", async () => {
    const { mapper, transform } = await openMapper(exampleProject);
    await transform(cls);
    assert.equal(await mapper.handle("closeProject", { projectHandle: "p" }), null);
    assert.equal(await mapper.handle("closeProject", { projectHandle: "p" }), null);
    await assert.rejects(transform(cls), isCode(RpcErrorCode.InvalidParams));
  });

  it("keeps projects separate by handle", async () => {
    const { mapper, transform } = await openMapper(exampleProject);
    await mapper.handle("openProject", { configFileName: "", projectHandle: "q" });
    await mapper.handle("closeProject", { projectHandle: "q" });
    assert.equal((await transform(cls)).text, "converted");
  });

  for (const [method, params] of [
    ["openProject", undefined],
    ["openProject", { projectHandle: "p" }],
    ["openProject", { configFileName: 1, projectHandle: "p" }],
    ["transform", undefined],
    ["transform", { fileName: "/x.cls", projectHandle: "p" }],
    ["transform", { fileName: "/x.cls", content: null, projectHandle: "p" }],
    ["transform", { fileName: 3, content: "", projectHandle: "p" }],
  ] as const) {
    it(`rejects ${method} with ${JSON.stringify(params)}`, async () => {
      const mapper = new ContentMapper();
      await mapper.handle("initialize", { positionEncodings: ["utf-16"] });
      await assert.rejects(mapper.handle(method, params), isCode(RpcErrorCode.InvalidParams));
    });
  }

  it("rejects initialize without position encodings", async () => {
    await assert.rejects(new ContentMapper().handle("initialize", undefined), isCode(RpcErrorCode.InvalidParams));
    await assert.rejects(new ContentMapper().handle("initialize", { positionEncodings: ["utf-32"] }), isCode(RpcErrorCode.InvalidParams));
  });

  it("rejects unknown methods", async () => {
    await assert.rejects(new ContentMapper().handle("shutdown", {}), isCode(RpcErrorCode.MethodNotFound));
  });
});
