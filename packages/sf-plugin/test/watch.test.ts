// The watch's own behaviour: what it watches, when it checks the configs, and what it does with project-setup's
// plans. project-setup and the file system are replaced, so these tests don't depend on what the plans hold.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type FileWrite, type ProjectConfig } from "@lwc-bolts/project-setup";
import { watchProject, type WatchOptions, type WatchSetup } from "../src/watch.ts";

const ROOT = path.join(path.sep, "project");
const FORCE_APP = path.join(ROOT, "force-app/main/default/lwc");
const COMMON = path.join(ROOT, "common/main/default/lwc");
const PROJECT_CONFIG = {
  folder: FORCE_APP,
  path: path.join(FORCE_APP, "jsconfig.json"),
  file: "jsconfig.json",
  text: "{}",
} as ProjectConfig;
const restore = (folder: string): FileWrite => ({ path: path.join(folder, "jsconfig.json"), text: "restored" });
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watches ROOT with `setup` replacing project-setup's planning (by default, a set-up project with
 * nothing to do) and a stand-in for `fs.watch` and the writes. Each call to `setup` is counted in `calls`.
 */
function watching(setup: Partial<WatchSetup> = {}, options: Partial<WatchOptions> = {}) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const written: [string, string][] = [];
  const watched = new Map<string, (event: string, name: string | null) => void>();
  const closed: string[] = [];
  const calls: Record<string, number> = {};
  const fakes: WatchSetup = {
    findLwcFolders: () => [FORCE_APP, COMMON],
    findProjectConfig: () => PROJECT_CONFIG,
    planMaintenance: () => [],
    readPackageDirectories: () => ["force-app", "common"],
    ...setup,
  };
  const counted = Object.fromEntries(
    Object.entries(fakes).map(([name, fake]) => [
      name,
      (...args: unknown[]) => ((calls[name] = (calls[name] ?? 0) + 1), (fake as Function)(...args)),
    ]),
  ) as unknown as WatchSetup;
  const controller = new AbortController();
  const done = watchProject(ROOT, {
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
    signal: controller.signal,
    delay: 0,
    watchFolder: (folder, listener) => {
      watched.set(folder, listener);
      return { close: () => closed.push(folder), on: () => {} };
    },
    writeFile: (file, text) => written.push([file, text]),
    setup: counted,
    ...options,
  });
  /** Reports a change to `name` in `folder`, as `fs.watch` does, and lets the watch check the configs. */
  const change = async (folder: string, name: string | null) => {
    watched.get(folder)!("change", name);
    await tick();
  };
  const stop = async () => {
    controller.abort();
    await done;
  };
  return { logs, warnings, written, watched, closed, calls, change, stop };
}

