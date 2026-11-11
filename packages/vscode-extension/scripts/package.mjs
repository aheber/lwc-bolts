// Packages the extension as a .vsix (or publishes it with `--publish`).
//
// The extension is an npm workspace, so its dependencies are symlinks into the monorepo and hoisted to the
// root node_modules, which `vsce` can't package. Instead, this copies the compiled extension into a staging
// directory outside the monorepo, installs its dependencies there, and runs `vsce` there.
//
// By default the dependencies come from the npm registry: the .vsix ships the published @lwc-bolts packages
// (including the content mapper TypeScript 7 runs), so a change to one of them reaches the extension only once
// that package is published.
//
// `--local` is for testing unpublished changes: it builds and packs the workspace packages into tarballs and
// installs those instead, as they would be installed from the registry. The result is written as
// `<name>-<version>-local.vsix` and can't be published.
//
// `npm run build:extension` (or `build:extension:local`) builds the extension first.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(extensionDir, "../..");
const publish = process.argv.includes("--publish");
const local = process.argv.includes("--local");

if (publish && local) {
  throw new Error("--local packages unpublished workspace copies and can't be combined with --publish");
}

/** Workspace packages shipped in the extension's node_modules; `--local` installs these from tarballs. */
const WORKSPACE_PACKAGES = [
  "@lwc-bolts/lightning-base-components",
  "@lwc-bolts/sf2ts",
  "@lwc-bolts/sfdx-project",
  "@lwc-bolts/project-setup",
  "@lwc-bolts/typescript-content-mapper",
];

/** Extension files copied into the staging directory (the rest of the package is filtered by .vscodeignore). */
const EXTENSION_FILES = ["dist", "assets", "docs", "l10n", "package.nls.json", "README.md", "LICENSE.md", ".vscodeignore"];

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const vsce = path.join(repoRoot, "node_modules/.bin", process.platform === "win32" ? "vsce.cmd" : "vsce");
const ovsx = path.join(repoRoot, "node_modules/.bin", process.platform === "win32" ? "ovsx.cmd" : "ovsx");

if (!existsSync(path.join(extensionDir, "dist/extension.js"))) {
  throw new Error("dist/extension.js is missing; run `npm run build` first");
}

const manifest = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8"));
const dependencies = { ...manifest.dependencies };

if (!local) {
  // Fail early, with a clear message, when a dependency has no published version in its range.
  const unpublished = Object.entries(dependencies).filter(([name, range]) => {
    try {
      return execFileSync(npm, ["view", `${name}@${range}`, "version"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim() === "";
    } catch {
      return true;
    }
  });
  if (unpublished.length > 0) {
    throw new Error(`Not published to the npm registry: ${unpublished.map(([name, range]) => `${name}@${range}`).join(", ")}`);
  }
}

delete manifest.devDependencies;
// Already compiled; the staging directory has no TypeScript to run `vscode:prepublish` with.
delete manifest.scripts["vscode:prepublish"];

const staging = mkdtempSync(path.join(tmpdir(), "lwc-bolts-vscode-"));
try {
  const tarballDir = path.join(staging, "tarballs");
  if (local) {
    // Each package's `prepack` script builds it, so packing ships its current source.
    mkdirSync(tarballDir);
    /** @type {Record<string, string>} */
    const tarballs = {};
    for (const name of WORKSPACE_PACKAGES) {
      const [packed] = JSON.parse(run(npm, ["pack", "-w", name, "--json", "--pack-destination", tarballDir], repoRoot));
      tarballs[name] = `file:./tarballs/${packed.filename}`;
    }
    // Install the tarballs in place of the registry versions. `overrides` resolves every workspace package,
    // however deep, to its tarball, so the published copies don't come in through another package.
    for (const name of Object.keys(manifest.dependencies)) {
      if (tarballs[name] !== undefined) {
        manifest.dependencies[name] = tarballs[name];
      }
    }
    manifest.overrides = { ...tarballs };
  }

  writeFileSync(path.join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const file of EXTENSION_FILES) {
    cpSync(path.join(extensionDir, file), path.join(staging, file), { recursive: true });
  }
  // The staging directory is outside the monorepo, so npm doesn't link the workspace packages.
  run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], staging);

  if (local) {
    // Ship the real version ranges rather than the staging-only tarball specs (the installed versions satisfy
    // them, which `vsce` checks), and leave the tarballs out of the package.
    delete manifest.overrides;
    manifest.dependencies = dependencies;
    writeFileSync(path.join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    rmSync(tarballDir, { recursive: true });
  }

  const vsix = path.join(extensionDir, `${manifest.name}-${manifest.version}${local ? "-local" : ""}.vsix`);
  run(vsce, ["package", "--out", vsix], staging);
  console.log(`Packaged ${path.relative(process.cwd(), vsix)}${local ? " (local workspace packages; for testing only)" : ""}`);
  if (publish) {
    run(vsce, ["publish", "--packagePath", vsix], staging);
    run(ovsx, ["publish", vsix], staging);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
