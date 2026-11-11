// `lwc-bolts project managed retrieve`: how it calls project-setup's cache with the org and flags, and what it
// reports. The org and @lwc-bolts/project-setup/managed are replaced, so nothing is queried or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { applySetup, planSetup } from "@lwc-bolts/project-setup";
import { CacheError, type CacheOptions, type CacheResult, type OrgConnection } from "@lwc-bolts/project-setup/managed";
import { Org } from "@salesforce/core";
import { SfCommand } from "@salesforce/sf-plugins-core";
import { dlrsOrg } from "../../../tests/fixtures/dlrs-org.ts";
import ProjectManagedRetrieve, { type ManagedCache } from "../src/commands/lwc-bolts/project/managed/retrieve.ts";

const pluginDir = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];
process.setMaxListeners(50);
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function sfdxProject(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-retrieve-")));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  return dir;
}

/** Runs the command as the Salesforce CLI would, with --json, keeping the JSON out of the test's output. */
async function retrieve(argv: string[]) {
  const { logJson } = SfCommand.prototype;
  SfCommand.prototype.logJson = () => {};
  try {
    return await ProjectManagedRetrieve.run([...argv, "--json"], pluginDir);
  } finally {
    SfCommand.prototype.logJson = logJson;
    process.exitCode = undefined;
  }
}

const conn = { query: async () => ({ records: [] }), tooling: { query: async () => ({ records: [] }) } } as unknown as OrgConnection;
/** The org `--target-org` resolves to, and the API versions it was asked for connections with. */
let org: { username: string | undefined; namespacePrefix: string | undefined; conn: OrgConnection; apiVersions: (string | undefined)[] };
/** What the command asked the cache for. */
let calls: { orgNamespaces: unknown[][]; cacheManagedMetadata: [string, OrgConnection, CacheOptions][] };
const original = ProjectManagedRetrieve.managed;

/** A cache result for `root`, with `fields` replaced. */
const cached = (root: string, fields: Partial<CacheResult> = {}): CacheResult => ({
  outputDir: path.join(root, "managed-apps"),
  projectConfig: path.join(root, "force-app/main/default/lwc/jsconfig.json"),
  namespaces: [{ namespace: "dlrs", cached: { ApexClass: 2 }, leftOut: [], componentStubs: [] }],
  lwcConfigs: [path.join(root, "managed-apps/dlrs/lwc/jsconfig.json")],
  included: true,
  staleNamespaces: [],
  failures: [],
  ...fields,
});

/** Replaces the cache: `cache` answers each call to cacheManagedMetadata, and the org's own namespaces are `own`. */
function fakeCache(cache: ManagedCache["cacheManagedMetadata"], own = ["acme"]) {
  ProjectManagedRetrieve.managed = {
    orgNamespaces: async (...args) => (calls.orgNamespaces.push(args), new Set(own)),
    cacheManagedMetadata: async (...args) => (calls.cacheManagedMetadata.push(args as never), cache(...args)),
  };
}

beforeEach(() => {
  org = { username: "me@example.com", namespacePrefix: "acme", conn, apiVersions: [] };
  calls = { orgNamespaces: [], cacheManagedMetadata: [] };
  mock.method(Org, "create", async () => ({
    getConnection: (apiVersion?: string) => (org.apiVersions.push(apiVersion), org.conn),
    getUsername: () => org.username,
    getOrgId: () => "00D000000000001",
    getField: (field: string) => (field === Org.Fields.NAMESPACE_PREFIX ? org.namespacePrefix : undefined),
  }));
});
afterEach(() => {
  mock.restoreAll();
  ProjectManagedRetrieve.managed = original;
});

