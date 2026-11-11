// The SFDX projects in tests/fixtures (at the repo root) that these tests use, and installing the mapper into a copy
// of one so TypeScript runs it from source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The folder the fixture projects are in. */
export const fixturesDir = path.join(import.meta.dirname, "../../../tests/fixtures");
/** An SFDX project with three package directories, set up for the content mapper (see its README). */
export const exampleProject = path.join(fixturesDir, "example-project");
/** An SFDX project whose custom labels are decomposed (`decomposeCustomLabelsBeta2`). */
export const decomposedLabels = path.join(fixturesDir, "decomposed-labels");

/** This package. */
const packageDir = path.join(import.meta.dirname, "..");
/** The mapper's package.json, whose name and version TypeScript identifies the mapper by. */
export const mapperManifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

/**
 * Installs the content mapper into `projectDir`'s node_modules so TypeScript runs it from source: a
 * stand-in package with the mapper's name, version and manifest, whose `exec` runs its `src/server.ts`
 * with this Node.js and the `@lwc-bolts/source` export condition, so the workspace packages it uses
 * (sf2ts, ...) load from source too. Nothing has to be built first.
 */
export function installContentMapperFromSource(projectDir: string): void {
  const manifest = mapperManifest;
  const standIn = path.join(projectDir, "node_modules", manifest.name);
  mkdirSync(standIn, { recursive: true });
  const contentMapper = {
    ...manifest.typescript.contentMapper,
    exec: [process.execPath, "--conditions=@lwc-bolts/source", path.join(packageDir, "src/server.ts")],
  };
  writeFileSync(
    path.join(standIn, "package.json"),
    JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", typescript: { contentMapper } }, null, 2) + "\n",
  );
}
