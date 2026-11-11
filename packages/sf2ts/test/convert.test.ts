import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { convert, MetadataType, type Component, type InaccessibleApexProperties } from "../src/index.ts";
import { mappedText, typeCheck } from "./helpers.ts";

const lib = pathToFileURL(new URL("../src/index.ts", import.meta.url).pathname).href;
const APEX = "public class A {\n  @AuraEnabled\n  public static String go(Integer n) { return ''; }\n}\n";
const LABELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"><labels><fullName>Hi</fullName><value>Hi</value></labels></CustomLabels>\n';

/**
 * Runs `body` in a new Node.js process, so sf2ts loads from scratch, with every `fs` call recorded
 * from before sf2ts is imported, `fs/promises` ones (the same object as `fs.promises`) as `promises.<name>`.
 * `body` can use `convert`, `fsCalls` and `report(value)`.
 */
function run(body: string) {
  const script = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const fsCalls = [];
for (const [prefix, api] of [["", fs], ["promises.", fs.promises]]) {
  for (const name of Object.keys(api)) {
    const original = api[name];
    if (typeof original === "function" && /^[a-z]/.test(name)) {
      try {
        api[name] = function (...args) {
          fsCalls.push([prefix + name, String(args[0])]);
          return original.apply(this, args);
        };
      } catch {
        // a read-only export
      }
    }
  }
}
syncBuiltinESMExports();
let reported;
const report = (value) => (reported = value);
const { convert } = await import(${JSON.stringify(lib)});
${body}
process.on("exit", () => process.stdout.write(JSON.stringify(reported)));
`;
  // with the same export conditions, so it loads the workspace's packages as this process does
  const conditions = process.execArgv.filter((arg) => arg.startsWith("--conditions"));
  return JSON.parse(execFileSync(process.execPath, [...conditions, "--input-type=module", "-e", script], { encoding: "utf8" }));
}

describe("convert", () => {
  it("loads converters on first use, not when sf2ts is imported", () => {
    const result = run(`
const loaded = () => fsCalls.map(([, file]) => file).filter((file) => /tree-sitter-apex\\.wasm$|[\\\\/]converters[\\\\/](?!registry)|[\\\\/]apex[\\\\/](?!namespace)|[\\\\/]templates[\\\\/]|[\\\\/]htmlparser2[\\\\/]/.test(file));
const atImport = loaded();
await convert([{ path: "/p/labels/CustomLabels.labels-meta.xml", type: "CustomLabels", content: ${JSON.stringify(LABELS)} }]);
const afterLabels = loaded();
report({ atImport, labelsLoadedApex: afterLabels.some((file) => /apex/.test(file)), labelsLoadedTemplates: afterLabels.some((file) => /templates/.test(file)) });
`);
    assert.deepEqual(result, { atImport: [], labelsLoadedApex: false, labelsLoadedTemplates: false });
  });

  it("loads a bundle's template converter on its first template, not for its metadata", () => {
    const result = run(`
const templates = () => fsCalls.filter(([, file]) => /[\\\\/]templates[\\\\/]/.test(file)).length;
const [metadata] = await convert([{ path: "/p/lwc/c/c.js-meta.xml", type: "LightningComponentBundle", content: "<LightningComponentBundle/>" }]);
const afterMetadata = templates();
const [template] = await convert([{ path: "/p/lwc/c/c.html", type: "LightningComponentBundle", content: "<template></template>" }]);
report({ metadata: metadata.text.includes('"c/c"'), afterMetadata, template: template.text.includes("./c.js"), afterTemplate: templates() > 0 });
`);
    assert.deepEqual(result, { metadata: true, afterMetadata: 0, template: true, afterTemplate: true });
  });

  it("loads the Apex parser once, on the first Apex class, for concurrent conversions", () => {
    const result = run(`
const grammarReads = () => fsCalls.filter(([, file]) => file.endsWith("tree-sitter-apex.wasm")).length;
const apex = { path: "/p/classes/A.cls", type: "ApexClass", content: ${JSON.stringify(APEX)} };
await convert([{ path: "/p/labels/CustomLabels.labels-meta.xml", type: "CustomLabels", content: ${JSON.stringify(LABELS)} }]);
const beforeApex = grammarReads();
const converted = await Promise.all([1, 2, 3].map(() => convert([apex])));
await convert([apex]);
report({
  beforeApex,
  converted: converted.map(([c]) => c.text.includes('"@salesforce/apex/A.go"')),
  grammarReads: grammarReads(),
});
`);
    assert.deepEqual(result, { beforeApex: 0, converted: [true, true, true], grammarReads: 1 });
  });

  it("doesn't touch the file system while converting", () => {
    const result = run(`
const template = { path: "/p/lwc/c/c.html", type: "LightningComponentBundle", content: "<template><c-child onpick={h}>{x}</c-child></template>" };
const components = { source: () => "this.dispatchEvent(new CustomEvent('pick'));", templates: () => ["<template><slot></slot></template>"] };
const batch = [
  { path: "/p/classes/A.cls", type: "ApexClass", content: ${JSON.stringify(APEX)} },
  { path: "/p/labels/CustomLabels.labels-meta.xml", type: "CustomLabels", content: ${JSON.stringify(LABELS)} },
  { path: "/p/lwc/c/c.js-meta.xml", type: "LightningComponentBundle", content: "<LightningComponentBundle/>" },
  template,
];
// the first conversion of each loads its modules: the converters, the Apex parser and the template compiler
await convert(batch, { components });
const before = fsCalls.length;
const converted = await convert(batch, { components });
report({ converted: converted.map((c) => c.text.length > 0 && c.diagnostics === undefined), fsCalls: fsCalls.slice(before) });
`);
    assert.deepEqual(result, { converted: [true, true, true, true], fsCalls: [] });
  });

  it("reports a file it can't convert as a diagnostic on empty output, and converts the others", async () => {
    const broken = {
      path: "/p/labels/CustomLabels.labels-meta.xml",
      type: MetadataType.CustomLabels,
      content: "<Flow><label>x</label></Flow>",
    };
    const unsupported = { path: "/p/flows/F.flow-meta.xml", type: "Flow" as MetadataType, content: "<Flow/>" };
    const fine = { path: "/p/labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content: LABELS };
    const [first, second, third] = await convert([broken, unsupported, fine]);
    assert.deepEqual({ ...first, diagnostics: undefined }, { ...broken, text: "", mapData: [], diagnostics: undefined });
    assert.equal(first?.diagnostics?.length, 1);
    assert.deepEqual(first?.diagnostics?.[0], {
      kind: "ConversionFailed",
      message: "Unable to convert CustomLabels to TypeScript: expected a <CustomLabels> root element, found <Flow>",
      start: 0,
      length: broken.content.length,
    });
    assert.deepEqual(
      second?.diagnostics?.map((d) => [d.kind, d.message]),
      [
        [
          "ConversionFailed",
          `Unable to convert Flow to TypeScript: unsupported metadata type Flow; supported types are ${Object.keys(MetadataType).join(", ")}`,
        ],
      ],
    );
    assert.match(third?.text ?? "", /"@salesforce\/label\/c\.Hi"/);
    assert.equal(third?.diagnostics, undefined);
  });

  it("returns empty output without diagnostics for Apex that declares no type", async () => {
    const [converted] = await convert([{ path: "/p/classes/Empty.cls", type: MetadataType.ApexClass, content: "// nothing yet\n" }]);
    assert.deepEqual([converted?.text, converted?.mapData, converted?.diagnostics], ["", [], undefined]);
  });

  it("reports Apex with syntax errors and no type as a failed conversion", async () => {
    const content = "public class {\n  @AuraEnabled public static String go() { return null; }\n}";
    const [converted] = await convert([{ path: "/p/classes/A.cls", type: MetadataType.ApexClass, content }]);
    assert.equal(converted?.text, "");
    assert.deepEqual(
      converted?.diagnostics?.map((d) => [d.kind, d.message]),
      [
        [
          "ConversionFailed",
          "Unable to convert ApexClass to TypeScript: the file has syntax errors, and no class, interface or enum declaration was found",
        ],
      ],
    );
  });

  it("converts as much of a class with syntax errors as parses", async () => {
    // the first method is being edited; the second still declares its module
    const content =
      "public class A {\n  @AuraEnabled public static String go( { return null; }\n  @AuraEnabled public static Integer two() { return 1; }\n}";
    const [converted] = await convert([{ path: "/p/classes/A.cls", type: MetadataType.ApexClass, content }]);
    assert.match(converted?.text ?? "", /"@salesforce\/apex\/A\.two"/);
    assert.equal(converted?.diagnostics, undefined);
  });

  it("converts each component afresh, whatever output it already carries", async () => {
    const components: Component[] = [
      { path: "/p/classes/A.cls", type: MetadataType.ApexClass, content: APEX },
      { path: "/p/labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content: LABELS },
      {
        path: "/p/labels/Hi.label-meta.xml",
        type: MetadataType.CustomLabel,
        content: "<CustomLabel><fullName>Hi</fullName><value>Hi</value></CustomLabel>",
      },
      {
        path: "/p/customPermissions/P.customPermission-meta.xml",
        type: MetadataType.CustomPermission,
        content: "<CustomPermission><label>P</label></CustomPermission>",
      },
      {
        path: "/p/staticresources/R.resource-meta.xml",
        type: MetadataType.StaticResource,
        content: "<StaticResource><cacheControl>Public</cacheControl></StaticResource>",
      },
      {
        path: "/p/contentassets/C.asset-meta.xml",
        type: MetadataType.ContentAsset,
        content: "<ContentAsset><masterLabel>C</masterLabel></ContentAsset>",
      },
      {
        path: "/p/messageChannels/M.messageChannel-meta.xml",
        type: MetadataType.LightningMessageChannel,
        content: "<LightningMessageChannel><masterLabel>M</masterLabel></LightningMessageChannel>",
      },
      {
        path: "/p/objects/O__c/O__c.object-meta.xml",
        type: MetadataType.CustomObject,
        content: "<CustomObject><label>O</label></CustomObject>",
      },
      {
        path: "/p/objects/O__c/fields/F__c.field-meta.xml",
        type: MetadataType.CustomField,
        content: "<CustomField><fullName>F__c</fullName><type>Text</type></CustomField>",
      },
      { path: "/p/lwc/c/c.js-meta.xml", type: MetadataType.LightningComponentBundle, content: "<LightningComponentBundle/>" },
      { path: "/p/lwc/c/c.html", type: MetadataType.LightningComponentBundle, content: "<template></template>" },
    ];
    assert.deepEqual(new Set(components.map((c) => c.type)), new Set(Object.keys(MetadataType)));
    const fresh = await convert(components);
    const stale = {
      text: "stale",
      mapData: [{ sourcePos: 0, destPos: 0 }],
      diagnostics: [{ kind: "TemplateError" as const, message: "stale", start: 0, length: 0 }],
    };
    const again = await convert(components.map((component) => ({ ...component, ...stale })));
    assert.deepEqual(
      again.map((c) => [c.text, c.mapData, c.diagnostics]),
      fresh.map((c) => [c.text, c.mapData, c.diagnostics]),
    );
    assert.ok(
      fresh.every((c) => c.text !== "" && c.diagnostics === undefined),
      JSON.stringify(fresh.map((c) => c.diagnostics)),
    );
  });

  describe("metadata XML it can't convert", () => {
    const files: [MetadataType, string, string][] = [
      [MetadataType.ContentAsset, "/p/contentassets/C.asset-meta.xml", "ContentAsset"],
      [MetadataType.CustomField, "/p/objects/O__c/fields/F__c.field-meta.xml", "CustomField"],
      [MetadataType.CustomLabel, "/p/labels/L.label-meta.xml", "CustomLabel"],
      [MetadataType.CustomLabels, "/p/labels/CustomLabels.labels-meta.xml", "CustomLabels"],
      [MetadataType.CustomObject, "/p/objects/O__c/O__c.object-meta.xml", "CustomObject"],
      [MetadataType.CustomPermission, "/p/customPermissions/P.customPermission-meta.xml", "CustomPermission"],
      [MetadataType.LightningMessageChannel, "/p/messageChannels/M.messageChannel-meta.xml", "LightningMessageChannel"],
      [MetadataType.StaticResource, "/p/staticresources/R.resource-meta.xml", "StaticResource"],
    ];
    const failures = async (content: string) =>
      (await convert(files.map(([type, path]) => ({ path, type, content })))).map((c) => [
        c.type,
        c.text,
        c.diagnostics?.map((d) => [d.kind, d.message]),
      ]);

    it("reports an empty file", async () => {
      assert.deepEqual(
        await failures(""),
        files.map(([type, , root]) => [
          type,
          "",
          [["ConversionFailed", `Unable to convert ${type} to TypeScript: expected a <${root}> root element, but the file has none`]],
        ]),
      );
    });

    it("reports a file of another type, naming its root element", async () => {
      assert.deepEqual(
        await failures('<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"/>'),
        files.map(([type, , root]) => [
          type,
          "",
          [["ConversionFailed", `Unable to convert ${type} to TypeScript: expected a <${root}> root element, found <Flow>`]],
        ]),
      );
    });

    it("converts a file whose root element isn't closed, as one being written is", async () => {
      const results = await convert(files.map(([type, path, root]) => ({ path, type, content: `<${root}>` })));
      assert.deepEqual(
        results.map((c) => [c.type, c.diagnostics?.map((d) => d.message)]),
        // only a label needs more than its root: its name
        files.map(([type]) => [
          type,
          type === MetadataType.CustomLabel ? ["Unable to convert CustomLabel to TypeScript: the label has no <fullName>"] : undefined,
        ]),
      );
    });

    it("declares what a file being written has so far", async () => {
      const content = "<CustomLabels>\n  <labels><fullName>Done</fullName><value>x</value></labels>\n  <labels><fullName>Typing";
      const [converted] = await convert([{ path: "/p/labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content }]);
      assert.equal(converted?.diagnostics, undefined);
      assert.deepEqual(
        [...(converted?.text ?? "").matchAll(/^declare module "(.*)"/gm)].map((m) => m[1]),
        ["@salesforce/label/c.Done", "@salesforce/label/c.Typing"],
      );
      assert.deepEqual(
        mappedText(converted!).filter(([text]) => !text.startsWith('"')),
        [
          ["lblDone", "Done"],
          ["lblTyping", "Typing"],
        ],
      );
    });

    it("reads past a closing tag that doesn't match", async () => {
      const content = "<CustomPermission><label>Can edit</lable><description>Edits</description></CustomPermission>";
      const [converted] = await convert([
        { path: "/p/customPermissions/Edit.customPermission-meta.xml", type: MetadataType.CustomPermission, content },
      ]);
      assert.equal(converted?.diagnostics, undefined);
      assert.match(converted?.text ?? "", /^declare module "@salesforce\/customPermission\/Edit" \{\n  \/\*\*\n   \* Can edit\n/);
    });

    it("decodes entities and CDATA, and maps to the text as written", async () => {
      const content =
        '<?xml version="1.0"?><CustomLabels><labels><fullName>Amp</fullName><value>A &amp; B</value><shortDescription><![CDATA[x < y]]></shortDescription><protected/></labels></CustomLabels>';
      const [converted] = await convert([{ path: "/p/labels/CustomLabels.labels-meta.xml", type: MetadataType.CustomLabels, content }]);
      assert.match(converted?.text ?? "", /   \* "A & B"\n   \*\n   \* @description x < y\n/);
      const permission = "<CustomPermission><label>R&amp;D</label></CustomPermission>";
      const [mapped] = await convert([
        { path: "/p/customPermissions/RD.customPermission-meta.xml", type: MetadataType.CustomPermission, content: permission },
      ]);
      assert.deepEqual(mappedText(mapped!)[1], ["hasRD", "R&amp;D"]);
    });

    it("declares a bundle's module from a .js-meta.xml being written", async () => {
      const content = "<LightningComponentBundle>\n  <isExposed>true</isExposed>\n  <masterLabel>Card";
      const [converted] = await convert([{ path: "/p/lwc/card/card.js-meta.xml", type: MetadataType.LightningComponentBundle, content }]);
      assert.equal(converted?.diagnostics, undefined);
      assert.match(converted?.text ?? "", /^\/\*\*\n \* Card\n \*\/\ndeclare module "c\/card" \{$/m);
    });

    it("reports a field whose path doesn't name its object", async () => {
      const [converted] = await convert([
        { path: "F__c.field-meta.xml", type: MetadataType.CustomField, content: "<CustomField><type>Text</type></CustomField>" },
      ]);
      assert.deepEqual(
        converted?.diagnostics?.map((d) => d.message),
        ["Unable to convert CustomField to TypeScript: no object name in the file path F__c.field-meta.xml"],
      );
    });

    it("converts a root element without children", async () => {
      const results = await convert(
        files.filter(([type]) => type !== MetadataType.CustomLabel).map(([type, path, root]) => ({ path, type, content: `<${root}/>` })),
      );
      assert.deepEqual(
        results.map((c) => c.diagnostics),
        results.map(() => undefined),
      );
    });
  });

  describe("options", () => {
    const apex = { path: "/p/classes/A.cls", type: MetadataType.ApexClass, content: "public class A {}" };

    it("rejects an apexNamespace TypeScript can't declare, before converting anything", async () => {
      for (const apexNamespace of ["", "Bad-Name", "Acme.", ".Apex", "Acme.class", "1Apex"]) {
        await assert.rejects(
          convert([apex], { apexNamespace }),
          {
            name: "TypeError",
            message: new RegExp(
              `^apexNamespace ${JSON.stringify(JSON.stringify(apexNamespace)).slice(1, -1).replace(/[.]/g, "\\.")} isn't`,
            ),
          },
          apexNamespace,
        );
      }
    });

    it("accepts dotted identifiers and null as the apexNamespace", async () => {
      for (const apexNamespace of ["Acme.Apex", "$apex", "_A.b_2", "Acme.await", null]) {
        const [converted] = await convert([apex], { apexNamespace });
        assert.equal(converted?.diagnostics, undefined, String(apexNamespace));
        assert.deepEqual(typeCheck([converted?.text ?? ""]), [], String(apexNamespace));
      }
    });

    it("rejects a projectNamespace that isn't a namespace prefix", async () => {
      for (const projectNamespace of ["a b", "acme__", "ac__me", "_acme", "1acme", "acme-x", "acme."]) {
        await assert.rejects(
          convert([apex], { projectNamespace }),
          { name: "TypeError", message: /^projectNamespace .* isn't a Salesforce namespace prefix$/ },
          projectNamespace,
        );
      }
    });

    it("rejects an inaccessibleApexProperties that isn't one of its values, and takes null as unset", async () => {
      const [converted] = await convert([apex], { inaccessibleApexProperties: null as unknown as InaccessibleApexProperties });
      assert.equal(converted?.diagnostics, undefined);
      for (const inaccessibleApexProperties of [true, false, "Include", 0]) {
        await assert.rejects(
          convert([apex], { inaccessibleApexProperties: inaccessibleApexProperties as unknown as InaccessibleApexProperties }),
          {
            name: "TypeError",
            message: `inaccessibleApexProperties must be one of "include", "exclude", "include as deprecated", but got ${JSON.stringify(inaccessibleApexProperties)}`,
          },
        );
      }
    });

    it("accepts namespace prefixes, with single underscores, and surrounding whitespace", async () => {
      for (const projectNamespace of ["acme", "Acme2", "my_ns", " acme "]) {
        const [converted] = await convert([apex], { projectNamespace });
        assert.equal(converted?.diagnostics, undefined, projectNamespace);
      }
    });
  });

  describe("LightningComponentBundle templates", () => {
    const bundle = "/p/lwc/orders";

    it("converts a bundle's template to TypeScript that checks it against the bundle's component, as given", async () => {
      const content = "<template><p>{title}</p></template>";
      const [converted] = await convert([
        {
          path: `${bundle}/views/compact.html`,
          type: MetadataType.LightningComponentBundle,
          content,
          componentModule: "../orders.js",
          bundleName: "orders",
        },
      ]);
      assert.match(converted?.text ?? "", /^import type __Component from "\.\.\/orders\.js";$/m);
      assert.match(converted?.text ?? "", /^    "c\/orders": true;$/m);
      assert.match(converted?.text ?? "", /^\$cmp\.title;$/m);
      assert.equal(converted?.diagnostics, undefined);
      assert.ok((converted?.mapData.length ?? 0) > 0);
    });

    it("takes the template's folder as the bundle without them, with either separator", async () => {
      for (const path of [`${bundle}/orders.html`, "C:\\p\\lwc\\orders\\orders.html"]) {
        const [converted] = await convert([{ path, type: MetadataType.LightningComponentBundle, content: "<template></template>" }]);
        assert.match(converted?.text ?? "", /^import type __Component from "\.\/orders\.js";$/m, path);
        assert.match(converted?.text ?? "", /^    "c\/orders": true;$/m, path);
      }
      const [noFolder] = await convert([
        { path: "orders.html", type: MetadataType.LightningComponentBundle, content: "<template></template>" },
      ]);
      assert.match(noFolder?.diagnostics?.[0]?.message ?? "", /no bundle folder in the file path orders\.html/);
    });

    it("takes what it knows of the bundle from the component, reading nothing else", async () => {
      const content = '<template><c-card onpick={h}><p slot="footer"></p></c-card><input lwc:ref="search"/></template>';
      const template = { path: `${bundle}/orders.html`, type: MetadataType.LightningComponentBundle, content } as const;
      const [alone, alternate] = await convert([template, { ...template, alternateTemplates: true }]);
      // the bundle's other templates make refs optional
      assert.match(alone?.text ?? "", /^    search: __lwcElement<"input">;$/m);
      assert.match(alternate?.text ?? "", /^    search\?: __lwcElement<"input">;$/m);
      // nothing of card's: its slots are its templates' own declarations, and handlers' events aren't checked
      assert.match(alone?.text ?? "", /\[\$cmp\.h\] satisfies \[\(\.\.\.args: any\[\]\) => unknown\];/);
      assert.match(alone?.text ?? "", /^\["footer"\] satisfies \[__lwcSlots<"c\/card">\];$/m);
    });
  });
});
