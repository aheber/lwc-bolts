import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Config } from "@oclif/core";
import { SfCommand } from "@salesforce/sf-plugins-core";
import { contentMapperOptions, lwcFolderConfig } from "@lwc-bolts/project-setup";
import ProjectOptionsDisplay from "../src/commands/lwc-bolts/project/options/display.ts";
import ProjectOptionsSet from "../src/commands/lwc-bolts/project/options/set.ts";
import ProjectOptionsUnset from "../src/commands/lwc-bolts/project/options/unset.ts";
import ProjectSetup from "../src/commands/lwc-bolts/project/setup.ts";
import ProjectWatch from "../src/commands/lwc-bolts/project/watch.ts";
import type { ChangeResult, OptionsResult } from "../src/options.ts";

const pluginDir = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];
// each command run adds the CLI's signal listeners
process.setMaxListeners(50);
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// an empty PATH, so the machine's own tsc doesn't count
process.env.PATH = mkdtempSync(path.join(tmpdir(), "lwc-bolts-plugin-bin-"));
tempDirs.push(process.env.PATH);

/** An SFDX project in a temp dir with these package directories, each with an `lwc` folder, the first the default. */
function sfdxProject(packages = ["force-app", "common"], typescript: string | null = "7.1.0-beta"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-plugin-")));
  tempDirs.push(dir);
  writeSfdxProject(dir, packages);
  if (typescript !== null) {
    mkdirSync(path.join(dir, "node_modules/typescript"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: typescript }));
  }
  return dir;
}

function writeSfdxProject(dir: string, packages: readonly string[]): void {
  writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: packages.map((p) => ({ path: p })) }));
  for (const directory of packages) {
    mkdirSync(path.join(dir, directory, "main/default/lwc/widget"), { recursive: true });
  }
}

const configIn = (dir: string, directory: string, file = "jsconfig.json") => path.join(dir, directory, "main/default/lwc", file);
const options = (file: string) => contentMapperOptions(readFileSync(file, "utf8"));

/** Runs a command as the Salesforce CLI would, with --json, and returns its result, keeping the JSON out of the test's output. */
async function run<R>(command: { run(argv: string[], opts: string): Promise<R> }, argv: string[]): Promise<R> {
  const { logJson } = SfCommand.prototype;
  SfCommand.prototype.logJson = () => {};
  try {
    return await command.run([...argv, "--json"], pluginDir);
  } finally {
    SfCommand.prototype.logJson = logJson;
    // a command that fails sets it, as the CLI exits with it
    process.exitCode = undefined;
  }
}

describe("plugin", () => {
  it("registers its commands under lwc-bolts project", async () => {
    const config = await Config.load(pluginDir);
    assert.deepEqual(config.commandIDs.filter((id) => id.startsWith("lwc-bolts")).sort(), [
      "lwc-bolts:project:managed:retrieve",
      "lwc-bolts:project:options:display",
      "lwc-bolts:project:options:set",
      "lwc-bolts:project:options:unset",
      "lwc-bolts:project:setup",
      "lwc-bolts:project:watch",
    ]);
  });
});

