// What this package keeps its own copy of from the content mapper, which it doesn't depend on: these check
// the copies against the mapper's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { LWC_CONFIG_FILES as MAPPER_LWC_CONFIG_FILES, METADATA_TYPES, OPTION_DEFAULTS } from "@lwc-bolts/typescript-content-mapper/options";
import { CONTENT_MAPPER_PACKAGE, DEFAULT_LWC_CONFIG_FILE, LWC_CONFIG_FILES } from "../src/index.ts";
import { CACHED_TYPES } from "../src/managed.ts";

describe("the content mapper", () => {
  it("is the package a config registers", () => {
    const manifest = createRequire(import.meta.url).resolve("@lwc-bolts/typescript-content-mapper/package.json");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).name, CONTENT_MAPPER_PACKAGE);
  });

  it("validates lwcConfigFile against the files setup writes", () => {
    assert.deepEqual([...LWC_CONFIG_FILES], [...MAPPER_LWC_CONFIG_FILES]);
    assert.equal(DEFAULT_LWC_CONFIG_FILE, OPTION_DEFAULTS.lwcConfigFile);
  });

  it("converts every metadata type the managed cache has", () => {
    assert.deepEqual(
      CACHED_TYPES.filter((type) => !(METADATA_TYPES as readonly string[]).includes(type)),
      [],
    );
  });
});
