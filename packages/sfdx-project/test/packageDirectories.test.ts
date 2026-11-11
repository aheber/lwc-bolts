import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { findLwcFolders, normalizePath, readDefaultPackageDirectory, readPackageDirectories } from "../src/index.ts";

/** The example SFDX project, in tests/fixtures at the repo root. */
const exampleProject = path.join(import.meta.dirname, "../../../tests/fixtures/example-project");

const tempDirs: string[] = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-sfdx-")));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("package directories", () => {
  it("normalizes paths as tsconfig include and sfdx-project.json spell them", () => {
    assert.equal(normalizePath("./force-app/"), "force-app");
    assert.equal(normalizePath("packages\\sales"), "packages/sales");
    // `..`, `.` and repeated slashes resolve, as the Salesforce CLI resolves them
    assert.equal(normalizePath("force-app/../common"), "common");
    assert.equal(normalizePath("packages//sales/./"), "packages/sales");
    assert.equal(normalizePath("..\\shared"), "../shared");
    assert.equal(normalizePath(""), "");
    assert.equal(normalizePath("."), ".");
  });

  it("reads the default package directory, or the first when none is marked default", () => {
    const sfdxProject = (packageDirectories: unknown) => project({ "sfdx-project.json": JSON.stringify({ packageDirectories }) });
    assert.equal(readDefaultPackageDirectory(sfdxProject([{ path: "common" }, { path: "./force-app/", default: true }])), "force-app");
    assert.equal(readDefaultPackageDirectory(sfdxProject([{ path: "common" }, { path: "sales" }])), "common");
    assert.equal(readDefaultPackageDirectory(sfdxProject([{ default: true }, { path: "sales" }])), "sales");
    assert.equal(readDefaultPackageDirectory(sfdxProject([])), undefined);
    assert.equal(readDefaultPackageDirectory(project({})), undefined);
    assert.equal(readDefaultPackageDirectory(exampleProject), "force-app");
  });

  it("reads packageDirectories, normalized and without duplicates", () => {
    const dir = project({
      "sfdx-project.json": JSON.stringify({
        packageDirectories: [
          { path: "force-app", default: true },
          { path: "./common/" },
          { path: "force-app" },
          { path: "common/../force-app" },
          {},
        ],
      }),
    });
    assert.deepEqual(readPackageDirectories(dir), ["force-app", "common"]);
    assert.deepEqual(readPackageDirectories(exampleProject), ["force-app", "common", "sales"]);
    assert.equal(readPackageDirectories(path.join(dir, "missing")), undefined);
    // comments, which some editors leave in sfdx-project.json
    const commented = project({ "sfdx-project.json": `{\n  // packages\n  "packageDirectories": [{ "path": "app" }]\n}` });
    assert.deepEqual(readPackageDirectories(commented), ["app"]);
  });

  it("finds lwc folders in the package directories, skipping node_modules and hidden folders", () => {
    const dir = project({
      "force-app/main/default/lwc/widget/widget.js": "",
      "force-app/main/default/lwc/node_modules/lwc/x.js": "",
      "sales/lwc/orders/orders.js": "",
      "sales/.hidden/lwc/x.js": "",
      "other/lwc/x.js": "",
      "force-app/node_modules/pkg/lwc/x.js": "",
    });
    assert.deepEqual(
      findLwcFolders(dir, ["force-app", "sales"]).map((folder) => path.relative(dir, folder)),
      ["force-app/main/default/lwc", "sales/lwc"],
    );
  });

  it("finds lwc folders nested in another's subfolders, as source-deploy-retrieve resolves them", () => {
    // source-deploy-retrieve's own fixture: projDir/lwc/folder1/lwc/cmpA next to projDir/lwc/cmpB
    const dir = project({
      "force-app/lwc/cmpB/cmpB.js": "",
      "force-app/lwc/folder1/lwc/cmpA/cmpA.js": "",
      "force-app/lwc/folder1/lwc/folder2/lwc/cmpC/cmpC.js": "",
    });
    assert.deepEqual(
      findLwcFolders(dir, ["force-app"]).map((folder) => path.relative(dir, folder)),
      ["force-app/lwc", "force-app/lwc/folder1/lwc", "force-app/lwc/folder1/lwc/folder2/lwc"],
    );
  });

  it("lists an lwc folder once when package directories overlap", () => {
    const dir = project({ "force-app/main/lwc/cmp/cmp.js": "" });
    assert.deepEqual(
      findLwcFolders(dir, ["force-app", "force-app/main"]).map((folder) => path.relative(dir, folder)),
      ["force-app/main/lwc"],
    );
  });
});
