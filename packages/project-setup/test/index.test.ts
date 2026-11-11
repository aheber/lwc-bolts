// Unit tests for setting up and syncing a project's TypeScript configuration.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "jsonc-parser";
import * as config from "../src/index.ts";

const fixtures = path.join(import.meta.dirname, "../../../tests/fixtures");
/** The example SFDX project, in tests/fixtures at the repo root. */
const exampleProject = path.join(fixtures, "example-project");
/** The jsconfig.json the Salesforce extensions write in a `<package>/main/default/lwc` folder. */
const salesforceJsconfig = readFileSync(path.join(fixtures, "decomposed-labels/force-app/main/default/lwc/jsconfig.json"), "utf8");

/**
 * What the Salesforce LWC language server does to an existing jsconfig.json when it starts, with its
 * template for the same folder, in lightning-language-server's lightning-lsp-common (writeSfdxJsconfig).
 */
function legacySalesforceMerge(existingText: string): string {
  const existing = JSON.parse(existingText);
  const template = JSON.parse(salesforceJsconfig);
  const merged = {
    ...existing,
    ...template,
    compilerOptions: { ...existing.compilerOptions, ...template.compilerOptions },
    include: [...existing.include, ...template.include],
  };
  return JSON.stringify(merged, null, 4);
}

/**
 * The same in salesforcedx-vscode-lwc 68.4, which first drops every `include` entry under
 * `.sfdx/typings/lwc`, and dedupes.
 */
function salesforceMerge(existingText: string): string {
  const existing = JSON.parse(existingText);
  const template = JSON.parse(salesforceJsconfig);
  const kept = Array.isArray(existing.include)
    ? existing.include.filter((entry: unknown) => typeof entry === "string" && !entry.includes(".sfdx/typings/lwc"))
    : [];
  const merged = {
    ...existing,
    ...template,
    compilerOptions: { ...existing.compilerOptions, ...template.compilerOptions },
    include: [...new Set([...kept, ...template.include])],
  };
  return JSON.stringify(merged, null, 2);
}

const salesforceMerges = { "lightning-language-server": legacySalesforceMerge, "salesforcedx-vscode-lwc 68.4": salesforceMerge };

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// an empty PATH, so the machine's own tsc doesn't count
process.env.PATH = mkdtempSync(path.join(tmpdir(), "lwc-bolts-config-bin-"));
tempDirs.push(process.env.PATH);

/**
 * An SFDX project in a temp dir with these package directories (each with an `lwc` folder, the one named
 * `defaultDirectory` marked default) and files.
 */
function project(packageDirectories: string[], files: Record<string, string> = {}, defaultDirectory?: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-config-")));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: packageDirectories.map((p) => ({ path: p, ...(p === defaultDirectory && { default: true }) })) }),
  );
  for (const directory of packageDirectories) {
    mkdirSync(path.join(dir, directory, "main/default/lwc/widget"), { recursive: true });
  }
  const installed = { "node_modules/typescript/package.json": JSON.stringify({ name: "typescript", version: "7.1.0-beta" }) };
  for (const [name, content] of Object.entries({ ...installed, ...files })) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const lwc = (dir: string, directory: string) => path.join(dir, directory, "main/default/lwc");