describe("watchProject", () => {
  it("writes what project-setup plans to restore, now and whenever an lwc folder's config changes", async () => {
    const watch = watching({ planMaintenance: () => [restore(COMMON)] });
    assert.deepEqual(watch.written, [[path.join(COMMON, "jsconfig.json"), "restored"]], "at once");
    for (const name of ["jsconfig.json", "tsconfig.json", null]) {
      await watch.change(COMMON, name);
    }
    assert.equal(watch.written.length, 4, "after each config change, or a change it can't name");
    await watch.change(COMMON, "card.js");
    assert.equal(watch.written.length, 4, "not for other files");
    assert.deepEqual(new Set(watch.logs), new Set(["Restored common/main/default/lwc/jsconfig.json"]));
    await watch.stop();
  });

  it("watches sfdx-project.json and each lwc folder, and watches them again when the folders change", async () => {
    let folders = [FORCE_APP];
    const watch = watching({ findLwcFolders: () => folders });
    assert.deepEqual([...watch.watched.keys()], [ROOT, FORCE_APP]);
    const checks = watch.calls.planMaintenance;
    await watch.change(ROOT, "README.md");
    assert.equal(watch.calls.planMaintenance, checks, "only sfdx-project.json matters in the root");
    folders = [FORCE_APP, COMMON];
    await watch.change(ROOT, "sfdx-project.json");
    assert.deepEqual([...watch.watched.keys()], [ROOT, FORCE_APP, COMMON]);
    assert.deepEqual(watch.closed, [ROOT, FORCE_APP], "the old watchers");
    await watch.stop();
    assert.deepEqual(watch.closed, [ROOT, FORCE_APP, ROOT, FORCE_APP, COMMON], "and the rest once it stops");
  });

  it("says what each write changed, and which configs it created", async () => {
    const watch = watching({
      planMaintenance: () => [
        { path: PROJECT_CONFIG.path, text: "conformed", changes: [`removed "**/*" from include`, `added "../../../../common" to include`] },
        { ...restore(COMMON), changes: ["created"] },
      ],
    });
    assert.deepEqual(watch.written, [
      [PROJECT_CONFIG.path, "conformed"],
      [path.join(COMMON, "jsconfig.json"), "restored"],
    ]);
    assert.deepEqual(watch.logs, [
      `Restored force-app/main/default/lwc/jsconfig.json: removed "**/*" from include; added "../../../../common" to include`,
      "Wrote common/main/default/lwc/jsconfig.json",
    ]);
    await watch.stop();
  });

  it("stops restoring a file something keeps rewriting, with a warning", async () => {
    const watch = watching({ planMaintenance: () => [restore(COMMON)] });
    for (let i = 0; i < 6; i++) {
      await watch.change(COMMON, "jsconfig.json");
    }
    assert.equal(watch.written.length, 5);
    assert.deepEqual(watch.warnings, [
      `Something keeps rewriting common/main/default/lwc/jsconfig.json, so the watch stopped restoring it. Run "sf lwc-bolts project setup" to set it up again.`,
    ]);
    await watch.stop();
  });

  it("explains a project that isn't set up once, and picks it up once it is", async () => {
    let project: ProjectConfig | undefined;
    const watch = watching({ findProjectConfig: () => project });
    await watch.change(FORCE_APP, "jsconfig.json");
    assert.equal(watch.warnings.length, 1);
    assert.match(watch.warnings[0]!, /isn't set up for the content mapper/);
    assert.equal(watch.calls.planMaintenance, undefined);
    project = PROJECT_CONFIG;
    await watch.change(FORCE_APP, "jsconfig.json");
    assert.equal(watch.calls.planMaintenance, 1);
    await watch.stop();
  });

  it("waits for the last of several changes before checking", async () => {
    const watch = watching({}, { delay: 20 });
    const checks = watch.calls.planMaintenance;
    for (let i = 0; i < 3; i++) {
      watch.watched.get(COMMON)!("change", "jsconfig.json");
    }
    await tick(50);
    assert.equal(watch.calls.planMaintenance, checks! + 1);
    await watch.stop();
  });

  it("warns about a folder it can't watch, and watches the others", async () => {
    const watch = watching(
      {},
      {
        watchFolder: (folder) => {
          if (folder === COMMON) {
            throw new Error("EACCES");
          }
          return { close() {}, on: () => {} };
        },
      },
    );
    assert.deepEqual(watch.warnings, ["Unable to watch common/main/default/lwc: EACCES"]);
    await watch.stop();
  });

  it("reports a check that fails, and keeps watching", async () => {
    let fail = true;
    const watch = watching({
      planMaintenance: () => {
        if (fail) {
          throw new Error("disk on fire");
        }
        return [];
      },
    });
    assert.deepEqual(watch.warnings, [`Unable to check ${ROOT}: disk on fire`]);
    fail = false;
    await watch.change(COMMON, "jsconfig.json");
    assert.equal(watch.warnings.length, 1);
    await watch.stop();
  });

  it("returns at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await watchProject(ROOT, { log() {}, warn() {}, signal: controller.signal, setup: {} as WatchSetup });
  });
});

describe("watchProject with the file system", () => {
  const tempDirs: string[] = [];
  after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("watches folders with fs.watch and writes the files", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-watch-")));
    tempDirs.push(root);
    const lwc = path.join(root, "force-app/main/default/lwc");
    mkdirSync(lwc, { recursive: true });
    const restored = path.join(root, "restored.json");
    let checks = 0;
    const controller = new AbortController();
    const done = watchProject(root, {
      log() {},
      warn() {},
      signal: controller.signal,
      delay: 10,
      setup: {
        findLwcFolders: () => [lwc],
        findProjectConfig: () => PROJECT_CONFIG,
        planMaintenance: () => (++checks === 1 ? [{ path: restored, text: "restored" }] : []),
        readPackageDirectories: () => ["force-app"],
      },
    });
    // a watcher that's just started can miss the first change, so keep changing the file until it's seen
    const deadline = Date.now() + 5000;
    while (checks < 2 && Date.now() < deadline) {
      writeFileSync(path.join(lwc, "jsconfig.json"), "changed");
      await tick(50);
    }
    controller.abort();
    await done;
    assert.equal(readFileSync(restored, "utf8"), "restored");
    assert.ok(checks >= 2, "checked again after the change");
  });
});
