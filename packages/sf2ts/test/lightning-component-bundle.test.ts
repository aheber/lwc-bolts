import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultExportName, MetadataType, type LightningComponentBundleComponent } from "../src/index.ts";
import { convertOne, mappedText, typeCheck } from "./helpers.ts";

function bundle(name: string, body: string = "<apiVersion>62.0</apiVersion><isExposed>false</isExposed>") {
  return {
    path: `force-app/main/default/lwc/${name}/${name}.js-meta.xml`,
    type: MetadataType.LightningComponentBundle,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    ${body}
</LightningComponentBundle>
`,
  };
}

/** A bundle's metadata with its module's default export, read from `source` as the content mapper reads it. */
async function withSource(component: LightningComponentBundleComponent, source: string): Promise<LightningComponentBundleComponent> {
  const name = await defaultExportName(source);
  return { ...component, ...(name !== undefined && { defaultExportName: name }) };
}

describe("Convert:LightningComponentBundle", async () => {
  it("Declares the c/ module by re-exporting the component's module", async (t) => {
    const converted = await convertOne(
      bundle(
        "recordCard",
        "<apiVersion>62.0</apiVersion><isExposed>true</isExposed><masterLabel>Record Card</masterLabel><description>Shows a record.</description>",
      ),
    );
    t.assert.snapshot(converted.text);
    assert.deepEqual(mappedText(converted), [[`"c/recordCard"`, "Record Card"]]);
  });

  it("Converts a bundle's metadata and templates, whatever their extensions' case", async () => {
    const [metadata, template] = await Promise.all([
      convertOne({
        path: "lwc/card/card.JS-META.XML",
        type: MetadataType.LightningComponentBundle,
        content: "<LightningComponentBundle/>",
      }),
      convertOne({ path: "lwc/card/card.HTML", type: MetadataType.LightningComponentBundle, content: "<template></template>" }),
    ]);
    assert.match(metadata.text, /^declare module "c\/card"/m);
    assert.match(template.text, /^import type __Component from "\.\/card\.js";$/m);
    assert.deepEqual([metadata.diagnostics, template.diagnostics], [undefined, undefined]);
  });

  it("Reports a bundle's other files as files it doesn't convert", async () => {
    for (const path of ["lwc/card/card.js", "lwc/card/card.css", "lwc/card/__tests__/card.test.js", "lwc/card/card.xml"]) {
      const content = "/* content */";
      const converted = await convertOne({ path, type: MetadataType.LightningComponentBundle, content });
      assert.equal(converted.text, "", path);
      assert.deepEqual(converted.mapData, [], path);
      assert.deepEqual(converted.diagnostics, [
        {
          kind: "ConversionFailed",
          message: `Unable to convert LightningComponentBundle to TypeScript: ${path.split("/").pop()} isn't a bundle file sf2ts converts; it converts a bundle's <name>.js-meta.xml and .html templates`,
          start: 0,
          length: content.length,
        },
      ]);
    }
  });

  it("Maps a bundle without a label to its root element", async (t) => {
    const converted = await convertOne(bundle("plain"));
    t.assert.snapshot(converted.text);
    assert.deepEqual(mappedText(converted), [[`"c/plain"`, "LightningComponentBundle"]]);
  });

  it("Names the variable after a reserved-word bundle so it stays valid", async () => {
    const converted = await convertOne(bundle("import"));
    assert.match(converted.text, /^  const _import: typeof import\("\.\/import\.js"\);\n  export = _import;$/m);
    assert.deepEqual(
      typeCheck([converted.text]).filter((e) => !e.includes("TS2307")),
      [],
    );
  });

  it("Types default and named imports of the component", async () => {
    const card = await convertOne(bundle("recordCard"));
    const utils = await convertOne(bundle("utils"));
    const errors = typeCheck(
      [],
      `import RecordCard from "c/recordCard";
import { data, format } from "c/utils";
const card: RecordCard = new RecordCard();
const id: string = card.recordId;
const key: string = data.key;
format(1);
// @ts-expect-error data.key is a string
const wrong: number = data.key;
// @ts-expect-error utils has no such export
import { missing } from "c/utils";`,
      {
        // each declaration sits next to the component it re-exports, as it does in a bundle
        "recordCard/recordCard.js": `export default class RecordCard { recordId = ""; }\n`,
        "recordCard/recordCard.meta.ts": card.text,
        "utils/utils.js": `export const data = { key: "value" };\nexport function format(value) { return String(value); }\n`,
        "utils/utils.meta.ts": utils.text,
      },
    );
    assert.deepEqual(errors, []);
  });

  it("Resolves TypeScript components", async () => {
    const card = await convertOne(bundle("recordCard"));
    assert.deepEqual(
      typeCheck([], `import RecordCard from "c/recordCard";\nconst id: string = new RecordCard().recordId;`, {
        "recordCard/recordCard.ts": `export default class RecordCard { recordId = ""; }\n`,
        "recordCard/recordCard.meta.ts": card.text,
      }),
      [],
    );
  });

  describe("names the export after the component's default export", () => {
    // [case, component source, expected variable]
    const cases: [string, string, string][] = [
      ["a named class", "export default class RecordCard extends LightningElement {}", "RecordCard"],
      ["an anonymous class", "export default class extends LightningElement {}", "recordCard"],
      ["a named function", "export default function loadRecords(recordId) {}", "loadRecords"],
      ["a named async function", "export default async function loadRecords() {}", "loadRecords"],
      ["a named generator function", "export default function* records() {}", "records"],
      ["an anonymous function", "export default function (recordId) {}", "recordCard"],
      ["an anonymous async function", "export default async function () {}", "recordCard"],
      ["an arrow function", "export default (recordId) => recordId;", "recordCard"],
      ["a variable", "const formatters = { date: () => '' };\nexport default formatters;", "formatters"],
      ["a variable without a semicolon", "let settings = {}\nexport default settings", "settings"],
      ["a class declared before its export", "class RecordCard extends LightningElement {}\nexport default RecordCard;", "RecordCard"],
      ["an `as default` export", "const card = {}, other = 1;\nexport { card as default, other };", "card"],
      ["an `as default` re-export", 'export { RecordCard as default } from "./card";', "RecordCard"],
      ["a re-exported default", 'export { default } from "./card";', "recordCard"],
      ["an object literal", "export default { recordId: '' };", "recordCard"],
      ["a call", "export default createElement('c-card');", "recordCard"],
      ["a literal", "export default 42;", "recordCard"],
      ["no default export", "export const VERSION = 1;\nexport function format() {}", "recordCard"],
      ["an empty module", "", "recordCard"],
      [
        "decorated members, as LWC components have",
        "import { LightningElement, api, wire } from 'lwc';\nexport default class RecordCard extends LightningElement {\n  @api recordId;\n  @wire(getRecord, { recordId: '$recordId' }) record;\n}",
        "RecordCard",
      ],
      ["a TypeScript class with type parameters", "export default class RecordCard<T> extends LightningElement {}", "RecordCard"],
      ["a TypeScript abstract class", "export default abstract class BaseCard {}", "BaseCard"],
      [
        "`export default` in a comment",
        "// export default class Old {}\n/* export default class Older {} */\nexport const a = 1;",
        "recordCard",
      ],
      [
        "`export default` in strings",
        'const a = "export default class Old {}";\nconst b = `export default ${a}`;\nexport default class Current {}',
        "Current",
      ],
      ["a default export named like a reserved word's prefix", "export default class Newer {}", "Newer"],
      // line breaks between tokens
      ["a class split across lines", "export\ndefault\nclass\nRecordCard\nextends LightningElement {}", "RecordCard"],
      ["CRLF line endings", "export default class\r\nRecordCard\r\nextends LightningElement {}", "RecordCard"],
      ["an abstract class split across lines", "export default abstract\nclass\nBaseCard {}", "BaseCard"],
      ["an anonymous class with extends on the next line", "export default class\nextends LightningElement {}", "recordCard"],
      ["a function name on the next line", "export default function\nloadRecords\n(recordId) {}", "loadRecords"],
      ["a generator's star on its own line", "export default function\n*\nrecords() {}", "records"],
      ["an anonymous function with its parameters on the next line", "export default function\n(recordId) {}", "recordCard"],
      ["a variable on the next line", "export default\nformatters;", "formatters"],
      ["a variable with its semicolon on the next line", "export default formatters\n;", "formatters"],
      ["a variable followed by the next statement", "export default formatters\nexport const VERSION = 1;", "formatters"],
      ["a variable followed by ++ on the next line, which starts a new statement", "export default count\n++other;", "count"],
      ["`as default` split across lines", "const card = {}, other = 1;\nexport {\n  card\n  as\n  default,\n  other\n};", "card"],
      ["comments between tokens", "export default /* the card */\n// main\nclass RecordCard {}", "RecordCard"],
      ["a Unicode line separator", "export default\u2028class RecordCard {}", "RecordCard"],
      // a line break doesn't end `export default <identifier>` when the next line continues the expression
      ["member access on the next line", "export default formatters\n  .date;", "recordCard"],
      ["a call on the next line", 'export default createCard\n  ("c-card");', "recordCard"],
      ["indexing on the next line", "export default cards\n  [0];", "recordCard"],
      ["a tagged template on the next line", "export default tag\n  `card`;", "recordCard"],
      ["optional chaining on the next line", "export default config\n  ?.value;", "recordCard"],
      ["a binary operator on the next line", "export default base\n  + 1;", "recordCard"],
      ["a TypeScript `as` on the next line", "export default card\n  as Card;", "recordCard"],
      ["an identifier ending in $ followed by member access", "export default card$\n  .value;", "recordCard"],
      ["a regular expression literal with quotes before the export", "const r = /`'/;\nexport default class RecordCard {}", "RecordCard"],
      ["`export default undefined`", "export default undefined;", "recordCard"],
      ["a module that doesn't parse", "export default class RecordCard {", "recordCard"],
    ];
    for (const [description, source, variable] of cases) {
      it(description, async () => {
        const converted = await convertOne(await withSource(bundle("recordCard"), source));
        assert.match(
          converted.text,
          new RegExp(`^  const ${variable.replace("$", "\\$")}: typeof import\\("\\./recordCard\\.js"\\);\\n  export = ${variable};$`, "m"),
        );
        assert.equal(await defaultExportName(source), variable === "recordCard" ? undefined : variable);
      });
    }

    it("names the export after the component's defaultExportName, as given", async () => {
      const converted = await convertOne({ ...bundle("recordCard"), defaultExportName: "Card" });
      assert.match(converted.text, /^  const Card: typeof import\("\.\/recordCard\.js"\);$/m);
    });

    it("guards a default export named after a reserved word", async () => {
      // a re-export can name any identifier, including a reserved word
      const converted = await convertOne(await withSource(bundle("recordCard"), 'export { delete as default } from "./other";'));
      assert.match(converted.text, /^  const _delete: /m);
    });

    it("types the component through the renamed export", async () => {
      const card = await convertOne(await withSource(bundle("recordCard"), "export default class RecordCard {}"));
      assert.match(card.text, /const RecordCard: /);
      assert.deepEqual(
        typeCheck(
          [],
          `import RecordCard, { VERSION } from "c/recordCard";
const card: RecordCard = new RecordCard();
const id: string = card.recordId;
const version: number = VERSION;`,
          {
            "recordCard/recordCard.js": `export default class RecordCard { recordId = ""; }\nexport const VERSION = 1;\n`,
            "recordCard/recordCard.meta.ts": card.text,
          },
        ),
        [],
      );
    });
  });
});
