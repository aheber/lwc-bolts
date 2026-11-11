// Checks that the extension's text is ready for translation: the runtime strings in l10n/bundle.l10n.json
// match the vscode.l10n.t calls in src (`npm run l10n:export` regenerates it), and the manifest's
// %placeholders% match package.nls.json.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { getL10nJson } from "@vscode/l10n-dev";

const extensionDir = path.resolve(import.meta.dirname, "..");
const readJson = (file) => JSON.parse(readFileSync(path.join(extensionDir, file), "utf8"));

describe("localization", () => {
  it("has every vscode.l10n.t string in l10n/bundle.l10n.json, and no others (run npm run l10n:export)", async () => {
    const src = path.join(extensionDir, "src");
    const files = readdirSync(src)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ extension: ".ts", contents: readFileSync(path.join(src, name), "utf8") }));
    const extracted = await getL10nJson(files);
    assert.deepEqual(Object.keys(readJson("l10n/bundle.l10n.json")).sort(), Object.keys(extracted).sort());
  });

  it("has a package.nls.json entry for each %placeholder% in package.json, and no others", () => {
    const manifest = readFileSync(path.join(extensionDir, "package.json"), "utf8");
    const placeholders = new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((match) => match[1]));
    assert.deepEqual(Object.keys(readJson("package.nls.json")).sort(), [...placeholders].sort());
  });

  it("names the l10n folder in the manifest, so VS Code loads its translations", () => {
    assert.equal(readJson("package.json").l10n, "./l10n");
  });
});
