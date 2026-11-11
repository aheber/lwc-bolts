// Generates src/components.generated.ts, the `lightning-*` base components' definitions, from the two
// sources pinned in lightning/sources.json and the manual changes in lightning/overrides.jsonc.
//
//   npm run generate               # the pinned versions
//   npm run generate -- --update   # the sources' latest versions, which it pins
//
// See scripts/lightning/import.ts for how the sources and the overrides are combined.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseTemplate } from "@lwc/template-compiler";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
  applyOverrides,
  consolidate,
  importJestStubs,
  importLanguageServer,
  MEMBER_KINDS,
  type MemberKind,
  renderModule,
  validateOverrides,
} from "./lightning/import.ts";

const PACKAGE_DIR = path.join(import.meta.dirname, "..");
const SOURCES = path.join(PACKAGE_DIR, "lightning/sources.json");
const OVERRIDES = path.join(PACKAGE_DIR, "lightning/overrides.jsonc");
const OUTPUT = path.join(PACKAGE_DIR, "src/components.generated.ts");

const LANGUAGE_SERVER = "@salesforce/lwc-language-server";
const JEST = "@salesforce/sfdx-lwc-jest";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message: string): never {
  console.error(`generate: ${message}`);
  process.exit(1);
}

/** The property names LWC sets for a tag's attributes, from compiling a template that uses them. */
function toProperties(tag: string, attributes: string[]): [string, string][] {
  const template = `<template><${tag} ${attributes.map((name) => `${name}={x}`).join(" ")}></${tag}></template>`;
  const element = parseTemplate(template, {}).root?.children?.[0] as { properties?: { name: string; attributeName: string }[] } | undefined;
  return (element?.properties ?? []).map((property) => [property.name, property.attributeName]);
}

/** Downloads a package's tarball and extracts `paths` from it into `work`. */
function fetchPackage(name: string, version: string, work: string, paths: string[]): Record<string, string> {
  const [packed] = JSON.parse(
    execFileSync(npm, ["pack", `${name}@${version}`, "--json", "--pack-destination", work], { encoding: "utf8" }),
  );
  const destination = path.join(work, name.replace(/[@/]/g, "_"));
  execFileSync("tar", ["-xzf", path.join(work, packed.filename), "-C", work]);
  // npm packs into package/; keep each package's files apart
  renameSync(path.join(work, "package"), destination);
  return Object.fromEntries(paths.map((relative) => [relative, path.join(destination, relative)]));
}

const sources: Record<string, string> = JSON.parse(readFileSync(SOURCES, "utf8"));
if (process.argv.includes("--update")) {
  for (const name of [LANGUAGE_SERVER, JEST]) {
    const latest = execFileSync(npm, ["view", name, "version"], { encoding: "utf8" }).trim();
    if (latest !== sources[name]) {
      console.log(`${name}: ${sources[name]} -> ${latest}`);
      sources[name] = latest;
    }
  }
  writeFileSync(SOURCES, JSON.stringify(sources, null, 2) + "\n");
}

const errors: ParseError[] = [];
const overrides = parseJsonc(readFileSync(OVERRIDES, "utf8"), errors, { allowTrailingComma: true });
if (errors.length > 0) {
  fail(
    `${path.relative(process.cwd(), OVERRIDES)} isn't valid JSONC: ${errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ")}`,
  );
}
const problems = validateOverrides(overrides);
if (problems.length > 0) {
  fail(`${path.relative(process.cwd(), OVERRIDES)}:\n  ${problems.join("\n  ")}`);
}

const work = mkdtempSync(path.join(tmpdir(), "lwc-bolts-lightning-"));
try {
  const server = fetchPackage(LANGUAGE_SERVER, sources[LANGUAGE_SERVER]!, work, [
    "lib/resources/transformed-lwc-standard.json",
    "LICENSE.txt",
  ]);
  const jest = fetchPackage(JEST, sources[JEST]!, work, ["src/lightning-stubs", "LICENSE"]);

  const stubsDir = jest["src/lightning-stubs"]!;
  const stubs = readdirSync(stubsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [{ folder: entry.name, source: readFileSync(path.join(stubsDir, entry.name, `${entry.name}.js`), "utf8") }];
      } catch {
        return [];
      }
    });

  const imported = consolidate(
    importLanguageServer(JSON.parse(readFileSync(server["lib/resources/transformed-lwc-standard.json"]!, "utf8")), toProperties),
    importJestStubs(stubs),
  );
  const { components, warnings } = applyOverrides(imported, overrides);
  writeFileSync(
    OUTPUT,
    renderModule(components, [
      { name: LANGUAGE_SERVER, version: sources[LANGUAGE_SERVER]!, license: readFileSync(server["LICENSE.txt"]!, "utf8") },
      { name: JEST, version: sources[JEST]!, license: readFileSync(jest.LICENSE!, "utf8") },
    ]),
  );

  const count = (kind: MemberKind) =>
    Object.values(components).reduce((total, component) => total + Object.keys(component[kind]).length, 0);
  console.log(
    `Wrote ${Object.keys(components).length} components (${MEMBER_KINDS.map((kind) => `${count(kind)} ${kind}`).join(", ")}) to ${path.relative(process.cwd(), OUTPUT)}`,
  );
  for (const warning of warnings) {
    console.warn(`warning: ${path.relative(process.cwd(), OVERRIDES)}: ${warning}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
