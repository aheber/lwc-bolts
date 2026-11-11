// What the commands share: finding the SFDX project, and describing what setting it up changed.
import path from "node:path";
import {
  findProjectConfig,
  isStrictJson,
  missingPackages,
  normalizePath,
  recommendedPackages,
  type ProjectConfig,
  type SetupPlan,
} from "@lwc-bolts/project-setup";
import { findSfdxRoot } from "@lwc-bolts/sfdx-project";
import { SfError } from "@salesforce/core";
import { Flags } from "@salesforce/sf-plugins-core";

export const SETUP_COMMAND = "sf lwc-bolts project setup";

export const projectDirFlag = Flags.directory({
  char: "d",
  summary: "A folder in the SFDX project; the project is the nearest folder with an sfdx-project.json.",
  default: ".",
  exists: true,
});

/** The SFDX project `dir` is in. */
export function resolveRoot(dir: string): string {
  const root = findSfdxRoot(dir);
  if (root === undefined) {
    throw new SfError(`${path.resolve(dir)} isn't in an SFDX project.`, "NoSfdxProject", [
      "Run the command in a folder with an sfdx-project.json, or pass --project-dir.",
    ]);
  }
  return root;
}

/** The project config of an SFDX project that has to be set up. */
export function requireProjectConfig(root: string): ProjectConfig {
  const project = findProjectConfig(root);
  if (project === undefined) {
    throw new SfError(`${path.basename(root)} isn't set up for the content mapper: no lwc folder config registers it.`, "NotSetUp", [
      `Run "${SETUP_COMMAND}".`,
    ]);
  }
  return project;
}

/** A path relative to the project, with forward slashes. */
export function relative(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}

/** What setting a project up changed, for a command's output and its JSON result. */
export interface SetupSummary {
  readonly projectConfig: string;
  readonly file: string;
  /** What was done, such as "created force-app/main/default/lwc/jsconfig.json". */
  readonly done: string[];
  readonly warnings: string[];
}

/** Describes an applied setup plan: what `applySetup` did, and what's left for the user to do. */
export function describeSetup(plan: SetupPlan, applied: { written: readonly string[]; removed: readonly string[] }): SetupSummary {
  const { root, file, projectConfig } = plan;
  const list = (files: readonly string[]) => files.map((each) => relative(root, each)).join(", ");
  const configPath = relative(root, projectConfig.path);
  const done: string[] = [];
  if (plan.projectConfigChange === "created") {
    done.push(`created ${configPath}`);
  } else if (plan.projectConfigChange === "moved") {
    done.push(`moved ${relative(root, plan.movedFrom!)} to ${configPath}`);
  } else if (plan.projectConfigChange === "updated") {
    done.push(`updated ${configPath}`);
  }
  if (applied.written.length > 0) {
    done.push(`wrote ${list(applied.written)}`);
  }
  if (applied.removed.length > 0) {
    done.push(`removed ${list(applied.removed)}`);
  }

  const warnings: string[] = [];
  if (file === "jsconfig.json" && !isStrictJson(projectConfig.text)) {
    warnings.push(
      `${configPath} has comments or trailing commas, which stop the Salesforce extensions from setting up the project: remove them.`,
    );
  }
  if (plan.invalid.length > 0) {
    warnings.push(
      `${list(plan.invalid)} ${plan.invalid.length === 1 ? "isn't" : "aren't"} valid JSON, so ${plan.invalid.length === 1 ? "it wasn't" : "they weren't"} changed.`,
    );
  }
  if (plan.shadowing.length > 0) {
    warnings.push(
      `TypeScript uses ${list(plan.shadowing)} instead of the jsconfig.json next to ${plan.shadowing.length === 1 ? "it" : "them"}: remove ${plan.shadowing.length === 1 ? "it" : "them"}, or set the lwcConfigFile option to "tsconfig.json".`,
    );
  }
  const missing = missingPackages(root);
  if (missing.length > 0) {
    warnings.push(`The project needs ${missing.join(" and ")} installed: npm install --save-dev ${missing.join(" ")}`);
  }
  const recommended = recommendedPackages(root);
  if (recommended.length > 0) {
    warnings.push(
      `${recommended.join(" and ")} types the lightning/* modules: npm install --save-dev ${recommended.join(" ")}, then run "${SETUP_COMMAND}" again.`,
    );
  }
  return { projectConfig: configPath, file, done, warnings };
}
