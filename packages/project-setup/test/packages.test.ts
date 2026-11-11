// Unit tests for the packages a set-up project needs installed, and for limiting a config's restores.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import * as config from "../src/index.ts";

const projects: string[] = [];
after(() => projects.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The PATH, with nothing on it, so the machine's own tsc doesn't count. */
const bin = realpathSync(mkdtempSync(path.join(tmpdir(), "project-setup-bin-")));
projects.push(bin);
process.env.PATH = bin;

/** A `tsc` executable of this version. */
function writeTsc(file: string, version: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho "Version ${version}"\n`, { mode: 0o755 });
}

/** Puts a `tsc` of this version on the PATH until the test ends. */
function globalTsc(t: TestContext, version: string): void {
  writeTsc(path.join(bin, "tsc"), version);
  t.after(() => rmSync(path.join(bin, "tsc")));
}

/** A project with these packages installed in its node_modules, by name and version. */
function projectWith(installed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "project-setup-packages-"));
  projects.push(dir);
  for (const [name, version] of Object.entries(installed)) {
    mkdirSync(path.join(dir, "node_modules", name), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  }
  return dir;
}

describe("supportsContentMappers", () => {
  it("accepts TypeScript 7.1 and later, prereleases of 7.1 included", () => {
    for (const version of ["7.1.0-beta", "7.1.0", "7.2.3", "8.0.0", "v7.1.0"]) {
      assert.equal(config.supportsContentMappers(version), true, version);
    }
    for (const version of ["7.0.0", "6.9.9", "5.9.3", "7.1", "dev"]) {
      assert.equal(config.supportsContentMappers(version), false, version);
    }
  });
});

describe("typescriptError", () => {
  it("accepts the project's TypeScript 7.1 and later, prereleases of 7.1 included", () => {
    assert.equal(config.typescriptError(projectWith({ typescript: "7.1.0-beta" })), undefined);
    assert.equal(config.typescriptError(projectWith({ typescript: "7.2.0" })), undefined);
  });

  it("names the path it tested and the version it found, or that there's none", () => {
    const root = realpathSync(projectWith({ typescript: "5.9.3" }));
    assert.ok(config.typescriptError(root)!.error.includes(`but ${path.join(root, "node_modules/typescript")} is 5.9.3.`));
    assert.match(config.typescriptError(projectWith({}))!.error, /but it isn't installed in the project or globally\./);
  });

  it("uses the global tsc when the project has no TypeScript", (t) => {
    globalTsc(t, "7.1.0-beta");
    assert.equal(config.typescriptError(projectWith({})), undefined);
    assert.deepEqual(config.missingPackages(projectWith({ [config.CONTENT_MAPPER_PACKAGE]: "1.0.0" })), []);
  });

  it("reports an old global tsc by its path, which installing TypeScript in the project fixes", (t) => {
    globalTsc(t, "5.9.3");
    const problem = config.typescriptError(projectWith({}))!;
    assert.ok(problem.error.includes(`but ${path.join(bin, "tsc")} is 5.9.3. Install it`));
    assert.deepEqual(problem.missing, [config.CONTENT_MAPPER_PACKAGE, config.TYPESCRIPT_PACKAGE]);
  });

  it("skips relative PATH entries, which aren't global", (t) => {
    const root = projectWith({});
    writeTsc(path.join(root, "tsc"), "7.2.0");
    process.env.PATH = `.${path.delimiter}${bin}`;
    t.after(() => (process.env.PATH = bin));
    assert.ok(config.typescriptError(root));
  });

  it("doesn't let a newer global tsc make up for the project's old TypeScript", (t) => {
    globalTsc(t, "7.1.0");
    assert.match(config.typescriptError(projectWith({ typescript: "5.9.3" }))!.error, /is 5\.9\.3/);
  });

  it("tests typescriptPath instead of the project's and the global one, relative to the project", (t) => {
    globalTsc(t, "7.1.0");
    const root = projectWith({ typescript: "7.1.0", "tools/old": "5.9.3", "tools/new": "7.2.0" });
    const old = { typescriptPath: "node_modules/tools/old" };
    const problem = config.typescriptError(root, old)!;
    assert.ok(problem.error.includes(`but ${path.join(root, "node_modules/tools/old")} is 5.9.3. Use a newer one`));
    assert.equal(problem.missing, undefined, "installing TypeScript in the project wouldn't change which one is used");
    const newer = { typescriptPath: path.join(root, "node_modules/tools/new") };
    assert.equal(config.typescriptError(projectWith({ typescript: "5.9.3" }), newer), undefined);
    assert.deepEqual(config.missingPackages(root, old), [config.CONTENT_MAPPER_PACKAGE, config.TYPESCRIPT_PACKAGE]);
  });

  it("takes an SDK's folder, its lib or bin folder, or a folder with a tsc", () => {
    const root = projectWith({ "tools/sdk": "7.2.0" });
    const sdk = path.join(root, "node_modules/tools/sdk");
    for (const typescriptPath of [sdk, path.join(sdk, "lib"), path.join(sdk, "bin")]) {
      assert.equal(config.typescriptError(root, { typescriptPath }), undefined, typescriptPath);
    }
    writeTsc(path.join(root, "bare/tsc"), "7.2.0");
    assert.equal(config.typescriptError(root, { typescriptPath: "bare" }), undefined);
    writeTsc(path.join(root, "bare/tsc"), "5.9.3");
    assert.ok(config.typescriptError(root, { typescriptPath: "bare" })!.error.includes(`${path.join(root, "bare/tsc")} is 5.9.3`));
  });

  it("runs a tsc executable, or a tsc script with node, for its version", (t) => {
    const root = projectWith({});
    const tsc = path.join(root, "sdk/tsc");
    writeTsc(tsc, "7.2.0");
    assert.equal(config.typescriptError(root, { typescriptPath: tsc }), undefined);
    writeTsc(tsc, "5.9.3");
    assert.ok(config.typescriptError(root, { typescriptPath: tsc })!.error.includes(`${tsc} is 5.9.3`));
    const script = path.join(root, "sdk/tsc.js");
    writeFileSync(script, `console.log("Version 7.2.0");`);
    process.env.PATH = path.dirname(process.execPath);
    t.after(() => (process.env.PATH = bin));
    assert.equal(config.typescriptError(root, { typescriptPath: script }), undefined);
  });

  it("names the path when it can't read a version from a file", () => {
    const root = projectWith({ "tools/sdk": "7.2.0" });
    const notTsc = path.join(root, "notes.txt");
    writeFileSync(notTsc, "");
    const problem = config.typescriptError(root, { typescriptPath: notTsc })!;
    assert.ok(problem.error.includes(`no TypeScript version could be read from ${notTsc}.`));
  });

  it("doesn't look further when typescriptPath has no TypeScript, and offers the install when it's the project's own", (t) => {
    globalTsc(t, "7.1.0");
    const root = projectWith({ typescript: "7.1.0" });
    const elsewhere = config.typescriptError(root, { typescriptPath: "nowhere" })!;
    assert.ok(elsewhere.error.includes(`no TypeScript version could be read from ${path.join(root, "nowhere")}.`));
    assert.equal(elsewhere.missing, undefined);
    const own = config.typescriptError(projectWith({}), { typescriptPath: "node_modules/typescript" })!;
    assert.deepEqual(own.missing, [config.CONTENT_MAPPER_PACKAGE, config.TYPESCRIPT_PACKAGE]);
  });
});

describe("missingPackages", () => {
  it("lists the mapper and TypeScript 7.1 when neither is installed", () => {
    assert.deepEqual(config.missingPackages(projectWith({})), [config.CONTENT_MAPPER_PACKAGE, config.TYPESCRIPT_PACKAGE]);
  });

  it("lists TypeScript when the project's can't run content mappers", () => {
    const root = projectWith({ [config.CONTENT_MAPPER_PACKAGE]: "1.0.0", typescript: "5.9.3" });
    assert.deepEqual(config.missingPackages(root), [config.TYPESCRIPT_PACKAGE]);
    assert.equal(config.installedVersion(root, "typescript"), "5.9.3");
  });

  it("lists nothing when both are installed, and sees a version installed since", () => {
    const root = projectWith({ [config.CONTENT_MAPPER_PACKAGE]: "1.0.0", typescript: "7.1.0-beta" });
    assert.deepEqual(config.missingPackages(root), []);
    writeFileSync(path.join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.0.0" }));
    assert.deepEqual(config.missingPackages(root), [config.TYPESCRIPT_PACKAGE]);
  });
});

describe("recommendedPackages", () => {
  it("recommends the Lightning types until they're installed", () => {
    assert.deepEqual(config.recommendedPackages(projectWith({})), ["@salesforce/lightning-types"]);
    assert.deepEqual(config.recommendedPackages(projectWith({ [config.LIGHTNING_TYPES_PACKAGE]: "0.10.1" })), []);
  });
});

describe("KNOWN_VERSIONS", () => {
  it("knows the mapper's version in this repo, and the TypeScript setup installs", () => {
    const mapper = JSON.parse(readFileSync(new URL("../../typescript-content-mapper/package.json", import.meta.url), "utf8"));
    assert.equal(config.KNOWN_VERSIONS[config.CONTENT_MAPPER_PACKAGE], mapper.version);
    assert.equal(`typescript@${config.KNOWN_VERSIONS.typescript}`, config.TYPESCRIPT_PACKAGE);
    assert.ok(config.KNOWN_VERSIONS[config.LIGHTNING_TYPES_PACKAGE]);
  });
});

describe("compareVersions", () => {
  it("orders versions as semver does", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.2.0",
      "10.0.0",
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        assert.equal(config.compareVersions(ordered[i]!, ordered[j]!), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
      }
    }
  });

  it("ignores build metadata, and treats a version it can't read as equal", () => {
    assert.equal(config.compareVersions("1.0.0+build.5", "1.0.0"), 0);
    assert.equal(config.compareVersions("latest", "1.0.0"), 0);
  });
});

describe("outdatedPackages", () => {
  const known = config.KNOWN_VERSIONS;

  it("lists the installed packages older than the known versions, with what to install", () => {
    const root = projectWith({
      [config.CONTENT_MAPPER_PACKAGE]: "0.9.0",
      typescript: "7.1.0-alpha",
      [config.LIGHTNING_TYPES_PACKAGE]: "0.1.0",
    });
    assert.deepEqual(config.outdatedPackages(root), [
      {
        name: config.CONTENT_MAPPER_PACKAGE,
        installed: "0.9.0",
        known: known[config.CONTENT_MAPPER_PACKAGE],
        spec: `${config.CONTENT_MAPPER_PACKAGE}@${known[config.CONTENT_MAPPER_PACKAGE]}`,
      },
      { name: "typescript", installed: "7.1.0-alpha", known: known.typescript, spec: config.TYPESCRIPT_PACKAGE },
      {
        name: config.LIGHTNING_TYPES_PACKAGE,
        installed: "0.1.0",
        known: known[config.LIGHTNING_TYPES_PACKAGE],
        spec: `${config.LIGHTNING_TYPES_PACKAGE}@${known[config.LIGHTNING_TYPES_PACKAGE]}`,
      },
    ]);
  });

  it("leaves out packages that are missing, current or newer, and a TypeScript older than 7", () => {
    assert.deepEqual(config.outdatedPackages(projectWith({})), []);
    const root = projectWith({
      [config.CONTENT_MAPPER_PACKAGE]: known[config.CONTENT_MAPPER_PACKAGE]!,
      typescript: "5.9.3",
      [config.LIGHTNING_TYPES_PACKAGE]: "99.0.0",
    });
    assert.deepEqual(config.outdatedPackages(root), []);
  });
});

describe("RewriteLimiter", () => {
  it("stops restoring a file once it's restored MAX_REWRITES times within REWRITE_WINDOW, and says so once", () => {
    let now = 0;
    const limiter = new config.RewriteLimiter({ now: () => now });
    for (let i = 0; i < config.MAX_REWRITES; i++) {
      assert.equal(limiter.rewrite("a"), "write");
      now += 1000;
    }
    assert.equal(limiter.rewrite("b"), "write", "each file is counted on its own");
    assert.equal(limiter.rewrite("a"), "stop");
    now += config.REWRITE_WINDOW * 2;
    assert.equal(limiter.rewrite("a"), "stopped", "a file it stopped restoring stays stopped");
  });

  it("only counts the restores within the window", () => {
    let now = 0;
    const limiter = new config.RewriteLimiter({ now: () => now });
    for (let i = 0; i < config.MAX_REWRITES * 3; i++) {
      assert.equal(limiter.rewrite("a"), "write");
      now += config.REWRITE_WINDOW / (config.MAX_REWRITES - 1);
    }
  });
});