describe("project managed retrieve", () => {
  it("caches the org's other namespaces in the project, and reports them relative to it", async () => {
    const root = sfdxProject();
    fakeCache(async () => cached(root));
    const result = await retrieve(["--target-org", "me@example.com", "--project-dir", root]);
    // the org's own namespaces, from its namespace prefix
    assert.deepEqual(calls.orgNamespaces, [[conn, "acme"]]);
    assert.equal(calls.cacheManagedMetadata.length, 1);
    const [cachedRoot, cachedConn, options] = calls.cacheManagedMetadata[0]!;
    assert.deepEqual([cachedRoot, cachedConn], [root, conn]);
    assert.deepEqual(
      { ...options, onProgress: typeof options.onProgress },
      {
        outputDir: "managed-apps",
        orgNamespaces: new Set(["acme"]),
        onProgress: "function",
      },
    );
    assert.deepEqual(org.apiVersions, [undefined]);
    assert.deepEqual(result, {
      org: "me@example.com",
      orgNamespaces: ["acme"],
      outputDir: "managed-apps",
      namespaces: cached(root).namespaces,
      lwcConfigs: ["managed-apps/dlrs/lwc/jsconfig.json"],
      included: true,
      warnings: [],
    });
  });

  it("passes --namespace, --output-dir and --api-version on", async () => {
    const root = sfdxProject();
    fakeCache(async () => cached(root, { outputDir: path.join(root, "cache") }));
    const result = await retrieve([
      "--target-org",
      "me@example.com",
      "--project-dir",
      root,
      "--namespace",
      "dlrs",
      "--namespace",
      "fflib",
      "--output-dir",
      "cache",
      "--api-version",
      "62.0",
    ]);
    const [, , options] = calls.cacheManagedMetadata[0]!;
    assert.deepEqual([options.outputDir, options.namespaces], ["cache", ["dlrs", "fflib"]]);
    assert.deepEqual(org.apiVersions, ["62.0"]);
    assert.equal(result.outputDir, "cache");
  });

  it("names an org without a username by its id", async () => {
    const root = sfdxProject();
    org.username = undefined;
    fakeCache(async () => cached(root));
    assert.equal((await retrieve(["--target-org", "me@example.com", "--project-dir", root])).org, "00D000000000001");
  });

  it("warns about the queries that failed, and the namespaces the org no longer has", async () => {
    const root = sfdxProject();
    fakeCache(async () => cached(root, { failures: [{ what: "labels", message: "INVALID_TYPE" }], staleNamespaces: ["old"] }));
    const { warnings } = await retrieve(["--target-org", "me@example.com", "--project-dir", root]);
    assert.deepEqual(warnings, [
      "Unable to query the installed packages' labels: INVALID_TYPE",
      "me@example.com has no metadata the content mapper reads in old, which managed-apps still caches. Remove its folder if the package is uninstalled.",
    ]);
  });

  it("explains the cache's errors, with a fix for a project that isn't set up, and passes other errors on", async () => {
    const root = sfdxProject();
    const argv = ["--target-org", "me@example.com", "--project-dir", root];
    fakeCache(async () => {
      throw new CacheError("the project isn't set up", "NotSetUp");
    });
    await assert.rejects(retrieve(argv), {
      name: "NotSetUp",
      message: "the project isn't set up",
      actions: ['Run "sf lwc-bolts project setup".'],
    });
    fakeCache(async () => {
      throw new CacheError("the cache folder is in a package directory", "InvalidOutputDir");
    });
    await assert.rejects(
      retrieve(argv),
      (error: { name: string; actions?: unknown }) => error.name === "InvalidOutputDir" && error.actions === undefined,
    );
    fakeCache(async () => {
      throw new Error("socket hang up");
    });
    await assert.rejects(retrieve(argv), { message: "socket hang up" });
  });
});

describe("project managed retrieve with project-setup", () => {
  it("caches an org's package in a set-up project, and adds the cache to the project config's include", async () => {
    const root = sfdxProject();
    mkdirSync(path.join(root, "force-app/main/default/lwc"), { recursive: true });
    mkdirSync(path.join(root, "node_modules/typescript"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "7.1.0-beta" }));
    const plan = planSetup(root);
    assert.ok(!("error" in plan));
    applySetup(plan);
    org.conn = dlrsOrg(path.join(import.meta.dirname, "../../../tests/fixtures")).conn;
    const result = await retrieve(["--target-org", "me@example.com", "--project-dir", root]);
    assert.deepEqual(
      result.namespaces.map(({ namespace, cached }) => [namespace, cached]),
      [["dlrs", { ApexClass: 2, LightningComponentBundle: 1, CustomObject: 1, CustomField: 2, CustomLabels: 2, StaticResource: 1 }]],
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(result.included, true);
    assert.ok(JSON.parse(readFileSync(plan.projectConfig.path, "utf8")).include.includes("../../../../managed-apps"));
    assert.ok(existsSync(path.join(root, "managed-apps/dlrs/classes/dlrs__RollupController.cls")));
    assert.deepEqual(result.lwcConfigs, ["managed-apps/dlrs/lwc/jsconfig.json"]);
  });
});
