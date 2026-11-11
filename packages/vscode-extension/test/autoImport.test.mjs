// Unit tests for the auto-import rewrites (`npm run build` first).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { componentSpecifier, otherBundleTemplate, rewriteCodeActions, rewriteCompletions, rewriteImportText, rewriteResolvedCompletion } =
  await import("../dist/autoImport.js");

// A project with bundles `recordCard` and `utils` (both with metadata), and `draft` (without).
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-autoimport-")));
after(() => rmSync(root, { recursive: true, force: true }));
const lwc = path.join(root, "force-app/main/default/lwc");
for (const [name, metadata] of [
  ["recordCard", true],
  ["utils", true],
  ["draft", false],
]) {
  mkdirSync(path.join(lwc, name, "__tests__"), { recursive: true });
  writeFileSync(path.join(lwc, name, `${name}.js`), "");
  if (metadata) {
    writeFileSync(path.join(lwc, name, `${name}.js-meta.xml`), "<LightningComponentBundle/>");
  }
}
const importer = path.join(lwc, "recordCard/recordCard.js");

describe("componentSpecifier", () => {
  it("rewrites relative paths to another bundle's main module", () => {
    for (const specifier of ["../utils/utils", "../utils/utils.js", "../utils/utils.ts", "./../utils/utils"]) {
      assert.equal(componentSpecifier(importer, specifier), "c/utils", specifier);
    }
    assert.equal(componentSpecifier(path.join(lwc, "recordCard/__tests__/recordCard.test.js"), "../../utils/utils"), "c/utils");
  });

  it("leaves imports within the importer's own bundle relative, including from its tests", () => {
    assert.equal(componentSpecifier(importer, "./recordCard"), undefined);
    assert.equal(componentSpecifier(path.join(lwc, "recordCard/__tests__/recordCard.test.js"), "../recordCard"), undefined);
  });

  it("leaves other files and folders alone", () => {
    assert.equal(componentSpecifier(importer, "../utils/helpers"), undefined, "not the bundle's main module");
    assert.equal(componentSpecifier(importer, "../draft/draft"), undefined, "no .js-meta.xml");
    assert.equal(componentSpecifier(path.join(root, "src/app.js"), "../lib/lib"), undefined, "not in an lwc folder");
    assert.equal(componentSpecifier(importer, "c/utils"), undefined, "not relative");
    assert.equal(componentSpecifier(importer, "lwc"), undefined);
  });
});

describe("otherBundleTemplate", () => {
  it("finds relative paths to another bundle's templates", () => {
    assert.equal(otherBundleTemplate(importer, "../utils/utils.html"), true);
    assert.equal(otherBundleTemplate(importer, "../utils/views/compact.HTML"), true);
    assert.equal(otherBundleTemplate(path.join(lwc, "recordCard/__tests__/recordCard.test.js"), "../../utils/utils.html"), true);
  });

  it("leaves the importer's own templates and anything else alone", () => {
    assert.equal(otherBundleTemplate(importer, "./recordCard.html"), false);
    assert.equal(otherBundleTemplate(importer, "./views/compact.html"), false);
    assert.equal(otherBundleTemplate(path.join(lwc, "recordCard/__tests__/recordCard.test.js"), "../recordCard.html"), false);
    assert.equal(otherBundleTemplate(importer, "../utils/utils"), false, "not a template");
    assert.equal(otherBundleTemplate(importer, "c/utils.html"), false, "not relative");
    assert.equal(otherBundleTemplate(path.join(root, "src/app.js"), "../pages/page.html"), false, "not in an lwc folder");
  });
});

describe("another bundle's templates", () => {
  const item = (label, moduleSpecifier) => ({ label, data: { fileName: importer, autoImport: { moduleSpecifier } } });

  it("drops their completions, and keeps the bundle's own", () => {
    const own = item("compactTemplate", "./views/compact.html");
    const items = [own, item("utilsTemplate", "../utils/utils.html")];
    assert.deepEqual(rewriteCompletions(items), [own]);
    assert.deepEqual(rewriteCompletions({ isIncomplete: false, items }).items, [own]);
  });

  it("drops their quick fixes, and keeps the bundle's own", () => {
    const own = { title: 'Add import from "./views/compact.html"' };
    const actions = [own, { title: 'Add import from "../utils/utils.html"' }];
    assert.deepEqual(rewriteCodeActions(actions, pathToFileURL(importer).href), [own]);
  });
});