describe("project setup", () => {
  it("sets up the project from a folder in it, and only reports what's left the second time", async () => {
    const dir = sfdxProject();
    const result = await run(ProjectSetup, ["--project-dir", path.join(dir, "common")]);
    assert.equal(result.projectConfig, "force-app/main/default/lwc/jsconfig.json");
    assert.deepEqual(result.done, ["created force-app/main/default/lwc/jsconfig.json", "wrote common/main/default/lwc/jsconfig.json"]);
    assert.match(result.warnings.join("\n"), /npm install --save-dev @lwc-bolts\/typescript-content-mapper$/m);
    assert.deepEqual(JSON.parse(readFileSync(configIn(dir, "common"), "utf8")).references, [
      { path: "../../../../force-app/main/default/lwc/jsconfig.json" },
    ]);
    assert.deepEqual((await run(ProjectSetup, ["--project-dir", dir])).done, []);
  });

  it("fails without changing anything unless the project has TypeScript 7.1", async () => {
    for (const [typescript, found] of [
      ["5.9.3", /node_modules\/typescript is 5\.9\.3/],
      [null, /it isn't installed in the project/],
    ] as const) {
      const dir = sfdxProject(["force-app", "common"], typescript);
      await assert.rejects(run(ProjectSetup, ["--project-dir", dir]), found);
      assert.equal(existsSync(configIn(dir, "force-app")), false);
    }
  });

  it("explains a folder outside any SFDX project", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-plugin-")));
    tempDirs.push(dir);
    await assert.rejects(run(ProjectSetup, ["--project-dir", dir]), /isn't in an SFDX project/);
  });
});

describe("project options", () => {
  it("sets, displays and unsets options, keeping the others", async () => {
    const dir = sfdxProject();
    await run(ProjectSetup, ["--project-dir", dir]);
    const set = await run(ProjectOptionsSet, [
      "-d",
      dir,
      "apexNamespace=null",
      "inaccessibleApexProperties=exclude",
      "disabledMetadataTypes=CustomLabel, CustomPermission",
      "suppressDiagnosticsExtensions=.cls",
    ]);
    assert.equal(set.updated, "force-app/main/default/lwc/jsconfig.json");
    assert.deepEqual(options(configIn(dir, "force-app")), {
      apexNamespace: null,
      inaccessibleApexProperties: "exclude",
      disabledMetadataTypes: ["CustomLabel", "CustomPermission"],
      suppressDiagnosticsExtensions: [".cls"],
    });
    assert.equal((await run(ProjectOptionsSet, ["-d", dir, "inaccessibleApexProperties=exclude"])).updated, undefined, "nothing changed");
    // a value that's JSON is read as JSON, and an empty list option is none
    await run(ProjectOptionsSet, [
      "-d",
      dir,
      'apexNamespace="Acme.Apex"',
      "suppressDiagnosticsExtensions=",
      'disabledMetadataTypes=["CustomLabel"]',
    ]);
    assert.deepEqual(options(configIn(dir, "force-app")), {
      apexNamespace: "Acme.Apex",
      inaccessibleApexProperties: "exclude",
      disabledMetadataTypes: ["CustomLabel"],
      suppressDiagnosticsExtensions: [],
    });
    await run(ProjectOptionsSet, [
      "-d",
      dir,
      "apexNamespace=null",
      "inaccessibleApexProperties=include",
      "disabledMetadataTypes=CustomLabel,CustomPermission",
      "suppressDiagnosticsExtensions=.cls",
    ]);

    const display = (await run(ProjectOptionsDisplay, ["-d", dir])) as OptionsResult;
    assert.deepEqual(
      display.options.map(({ name, value, set }) => [name, value, set]),
      [
        ["apexNamespace", null, true],
        ["inaccessibleApexProperties", "include", true],
        ["disabledMetadataTypes", ["CustomLabel", "CustomPermission"], true],
        ["respectForceIgnore", true, false],
        ["suppressDiagnosticsExtensions", [".cls"], true],
        ["lwcConfigFile", "jsconfig.json", false],
      ],
    );

    await run(ProjectOptionsUnset, ["-d", dir, "--option", "apexNamespace", "--option", "inaccessibleApexProperties"]);
    assert.deepEqual(options(configIn(dir, "force-app")), {
      disabledMetadataTypes: ["CustomLabel", "CustomPermission"],
      suppressDiagnosticsExtensions: [".cls"],
    });
  });

  it("sets the project up again with the file lwcConfigFile names, and back", async () => {
    const dir = sfdxProject();
    await run(ProjectSetup, ["--project-dir", dir]);
    const moved = await run(ProjectOptionsSet, ["-d", dir, "lwcConfigFile=tsconfig.json"]);
    assert.equal(moved.updated, "force-app/main/default/lwc/jsconfig.json");
    assert.equal(moved.projectConfig, "force-app/main/default/lwc/tsconfig.json");
    assert.ok(moved.setup?.done.includes("moved force-app/main/default/lwc/jsconfig.json to force-app/main/default/lwc/tsconfig.json"));
    assert.equal(existsSync(configIn(dir, "force-app")), false);
    assert.ok(existsSync(configIn(dir, "common", "tsconfig.json")));

    const back = (await run(ProjectOptionsUnset, ["-d", dir, "-o", "lwcConfigFile"])) as ChangeResult;
    assert.equal(back.projectConfig, "force-app/main/default/lwc/jsconfig.json");
    assert.deepEqual(
      back.setup?.warnings.filter((warning) => warning.includes("TypeScript uses")),
      [],
      "the moved config doesn't shadow",
    );
    assert.equal(existsSync(configIn(dir, "force-app", "tsconfig.json")), false);
    assert.equal(existsSync(configIn(dir, "common", "tsconfig.json")), false);
  });

  it("validates options and needs one to set, and a set-up project", async () => {
    const dir = sfdxProject();
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "apexNamespace=Apex"]), /isn't set up/);
    await run(ProjectSetup, ["--project-dir", dir]);
    const before = readFileSync(configIn(dir, "force-app"), "utf8");
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir]), /at least one option/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "apexNamespace"]), /Expected name=value, but got 'apexNamespace'/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "=Apex"]), /Expected name=value/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "apexNamespace=A", "apexNamespace=B"]), /set more than once/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "apexNamespace=Acme-Apex"]), /dotted path of identifiers/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "typo=1"]), /Unknown option 'typo'/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "inaccessibleApexProperties=false"]), /must be "include as deprecated"/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "disabledMetadataTypes=Flow"]), /'Flow' is not a metadata type/);
    await assert.rejects(run(ProjectOptionsSet, ["-d", dir, "suppressDiagnosticsExtensions=cls"]), /start with a dot/);
    await assert.rejects(
      run(ProjectOptionsSet, ["-d", dir, "lwcConfigFile=x.json", "apexNamespace=Acme"]),
      /'lwcConfigFile' must be one of/,
    );
    assert.equal(readFileSync(configIn(dir, "force-app"), "utf8"), before, "nothing written when any option is invalid");
  });
});