describe("project configuration", () => {
  it("puts the project config in the default package directory, or the first with components", () => {
    const dir = project(["common", "force-app", "sales"], {}, "force-app");
    assert.equal(config.projectConfigFolder(dir, ["common", "force-app", "sales"]), lwc(dir, "force-app"));
    // without components in the default package directory, the first lwc folder in any
    rmSync(lwc(dir, "force-app"), { recursive: true });
    assert.equal(config.projectConfigFolder(dir, ["common", "force-app", "sales"]), lwc(dir, "common"));
    assert.equal(config.projectConfigFolder(project([]), []), undefined);
    // with none marked default, the first listed
    const unmarked = project(["sales", "common"]);
    assert.equal(config.projectConfigFolder(unmarked, ["sales", "common"]), lwc(unmarked, "sales"));
  });

  it("creates a project config, relative to its folder, that's in step and registers the mapper", () => {
    const dir = project(["force-app", "common"], {}, "force-app");
    const folder = lwc(dir, "force-app");
    const text = config.createProjectConfig(folder, dir, ["force-app", "common"]);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.include, [
      "../../../../force-app",
      "../../../../common",
      ...config.SFDX_TYPINGS.map((typings) => `../../../../${typings}`),
      "../../../../.sfdx/tools/sobjects",
    ]);
    assert.deepEqual(parsed.compilerOptions, { types: [] });
    assert.deepEqual(parsed.contentMappers, [{ package: "@lwc-bolts/typescript-content-mapper", extensions: [".cls", ".xml", ".html"] }]);
    assert.deepEqual(config.checkConfig(text, config.projectConfigPolicy(folder, dir, "jsconfig.json", ["force-app", "common"])), []);
    assert.ok(config.registersContentMapper(text));
    assert.equal(config.lwcConfigFile(text), "jsconfig.json");
    // the Salesforce extensions read it with JSON.parse
    assert.ok(config.isStrictJson(text));
  });

  it("creates a tsconfig.json project config with jsconfig.json's defaults and lwcConfigFile", () => {
    const dir = project(["force-app"]);
    const text = config.createProjectConfig(lwc(dir, "force-app"), dir, ["force-app"], "tsconfig.json");
    const parsed = parse(text);
    assert.deepEqual(parsed.compilerOptions, { allowJs: true, skipLibCheck: true, noEmit: true, types: [] });
    assert.deepEqual(parsed.contentMappers[0].options, { lwcConfigFile: "tsconfig.json" });
    assert.equal(config.lwcConfigFile(text), "tsconfig.json");
    assert.deepEqual(config.checkConfig(text, config.projectConfigPolicy(lwc(dir, "force-app"), dir, "tsconfig.json", ["force-app"])), []);
  });

  it("reads lwcConfigFile from the mapper's options, defaulting to jsconfig.json", () => {
    const withOptions = (options: unknown) =>
      JSON.stringify({
        contentMappers: [
          { package: "other", options: { lwcConfigFile: "tsconfig.json" } },
          { package: config.CONTENT_MAPPER_PACKAGE, options },
        ],
      });
    assert.equal(config.lwcConfigFile(withOptions({ lwcConfigFile: "tsconfig.json" })), "tsconfig.json");
    assert.equal(config.lwcConfigFile(withOptions({ lwcConfigFile: "jsconfig.json" })), "jsconfig.json");
    // unset, invalid (which the mapper reports), or another mapper's
    assert.equal(config.lwcConfigFile(withOptions(undefined)), "jsconfig.json");
    assert.equal(config.lwcConfigFile(withOptions({ lwcConfigFile: "tsconfig.base.json" })), "jsconfig.json");
    assert.equal(config.lwcConfigFile(`{ not json`), "jsconfig.json");
  });

  // Opening a fixture with the Salesforce extensions merges their settings into its jsconfig.json files,
  // which the Lightning Bolts extension keeps in shape, so these check the shape rather than the text.
  it("finds the fixtures' project configs, in step and in shape, and the other lwc folders referencing them", () => {
    const expected = {
      "example-project": "force-app/main/default/lwc/jsconfig.json",
      "decomposed-labels": "force-app/main/default/lwc/tsconfig.json",
      "managed-packages": "force-app/main/default/lwc/tsconfig.json",
    };
    for (const [fixture, configPath] of Object.entries(expected)) {
      const root = path.join(fixtures, fixture);
      const packageDirectories = config.readPackageDirectories(root)!;
      const found = config.findProjectConfig(root, packageDirectories);
      assert.equal(found && path.relative(root, found.path), configPath, fixture);
      assert.equal(config.lwcConfigFile(found!.text), found!.file, `${fixture}'s lwcConfigFile names the file it's in`);
      assert.deepEqual(
        config.checkConfig(found!.text, config.projectConfigPolicy(found!.folder, root, found!.file, packageDirectories)),
        [],
        `${fixture}'s project config conforms`,
      );
      if (found!.file === "jsconfig.json") {
        assert.ok(config.isStrictJson(found!.text), `${fixture}'s project config is strict JSON`);
        const include = JSON.parse(found!.text).include.map((entry: string) => path.relative(root, path.resolve(found!.folder, entry)));
        assert.deepEqual(
          [...config.SFDX_TYPINGS, config.SOBJECT_DEFINITIONS].filter((entry) => !include.includes(entry)),
          [],
          `${fixture}'s project config includes the typings and SObject definitions`,
        );
      }
      for (const folder of config.findLwcFolders(root, packageDirectories).filter((f) => f !== found!.folder)) {
        const text = readFileSync(path.join(folder, found!.file), "utf8");
        assert.equal(config.lwcFolderConfig(folder, found!.path, text), text, `${folder}'s ${found!.file} is in shape`);
        if (found!.file === "jsconfig.json") {
          assert.equal(
            existsSync(path.join(folder, "tsconfig.json")),
            false,
            `${folder} has a tsconfig.json, which TypeScript would use instead`,
          );
        }
      }
    }
    assert.ok(config.findLwcFolders(exampleProject, ["force-app", "common", "sales"]).length > 1, "the example has referencing folders");
  });

  it("finds the project config wherever it is, preferring tsconfig.json", () => {
    const registered = config.createProjectConfig(lwc("/p", "common"), "/p", ["force-app", "common"]);
    const dir = project(["force-app", "common"], {
      "force-app/main/default/lwc/jsconfig.json": salesforceJsconfig,
      "common/main/default/lwc/jsconfig.json": registered,
    });
    // in another folder than a new one would go in, such as when the default package directory changed
    assert.equal(config.findProjectConfig(dir, ["force-app", "common"])?.path, path.join(lwc(dir, "common"), "jsconfig.json"));
    writeFileSync(path.join(lwc(dir, "common"), "tsconfig.json"), registered);
    assert.deepEqual(config.findProjectConfig(dir, ["force-app", "common"]), {
      folder: lwc(dir, "common"),
      path: path.join(lwc(dir, "common"), "tsconfig.json"),
      file: "tsconfig.json",
      text: registered,
    });
    assert.equal(config.findProjectConfig(project(["force-app"]), ["force-app"]), undefined);
  });

  it("checks include against the package directories, blocking stale and Salesforce entries and keeping the project's own", () => {
    const dir = project(["force-app", "sales"], { "types/globals.d.ts": "" });
    const text = `{
  "include": [
    // packages
    "./../../../../force-app/",
    "../../../../old-package",
    "../../../../types",
    "../../../../src/**/*",
    "../../../../.sfdx/typings/lwc/lds.d.ts",
    "**/*"
  ]
}`;
    const changes = config.checkConfig(
      text,
      config.projectConfigPolicy(lwc(dir, "force-app"), dir, "jsconfig.json", ["force-app", "sales"]),
    )!;
    // the project's own entries (an existing folder, globs, .sfdx) are left alone
    assert.ok(changes.includes(`removed "**/*" from include`));
    assert.ok(changes.includes(`removed "../../../../old-package" from include`));
    assert.ok(changes.includes(`added "../../../../sales" to include`));
    assert.ok(!changes.some((change) => /types"|src\/|force-app\/"|lds\.d\.ts/.test(change)), changes.join("\n"));
    assert.equal(
      config.checkConfig("{ not json", config.projectConfigPolicy(lwc(dir, "force-app"), dir, "jsconfig.json", ["force-app"])),
      undefined,
    );
  });

  it("brings include into line in place, keeping comments and the project's own entries", () => {
    const dir = project(["force-app", "common", "sales"]);
    const folder = lwc(dir, "force-app");
    const text = `{
  "include": [
    // One entry per packageDirectories path
    "../../../../force-app",
    "../../../../old-package",
    // typings
    "../../../../.sfdx/typings/lwc/lds.d.ts"
  ],
  "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper", "extensions": [".cls", ".xml", ".html"] }]
}
`;
    const policy = config.projectConfigPolicy(folder, dir, "jsconfig.json", ["force-app", "common", "sales"]);
    const conformed = config.conformConfig(text, policy)!;
    assert.deepEqual(parse(conformed.text).include, [
      "../../../../force-app",
      "../../../../common",
      "../../../../sales",
      "../../../../.sfdx/typings/lwc/apex.d.ts",
      "../../../../.sfdx/typings/lwc/schema.d.ts",
      "../../../../.sfdx/typings/lwc/lds.d.ts",
      "../../../../.sfdx/typings/lwc/messageservice.d.ts",
      `../../../../${config.LIGHTNING_TYPINGS}`,
      "../../../../.sfdx/tools/sobjects",
    ]);
    assert.match(conformed.text, /\/\/ One entry per packageDirectories path\n/);
    assert.match(conformed.text, /\/\/ typings\n/);
    assert.deepEqual(config.checkConfig(conformed.text, policy), []);
    assert.deepEqual(config.conformConfig(conformed.text, policy), { text: conformed.text, changes: [] });
  });

  it("adds include, and the mapper, to a config without them", () => {
    const dir = project(["force-app"]);
    const folder = lwc(dir, "force-app");
    const policy = config.projectConfigPolicy(folder, dir, "jsconfig.json", ["force-app"]);
    const conformed = config.conformConfig(`{ "compilerOptions": {} }`, policy)!;
    assert.deepEqual(parse(conformed.text).include, JSON.parse(config.createProjectConfig(folder, dir, ["force-app"])).include);
    assert.deepEqual(parse(conformed.text).contentMappers, [
      { package: config.CONTENT_MAPPER_PACKAGE, extensions: [".cls", ".xml", ".html"] },
    ]);
  });

  it("adds the content mapper to contentMappers once", () => {
    const added = config.addContentMapper(`{ "contentMappers": [{ "package": "other", "extensions": [".x"] }] }`);
    assert.deepEqual(
      parse(added).contentMappers.map((m: { package: string }) => m.package),
      ["other", "@lwc-bolts/typescript-content-mapper"],
    );
    assert.equal(config.addContentMapper(added), added);
    assert.ok(config.registersContentMapper(config.addContentMapper(`{}`)));
  });

  it("sets the mapper's options, removing undefined ones and keeping the rest and the comments", () => {
    const text = `{
    // the project
    "contentMappers": [
        { "package": "other" },
        { "package": "@lwc-bolts/typescript-content-mapper", "options": { "lwcConfigFile": "jsconfig.json", "respectForceIgnore": false } }
    ]
}`;
    const updated = config.setContentMapperOptions(text, {
      apexNamespace: null,
      inaccessibleApexProperties: "exclude",
      respectForceIgnore: undefined,
      disabledMetadataTypes: undefined,
    })!;
    assert.match(updated, /\/\/ the project/);
    assert.deepEqual(parse(updated).contentMappers[1].options, {
      lwcConfigFile: "jsconfig.json",
      apexNamespace: null,
      inaccessibleApexProperties: "exclude",
    });
    assert.equal(config.setContentMapperOptions(updated, { apexNamespace: null }), updated);
  });

  it("removes options left empty, adds the mapper when it's missing, and leaves invalid JSON alone", () => {
    const cleared = config.setContentMapperOptions(
      `{ "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper", "options": { "apexNamespace": "Acme" } }] }`,
      { apexNamespace: undefined },
    )!;
    assert.deepEqual(parse(cleared).contentMappers, [{ package: "@lwc-bolts/typescript-content-mapper" }]);
    const added = config.setContentMapperOptions(`{}`, { apexNamespace: "Acme" })!;
    assert.deepEqual(parse(added).contentMappers[0].options, { apexNamespace: "Acme" });
    assert.equal(config.setContentMapperOptions(`{ not json`, { apexNamespace: "Acme" }), undefined);
  });

  it("adds the extensions an existing mapper entry lacks, such as .html for templates", () => {
    const text = `{ "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper", "extensions": [".cls", ".xml"], "options": { "apexNamespace": "Acme" } }] }`;
    const updated = config.addContentMapper(text);
    assert.deepEqual(parse(updated).contentMappers, [
      { package: "@lwc-bolts/typescript-content-mapper", extensions: [".cls", ".xml", ".html"], options: { apexNamespace: "Acme" } },
    ]);
    assert.deepEqual(
      parse(config.addContentMapper(`{ "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper" }] }`)).contentMappers[0]
        .extensions,
      [".cls", ".xml", ".html"],
    );
  });

  it("undoes the Salesforce extensions' merge into the project config, keeping the rest", () => {
    const dir = project(["force-app", "common"], { "managed/x.cls": "" }, "force-app");
    const folder = lwc(dir, "force-app");
    const policy = config.projectConfigPolicy(folder, dir, "jsconfig.json", ["force-app", "common", "managed"]);
    // a package directory added since setup is merged into the policy
    const ours = config.conformConfig(config.createProjectConfig(folder, dir, ["force-app", "common"]), policy)!.text;
    assert.ok(JSON.parse(ours).include.includes("../../../../managed"));
    for (const [version, merge] of Object.entries(salesforceMerges)) {
      const merged = merge(ours);
      assert.ok(JSON.parse(merged).include.includes("**/*"), version);
      const { text: undone, changes } = config.conformConfig(merged, policy)!;
      assert.ok(changes.includes("removed compilerOptions.experimentalDecorators"), version);
      // 68.4 drops the typings entries, which are put back in their place
      assert.deepEqual(JSON.parse(undone).include, JSON.parse(ours).include, version);
      assert.deepEqual(JSON.parse(undone).compilerOptions, { types: [] }, version);
      assert.deepEqual(JSON.parse(undone).contentMappers, JSON.parse(ours).contentMappers, version);
      assert.deepEqual(JSON.parse(undone).typeAcquisition, { include: ["jest"] }, version);
      assert.deepEqual(config.checkConfig(undone, policy), [], version);
      // again at the next start
      assert.equal(config.conformConfig(merge(undone), policy)!.text, undone, version);
    }
    // the typings are enforced, so one the project took out is put back
    const withoutLds = JSON.stringify({
      ...JSON.parse(ours),
      include: JSON.parse(ours).include.filter((e: string) => !e.endsWith("lds.d.ts")),
    });
    assert.deepEqual(config.checkConfig(withoutLds, policy), [`added "../../../../.sfdx/typings/lwc/lds.d.ts" to include`]);
    assert.equal(config.conformConfig(`{ not json`, policy), undefined);
  });

  it("writes tsconfig.json and jsconfig.json files that reference the project config", () => {
    const dir = project(["force-app", "sales"]);
    const configPath = path.join(lwc(dir, "force-app"), "jsconfig.json");
    const tsconfigPath = path.join(lwc(dir, "force-app"), "tsconfig.json");
    const tsconfig = config.lwcFolderConfig(lwc(dir, "sales"), tsconfigPath)!;
    assert.deepEqual(JSON.parse(tsconfig), {
      files: [],
      references: [{ path: "../../../../force-app/main/default/lwc/tsconfig.json" }],
    });
    assert.equal(config.lwcFolderConfig(lwc(dir, "sales"), tsconfigPath, tsconfig), tsconfig);
    const text = config.lwcFolderConfig(lwc(dir, "sales"), configPath)!;
    assert.deepEqual(JSON.parse(text), {
      files: [],
      include: [],
      references: [{ path: "../../../../force-app/main/default/lwc/jsconfig.json" }],
    });
    assert.equal(config.lwcFolderConfig(lwc(dir, "sales"), configPath, text), text);
  });

  it("brings the Salesforce extensions' jsconfig.json into shape, keeping the rest of it", () => {
    const dir = project(["force-app", "sales"]);
    const folder = lwc(dir, "sales");
    const configPath = path.join(lwc(dir, "force-app"), "jsconfig.json");
    const normalized = config.lwcFolderConfig(folder, configPath, salesforceJsconfig)!;
    assert.deepEqual(JSON.parse(normalized), {
      compilerOptions: {},
      include: [],
      typeAcquisition: { include: ["jest"] },
      files: [],
      references: [{ path: "../../../../force-app/main/default/lwc/jsconfig.json" }],
    });
    // what's added follows the file's indentation: theirs is 4 spaces
    const indented = config.lwcFolderConfig(folder, configPath, JSON.stringify(JSON.parse(salesforceJsconfig), null, 4))!;
    assert.match(indented, /^ {4}"files": \[\]/m);
    assert.equal(config.lwcFolderConfig(folder, configPath, normalized), normalized);
  });

  it("survives the Salesforce extensions' merge, which only needs undoing again", () => {
    const dir = project(["force-app", "sales"]);
    const folder = lwc(dir, "sales");
    const configPath = path.join(lwc(dir, "force-app"), "jsconfig.json");
    const reference = [{ path: "../../../../force-app/main/default/lwc/jsconfig.json" }];
    // lightning-language-server's merge spreads `include`, so a config without one stops it configuring the project
    assert.throws(() => legacySalesforceMerge(`{ "files": [], "references": [] }`), TypeError);
    const ourConfigs = [config.lwcFolderConfig(folder, configPath)!, config.lwcFolderConfig(folder, configPath, salesforceJsconfig)!];
    for (const [ours, merge] of ourConfigs.flatMap((ours) => Object.values(salesforceMerges).map((merge) => [ours, merge] as const))) {
      const merged = merge(ours);
      assert.deepEqual(JSON.parse(merged).references, reference);
      const restored = config.lwcFolderConfig(folder, configPath, merged)!;
      assert.deepEqual(JSON.parse(restored).include, []);
      assert.deepEqual(JSON.parse(restored).compilerOptions, {});
      assert.deepEqual(JSON.parse(restored).references, reference);
      assert.equal(config.lwcFolderConfig(folder, configPath, restored), restored);
    }
  });

  it("keeps a jsconfig.json's own settings, comments and references", () => {
    const dir = project(["force-app", "sales"]);
    const folder = lwc(dir, "sales");
    const configPath = path.join(lwc(dir, "force-app"), "jsconfig.json");
    const text = `{
  // mine
  "extends": "../../../../jsconfig.base.json",
  "compilerOptions": { "checkJs": true, "baseUrl": "." },
  "references": [{ "path": "../../../../other" }, { "path": "./../../../../force-app/main/default/lwc/jsconfig.json" }]
}
`;
    const normalized = config.lwcFolderConfig(folder, configPath, text)!;
    assert.match(normalized, /\/\/ mine/);
    assert.deepEqual(parse(normalized), {
      extends: "../../../../jsconfig.base.json",
      compilerOptions: { checkJs: true },
      references: [{ path: "../../../../other" }, { path: "./../../../../force-app/main/default/lwc/jsconfig.json" }],
      files: [],
      include: [],
    });
    assert.deepEqual(parse(config.lwcFolderConfig(folder, configPath, `{ "references": [{ "path": "../other" }] }`)!).references, [
      { path: "../other" },
      { path: "../../../../force-app/main/default/lwc/jsconfig.json" },
    ]);
    assert.equal(config.lwcFolderConfig(folder, configPath, `{ not json`), undefined);
  });

  it("moves a project config between jsconfig.json and tsconfig.json", () => {
    const dir = project(["force-app"]);
    const folder = lwc(dir, "force-app");
    const tsconfig = config.createProjectConfig(folder, dir, ["force-app"], "tsconfig.json");
    // a jsconfig.json is strict JSON, so the comments go
    const jsconfig = config.asJsconfig(tsconfig)!;
    assert.ok(config.isStrictJson(jsconfig));
    assert.deepEqual(JSON.parse(jsconfig), parse(tsconfig));
    assert.equal(config.asJsconfig(jsconfig), jsconfig);
    assert.equal(config.asJsconfig(`{ not json`), undefined);
    // a tsconfig.json's policy enforces jsconfig.json's defaults
    const policy = config.projectConfigPolicy(folder, dir, "tsconfig.json", ["force-app"]);
    const moved = config.conformConfig(config.createProjectConfig(folder, dir, ["force-app"]), policy)!.text;
    assert.deepEqual(parse(moved).compilerOptions, { types: [], allowJs: true, skipLibCheck: true, noEmit: true });
    const { text, changes } = config.conformConfig(moved.replace(`"allowJs": true`, `"allowJs": false`), policy)!;
    assert.deepEqual(changes, ["set compilerOptions.allowJs to true"]);
    assert.equal(text, moved);
  });
});