describe("rewriteImportText", () => {
  it("rewrites specifiers in imports, dynamic imports, requires and fix titles", () => {
    assert.equal(
      rewriteImportText(
        `import { data } from "../utils/utils";\nimport Card from './../utils/utils.js';\nconst m = import("../utils/utils");\nrequire("../utils/utils");\nimport "../utils/utils";`,
        importer,
      ),
      `import { data } from "c/utils";\nimport Card from 'c/utils';\nconst m = import("c/utils");\nrequire("c/utils");\nimport "c/utils";`,
    );
    assert.equal(rewriteImportText('Add import from "../utils/utils"', importer), 'Add import from "c/utils"');
    assert.equal(rewriteImportText('import { x } from "./helpers";', importer), 'import { x } from "./helpers";');
  });
});

/** A completion item as TypeScript 7's language server sends an auto-import. */
const autoImportItem = (label, moduleSpecifier, importKind = 0) => ({
  label,
  labelDetails: { description: moduleSpecifier },
  kind: 6,
  data: {
    fileName: importer,
    position: 10,
    source: moduleSpecifier,
    name: label,
    autoImport: { kind: 3, name: label, importKind, addAsTypeOnly: 4, moduleSpecifier, importIndex: 0 },
  },
});

describe("rewriteCompletions", () => {
  it("points auto-imports of another bundle's exports at its c/ module", () => {
    const local = { label: "value", kind: 6 };
    const result = rewriteCompletions({ isIncomplete: false, items: [local, autoImportItem("data", "../utils/utils")] });
    assert.equal(result.isIncomplete, false);
    assert.equal(result.items[0], local);
    assert.deepEqual(result.items[1], autoImportItem("data", "c/utils"));
  });

  it("drops a rewritten item that duplicates one already offered from c/", () => {
    const fromComponent = autoImportItem("Utils", "c/utils", 1);
    const items = rewriteCompletions([autoImportItem("Utils", "../utils/utils", 1), fromComponent]);
    assert.deepEqual(items, [fromComponent]);
  });

  it("keeps items of different import kinds from the same module", () => {
    const items = rewriteCompletions([autoImportItem("Utils", "c/utils", 1), autoImportItem("Utils", "../utils/utils", 0)]);
    assert.deepEqual(
      items.map((item) => [item.data.autoImport.moduleSpecifier, item.data.autoImport.importKind]),
      [
        ["c/utils", 1],
        ["c/utils", 0],
      ],
    );
  });

  it("returns the result unchanged when nothing is rewritten", () => {
    const list = { isIncomplete: true, items: [autoImportItem("helper", "./helpers"), { label: "x" }] };
    assert.equal(rewriteCompletions(list), list);
    assert.equal(rewriteCompletions(null), null);
  });
});

describe("rewriteResolvedCompletion", () => {
  it("rewrites the import edit and description", () => {
    const item = {
      ...autoImportItem("data", "../utils/utils"),
      detail: 'Add import from "../utils/utils"',
      additionalTextEdits: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'import { data } from "../utils/utils";\n',
        },
      ],
    };
    const resolved = rewriteResolvedCompletion(item);
    assert.equal(resolved.detail, 'Add import from "c/utils"');
    assert.equal(resolved.additionalTextEdits[0].newText, 'import { data } from "c/utils";\n');
  });

  it("leaves items without auto-import data alone", () => {
    const item = { label: "x", detail: 'from "../utils/utils"' };
    assert.equal(rewriteResolvedCompletion(item), item);
  });
});

describe("rewriteCodeActions", () => {
  const uri = pathToFileURL(importer).href;
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const addImport = (specifier) => ({
    title: `Add import from "${specifier}"`,
    kind: "quickfix",
    edit: { changes: { [uri]: [{ range, newText: `import { data } from "${specifier}";\n\n` }] } },
  });

  it("rewrites the title and the edit of an Add import fix", () => {
    assert.deepEqual(rewriteCodeActions([addImport("../utils/utils")], uri), [addImport("c/utils")]);
  });

  it("rewrites document changes", () => {
    const action = {
      title: 'Add import from "../utils/utils"',
      edit: { documentChanges: [{ textDocument: { uri, version: 1 }, edits: [{ range, newText: 'import "../utils/utils";' }] }] },
    };
    const [fixed] = rewriteCodeActions([action], uri);
    assert.equal(fixed.edit.documentChanges[0].edits[0].newText, 'import "c/utils";');
  });

  it("drops a rewritten fix that duplicates one already offered, and keeps commands", () => {
    const command = { title: 'Add import from "../utils/utils"', command: "some.command" };
    assert.deepEqual(rewriteCodeActions([addImport("../utils/utils"), addImport("c/utils"), command], uri), [
      addImport("c/utils"),
      command,
    ]);
  });

  it("leaves other fixes and documents alone", () => {
    const other = addImport("./helpers");
    assert.deepEqual(rewriteCodeActions([other], uri), [other]);
    assert.equal(rewriteCodeActions(null, uri), null);
    const untitled = [addImport("../utils/utils")];
    assert.equal(rewriteCodeActions(untitled, "untitled:Untitled-1"), untitled);
  });
});
