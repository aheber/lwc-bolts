// Keeps a set-up project's configs set up, as the VS Code extension does while it runs.
import { watch } from "node:fs";
import * as projectSetup from "@lwc-bolts/project-setup";
import { RewriteLimiter, SFDX_PROJECT_FILE, writeFiles, type FileWrite } from "@lwc-bolts/project-setup";
import { relative, SETUP_COMMAND } from "./project.ts";

const CONFIG_FILES = new Set(["jsconfig.json", "tsconfig.json"]);

export interface WatchOptions {
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  /** Stops watching. */
  readonly signal: AbortSignal;
  /** How long to wait after a change for more, before checking the configs. */
  readonly delay?: number;
  /** Watches a folder for changes to the files in it, as `fs.watch` does; tests replace it. */
  readonly watchFolder?: (folder: string, listener: (event: string, name: string | null) => void) => FolderWatcher;
  /** Writes a file, as project-setup does; tests replace it. */
  readonly writeFile?: (file: string, text: string) => void;
  /** What the watch plans with from @lwc-bolts/project-setup; tests replace it. */
  readonly setup?: WatchSetup;
}

/** A folder being watched, as `fs.watch` returns one. */
export interface FolderWatcher {
  close(): void;
  on(event: "error", listener: () => void): unknown;
}

/** The parts of @lwc-bolts/project-setup the watch uses. */
export type WatchSetup = Pick<typeof projectSetup, "findLwcFolders" | "findProjectConfig" | "planMaintenance" | "readPackageDirectories">;

/**
 * Checks the project's configs now, and again whenever sfdx-project.json or an `lwc` folder's config
 * changes, until `signal` aborts:
 *
 * each config that doesn't conform to its policy (see project-setup's planMaintenance) gets what the policy
 * blocks removed and what it enforces added, and keeps the rest. That undoes what the Salesforce extensions
 * merge into the `lwc` folders' jsconfig.json files when they start, brings the project config's `include`
 * in step with sfdx-project.json's packageDirectories, and writes the config for a new package directory's
 * `lwc` folder.
 *
 * A file something keeps rewriting is left alone (see project-setup's RewriteLimiter), so the two don't fight over it.
 */
export function watchProject(
  root: string,
  {
    log,
    warn,
    signal,
    delay = 100,
    watchFolder = (folder, listener) => watch(folder, (event, name) => listener(event, name?.toString() ?? null)),
    writeFile = (file, text) => writeFiles([{ path: file, text }]),
    setup = projectSetup,
  }: WatchOptions,
): Promise<void> {
  const { findLwcFolders, findProjectConfig, planMaintenance, readPackageDirectories } = setup;
  const rewrites = new RewriteLimiter();
  let watchers: FolderWatcher[] = [];
  let watchedFolders = "";
  let setUp: boolean | undefined;
  let timer: NodeJS.Timeout | undefined;

  const write = ({ path: file, text, changes = [] }: FileWrite) => {
    const decision = rewrites.rewrite(file);
    if (decision === "stop") {
      warn(
        `Something keeps rewriting ${relative(root, file)}, so the watch stopped restoring it. Run "${SETUP_COMMAND}" to set it up again.`,
      );
    }
    if (decision !== "write") {
      return;
    }
    writeFile(file, text);
    const created = changes.includes("created");
    const details = created || changes.length === 0 ? "" : `: ${changes.join("; ")}`;
    log(`${created ? "Wrote" : "Restored"} ${relative(root, file)}${details}`);
  };

  /** Watches sfdx-project.json and the configs in each `lwc` folder, which change when packageDirectories do. */
  const rewatch = () => {
    const lwcFolders = findLwcFolders(root, readPackageDirectories(root) ?? []);
    const key = lwcFolders.join("\0");
    if (key === watchedFolders && watchers.length > 0) {
      return;
    }
    watchedFolders = key;
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
    const add = (folder: string, matches: (name: string) => boolean) => {
      try {
        const watcher = watchFolder(folder, (_event, name) => {
          if (name === null || matches(name)) {
            schedule();
          }
        });
        // a folder that's removed: look for the folders again
        watcher.on("error", () => ((watchedFolders = ""), schedule()));
        watchers.push(watcher);
      } catch (error) {
        warn(`Unable to watch ${relative(root, folder) || "."}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    add(root, (name) => name === SFDX_PROJECT_FILE);
    for (const folder of lwcFolders) {
      add(folder, (name) => CONFIG_FILES.has(name));
    }
  };

  const check = () => {
    rewatch();
    const project = findProjectConfig(root, readPackageDirectories(root) ?? []);
    if (project === undefined) {
      if (setUp !== false) {
        warn(`${root} isn't set up for the content mapper. Run "${SETUP_COMMAND}"; the watch picks it up once it's set up.`);
      }
      setUp = false;
      return;
    }
    setUp = true;
    planMaintenance(root).forEach(write);
  };

  const run = () => {
    try {
      check();
    } catch (error) {
      warn(`Unable to check ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Editors write a file in several steps, so this waits for the last one.
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      watchers.forEach((watcher) => watcher.close());
      resolve();
    };
    if (signal.aborted) {
      return stop();
    }
    signal.addEventListener("abort", stop, { once: true });
    run();
  });
}
