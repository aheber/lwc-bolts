// Unit tests for the block and enforce rules that keep configs in shape.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";
import { checkConfig, conformConfig, describePath, type ConfigPolicy } from "../src/rules.ts";

const mapper = { where: "package", equals: "mapper" };

describe("config rules", () => {
  it("removes blocked properties and array entries, keeping comments and the rest", () => {
    const text = `{
  // mine
  "compilerOptions": { "baseUrl": ".", "strict": true },
  "include": [
    "a",
    // b's comment
    "b",
    "**/*"
  ]
}
`;
    const policy: ConfigPolicy = {
      block: [{ path: ["compilerOptions", "baseUrl"] }, { path: ["include"], entries: (entry) => entry === "**/*" || entry === "a" }],
      enforce: [],
    };
    const { text: conformed, changes } = conformConfig(text, policy)!;
    assert.deepEqual(changes, ["removed compilerOptions.baseUrl", `removed "a" from include`, `removed "**/*" from include`]);
    assert.deepEqual(parse(conformed), { compilerOptions: { strict: true }, include: ["b"] });
    assert.match(conformed, /\/\/ mine/);
    assert.match(conformed, /\/\/ b's comment\n\s+"b"/);
    assert.deepEqual(checkConfig(conformed, policy), []);
  });

  it("enforces values, creating the objects on the way, and leaves equal ones alone", () => {
    const policy: ConfigPolicy = {
      block: [],
      enforce: [
        { path: ["files"], value: [] },
        { path: ["compilerOptions", "allowJs"], value: true },
      ],
    };
    const { text, changes } = conformConfig(`{ "files": ["x.ts"] }`, policy)!;
    assert.deepEqual(changes, ["set files to []", "set compilerOptions.allowJs to true"]);
    assert.deepEqual(parse(text), { files: [], compilerOptions: { allowJs: true } });
    assert.deepEqual(conformConfig(text, policy), { text, changes: [] });
    // a value that isn't an object on the way is replaced
    assert.deepEqual(parse(conformConfig(`{ "compilerOptions": null }`, policy)!.text).compilerOptions, { allowJs: true });
  });

  it("adds the entries an array lacks, in order, keeping the others", () => {
    const policy: ConfigPolicy = {
      block: [],
      enforce: [{ path: ["include"], contains: ["a", "b", "c", "d"] }],
    };
    assert.deepEqual(parse(conformConfig(`{ "include": ["mine", "b", "mine2", "d"] }`, policy)!.text).include, [
      "mine",
      "a",
      "b",
      "c",
      "mine2",
      "d",
    ]);
    assert.deepEqual(parse(conformConfig(`{ "include": ["c"] }`, policy)!.text).include, ["a", "b", "c", "d"]);
    assert.deepEqual(parse(conformConfig(`{}`, policy)!.text).include, ["a", "b", "c", "d"]);
    assert.deepEqual(parse(conformConfig(`{ "include": "a" }`, policy)!.text).include, ["a", "b", "c", "d"]);
    // `same` decides what's there already, and `order` places what isn't
    const spelled: ConfigPolicy = {
      block: [],
      enforce: [
        {
          path: ["include"],
          contains: ["x"],
          same: (a, b) => typeof a === "string" && a.replace(/\/$/, "") === b,
          order: ["a", "x", "z"],
        },
      ],
    };
    assert.deepEqual(checkConfig(`{ "include": ["x/"] }`, spelled), []);
    assert.deepEqual(parse(conformConfig(`{ "include": ["z", "a"] }`, spelled)!.text).include, ["z", "a", "x"]);
  });

  it("selects an array's element by a property, adding it when it's missing", () => {
    const policy: ConfigPolicy = {
      block: [{ path: ["contentMappers", mapper, "legacy"] }],
      enforce: [{ path: ["contentMappers", mapper, "extensions"], contains: [".cls", ".html"] }],
    };
    assert.deepEqual(parse(conformConfig(`{}`, policy)!.text).contentMappers, [{ package: "mapper", extensions: [".cls", ".html"] }]);
    const { text, changes } = conformConfig(
      `{ "contentMappers": [{ "package": "other" }, { "package": "mapper", "legacy": 1, "extensions": [".cls"], "options": {} }] }`,
      policy,
    )!;
    assert.deepEqual(changes, [
      `removed contentMappers[package="mapper"].legacy`,
      `added ".html" to contentMappers[package="mapper"].extensions`,
    ]);
    assert.deepEqual(parse(text).contentMappers, [{ package: "other" }, { package: "mapper", extensions: [".cls", ".html"], options: {} }]);
    assert.deepEqual(parse(conformConfig(`{ "contentMappers": [{ "package": "other" }] }`, policy)!.text).contentMappers, [
      { package: "other" },
      { package: "mapper", extensions: [".cls", ".html"] },
    ]);
  });

  it("follows the config's indentation, and leaves invalid JSON alone", () => {
    const policy: ConfigPolicy = { block: [], enforce: [{ path: ["files"], value: [] }] };
    assert.match(conformConfig(`{\n    "include": []\n}`, policy)!.text, /^ {4}"files": \[\]/m);
    assert.equal(conformConfig(`{ not json`, policy), undefined);
    assert.equal(checkConfig(`[]`, policy), undefined);
  });

  it("describes paths for messages", () => {
    assert.equal(describePath(["contentMappers", mapper, "extensions"]), `contentMappers[package="mapper"].extensions`);
    assert.equal(describePath(["compilerOptions", "baseUrl"]), "compilerOptions.baseUrl");
  });
});