describe("project watch", () => {
  it("restores what the Salesforce extensions merge into a set-up project's jsconfig.json until stopped", async () => {
    const dir = sfdxProject();
    await run(ProjectSetup, ["--project-dir", dir]);
    const common = configIn(dir, "common");
    // what the Salesforce extensions' template makes of it: a project of its own
    const merged = JSON.stringify(
      { ...JSON.parse(readFileSync(common, "utf8")), include: ["**/*", "../../../../.sfdx/typings/lwc/**/*.d.ts"] },
      null,
      4,
    );
    const logs: string[] = [];
    const { log } = SfCommand.prototype;
    SfCommand.prototype.log = (message = "") => void logs.push(message);
    try {
      const watching = ProjectWatch.run(["--project-dir", dir], pluginDir);
      // a watcher that's just started can miss the first change, so merge again until it's restored
      const deadline = Date.now() + 5000;
      do {
        writeFileSync(common, merged);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } while (readFileSync(common, "utf8") === merged && Date.now() < deadline);
      // as Ctrl+C stops it
      process.emit("SIGINT");
      await watching;
    } finally {
      SfCommand.prototype.log = log;
    }
    assert.equal(readFileSync(common, "utf8"), lwcFolderConfig(path.dirname(common), configIn(dir, "force-app"), merged));
    assert.deepEqual(logs[0], `Watching ${dir}. Press Ctrl+C to stop.`);
    assert.ok(logs.includes(`Restored common/main/default/lwc/jsconfig.json: set include to []`), logs.join("\n"));
  });
});