describe("plans", () => {
  const configIn = (dir: string, directory: string, file = "jsconfig.json") => path.join(lwc(dir, directory), file);

  it("plans and applies a setup, then has nothing left to do", () => {
    const dir = project(["force-app", "common"], { ".forceignore": "**/.eslintrc.json\n" });
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    assert.equal(plan.projectConfigChange, "created");
    assert.equal(plan.projectConfig.path, configIn(dir, "force-app"));
    assert.deepEqual(
      plan.writes.map((write) => write.path),
      [configIn(dir, "common")],
    );
    config.applySetup(plan);
    assert.equal(readFileSync(path.join(dir, ".forceignore"), "utf8"), "**/.eslintrc.json\n", ".forceignore is left alone");
    assert.ok(config.registersContentMapper(readFileSync(configIn(dir, "force-app"), "utf8")));
    const again = config.planSetup(dir);
    assert.ok(!("error" in again));
    assert.equal(again.projectConfigChange, "unchanged");
    assert.deepEqual([again.writes, again.removals, again.shadowing], [[], [], []]);
  });

  it("plans no maintenance for a project that isn't set up", () => {
    const dir = project(["force-app", "common"], { "force-app/main/default/lwc/jsconfig.json": salesforceJsconfig });
    assert.deepEqual(config.planMaintenance(dir), []);
  });

  it("explains a project it can't set up", () => {
    assert.match((config.planSetup(project([])) as { error: string }).error, /no packageDirectories/);
  });

  it("won't set up a project without TypeScript 7.1, and names what to install", () => {
    const dir = project(["force-app"]);
    const typescript = path.join(dir, "node_modules/typescript");
    for (const version of ["7.0.0", "5.9.3"]) {
      writeFileSync(path.join(typescript, "package.json"), JSON.stringify({ name: "typescript", version }));
      const plan = config.planSetup(dir) as config.SetupError;
      assert.ok(plan.error.includes(`needs TypeScript 7.1 or later, but ${typescript} is ${version}.`));
      assert.match(plan.error, /npm install --save-dev typescript@7\.1\.0-beta/);
      assert.deepEqual(plan.missing, [config.CONTENT_MAPPER_PACKAGE, config.TYPESCRIPT_PACKAGE]);
    }
    rmSync(typescript, { recursive: true });
    assert.match((config.planSetup(dir) as config.SetupError).error, /it isn't installed in the project/);
    // typescriptPath comes first
    assert.ok(!("error" in config.planSetup(dir, { typescriptPath: path.join(project([]), "node_modules/typescript") })));
    // what's wrong with the project itself comes first, as installing TypeScript wouldn't fix it
    const empty = project([]);
    rmSync(path.join(empty, "node_modules"), { recursive: true });
    assert.equal("missing" in config.planSetup(empty), false);
  });

  it("moves the project config back to jsconfig.json without calling the old tsconfig.json shadowing", () => {
    const dir = project(["force-app", "common"]);
    const tsconfig = config.createProjectConfig(lwc(dir, "force-app"), dir, ["force-app", "common"], "tsconfig.json");
    writeFileSync(configIn(dir, "force-app", "tsconfig.json"), config.setContentMapperOptions(tsconfig, { lwcConfigFile: undefined })!);
    writeFileSync(
      configIn(dir, "common", "tsconfig.json"),
      config.lwcFolderConfig(lwc(dir, "common"), configIn(dir, "force-app", "tsconfig.json"))!,
    );
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    assert.equal(plan.projectConfigChange, "moved");
    assert.equal(plan.movedFrom, configIn(dir, "force-app", "tsconfig.json"));
    assert.deepEqual(plan.shadowing, []);
    assert.deepEqual(plan.removals, [configIn(dir, "common", "tsconfig.json")]);
    config.applySetup(plan);
    assert.equal(existsSync(configIn(dir, "force-app", "tsconfig.json")), false);
    assert.equal(existsSync(configIn(dir, "common", "tsconfig.json")), false);
    assert.ok(existsSync(configIn(dir, "force-app")));
  });

  it("brings another folder's tsconfig.json into shape as it does a jsconfig.json, keeping its own settings", () => {
    const dir = project(["force-app", "common"], {
      "common/main/default/lwc/tsconfig.json": `{
  // mine
  "compilerOptions": { "strict": true, "baseUrl": ".", "paths": { "c/*": ["*"] } },
  "include": ["**/*"]
}
`,
    });
    writeFileSync(
      configIn(dir, "force-app", "tsconfig.json"),
      config.createProjectConfig(lwc(dir, "force-app"), dir, ["force-app", "common"], "tsconfig.json"),
    );
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    assert.deepEqual(
      plan.writes.map((write) => write.path),
      [configIn(dir, "common", "tsconfig.json")],
    );
    config.applySetup(plan);
    const text = readFileSync(configIn(dir, "common", "tsconfig.json"), "utf8");
    assert.match(text, /\/\/ mine/);
    assert.deepEqual(parse(text), {
      compilerOptions: { strict: true },
      include: [],
      files: [],
      references: [{ path: "../../../../force-app/main/default/lwc/tsconfig.json" }],
    });
  });

  it("keeps a tsconfig.json project config in shape as it does a jsconfig.json one", () => {
    const dir = project(["force-app", "common"]);
    const projectConfig = configIn(dir, "force-app", "tsconfig.json");
    writeFileSync(projectConfig, config.createProjectConfig(lwc(dir, "force-app"), dir, ["force-app", "common"], "tsconfig.json"));
    config.applySetup(config.planSetup(dir) as config.SetupPlan);
    assert.deepEqual(config.planMaintenance(dir), []);
    // what's known to break the mapper comes back, and what it needs goes
    const broken = parse(readFileSync(projectConfig, "utf8"));
    broken.compilerOptions = { types: [], baseUrl: ".", experimentalDecorators: true };
    broken.include.push("**/*");
    broken.contentMappers[0].extensions = [".cls"];
    writeFileSync(projectConfig, JSON.stringify(broken, null, 2));
    const common = configIn(dir, "common", "tsconfig.json");
    writeFileSync(common, `{ "compilerOptions": { "paths": {} }, "files": ["x.ts"], "references": [] }`);
    const restores = config.planMaintenance(dir);
    assert.deepEqual(
      restores.map((write) => write.path),
      [projectConfig, common],
    );
    config.writeFiles(restores);
    const restored = parse(readFileSync(projectConfig, "utf8"));
    assert.deepEqual(restored.compilerOptions, { types: [], allowJs: true, skipLibCheck: true, noEmit: true });
    assert.ok(!restored.include.includes("**/*"));
    assert.deepEqual(restored.contentMappers[0].extensions, [...config.CONTENT_MAPPER_EXTENSIONS]);
    assert.deepEqual(parse(readFileSync(common, "utf8")), {
      compilerOptions: {},
      files: [],
      references: [{ path: "../../../../force-app/main/default/lwc/tsconfig.json" }],
    });
    assert.deepEqual(config.planMaintenance(dir), []);
  });

  it("plans restoring the jsconfig.json files the Salesforce extensions merged into, and nothing once they're restored", () => {
    const dir = project(["force-app", "common"]);
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    config.applySetup(plan);
    assert.deepEqual(config.planMaintenance(dir), []);
    for (const directory of ["force-app", "common"]) {
      writeFileSync(configIn(dir, directory), salesforceMerge(readFileSync(configIn(dir, directory), "utf8")));
    }
    const restores = config.planMaintenance(dir);
    assert.deepEqual(
      restores.map((write) => write.path),
      [configIn(dir, "force-app"), configIn(dir, "common")],
    );
    config.writeFiles(restores);
    assert.deepEqual(config.planMaintenance(dir), []);
  });

  it("writes the import of the Lightning types once they're installed, and keeps it there", () => {
    for (const file of ["jsconfig.json", "tsconfig.json"] as const) {
      const dir = project(["force-app"]);
      const typings = path.join(dir, config.LIGHTNING_TYPINGS);
      writeFileSync(configIn(dir, "force-app", file), config.createProjectConfig(lwc(dir, "force-app"), dir, ["force-app"], file));
      const before = config.planSetup(dir);
      assert.ok(!("error" in before));
      config.applySetup(before);
      assert.equal(existsSync(typings), false, file);
      assert.deepEqual(config.planMaintenance(dir), [], file);

      const installed = path.join(dir, "node_modules", config.LIGHTNING_TYPES_PACKAGE);
      mkdirSync(installed, { recursive: true });
      writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: config.LIGHTNING_TYPES_PACKAGE, version: "0.10.1" }));
      const plan = config.planSetup(dir);
      assert.ok(!("error" in plan));
      assert.deepEqual(plan.writes, [{ path: typings, text: 'import "@salesforce/lightning-types";\n' }], file);
      config.applySetup(plan);
      assert.deepEqual(config.planMaintenance(dir), [], file);
      rmSync(typings);
      assert.deepEqual(
        config.planMaintenance(dir).map((write) => write.path),
        [typings],
        file,
      );
    }
  });

  it("adds the Lightning typings to an existing project config's include, before the SObject definitions", () => {
    const dir = project(["force-app"]);
    const folder = lwc(dir, "force-app");
    const include = (text: string): string[] => parse(text).include;
    const created = config.createProjectConfig(folder, dir, ["force-app"]);
    const entry = `../../../../${config.LIGHTNING_TYPINGS}`;
    assert.ok(include(created).includes(entry));
    const older = JSON.stringify({ ...JSON.parse(created), include: include(created).filter((each) => each !== entry) }, null, 2) + "\n";
    writeFileSync(path.join(folder, "jsconfig.json"), older);
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    assert.equal(plan.projectConfigChange, "updated");
    assert.deepEqual(include(plan.projectConfig.text), include(created));
  });

  it("merges new package directories into maintenance, with a config for the new package's lwc folder", () => {
    const dir = project(["force-app"]);
    const plan = config.planSetup(dir);
    assert.ok(!("error" in plan));
    config.applySetup(plan);
    assert.deepEqual(config.planMaintenance(dir), []);
    mkdirSync(lwc(dir, "common"), { recursive: true });
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }, { path: "common" }] }));
    const writes = config.planMaintenance(dir);
    assert.deepEqual(
      writes.map((write) => [write.path, write.changes]),
      [
        [configIn(dir, "force-app"), [`added "../../../../common" to include`]],
        [configIn(dir, "common"), ["created"]],
      ],
    );
    config.writeFiles(writes);
    assert.deepEqual(config.planMaintenance(dir), []);
    // and a removed one's entry goes, once its folder does
    writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
    rmSync(path.join(dir, "common"), { recursive: true });
    assert.deepEqual(
      config.planMaintenance(dir).map((write) => write.changes),
      [[`removed "../../../../common" from include`]],
    );
  });

  it("adds a folder of the project's own to include, after the package directories, once", () => {
    const dir = project(["force-app", "common"]);
    const folder = lwc(dir, "force-app");
    const text = `{
  // the project
  "include": ["../../../../force-app", "../../../../common", "../../../../.sfdx/tools/sobjects"]
}`;
    const added = config.addInclude(text, folder, dir, "managed-apps")!;
    assert.match(added, /\/\/ the project/);
    assert.deepEqual(parse(added).include, [
      "../../../../force-app",
      "../../../../common",
      "../../../../managed-apps",
      "../../../../.sfdx/tools/sobjects",
    ]);
    assert.equal(config.addInclude(added, folder, dir, "managed-apps"), added);
    assert.deepEqual(parse(config.addInclude(`{}`, folder, dir, "managed-apps")!).include, ["../../../../managed-apps"]);
    assert.equal(config.addInclude(`{ not json`, folder, dir, "managed-apps"), undefined);
  });

  it("reads the mapper's options", () => {
    assert.deepEqual(
      config.contentMapperOptions(
        `{ "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper", "options": { "apexNamespace": null } }] }`,
      ),
      { apexNamespace: null },
    );
    assert.deepEqual(config.contentMapperOptions(`{ "contentMappers": [{ "package": "@lwc-bolts/typescript-content-mapper" }] }`), {});
    assert.equal(config.contentMapperOptions(`{}`), undefined);
  });
});
