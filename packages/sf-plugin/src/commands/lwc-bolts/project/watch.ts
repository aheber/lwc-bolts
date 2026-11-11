import { SfCommand } from "@salesforce/sf-plugins-core";
import { projectDirFlag, resolveRoot } from "../../../project.ts";
import { watchProject } from "../../../watch.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const;

export default class ProjectWatch extends SfCommand<void> {
  public static readonly summary = "Keep an SFDX project's jsconfig.json or tsconfig.json files set up for the content mapper.";
  public static readonly description =
    "Checks the project's configs now, and whenever sfdx-project.json or an lwc folder's config changes, until you stop it with Ctrl+C. " +
    "Each config is checked against a policy: settings known to break the content mapper are blocked, and the ones it needs are enforced, " +
    "including an include entry for each of sfdx-project.json's packageDirectories. A config that doesn't conform gets just those changes, " +
    "in jsconfig.json or tsconfig.json files alike, and keeps the rest. That undoes what the Salesforce extensions merge into each lwc folder's " +
    "jsconfig.json when they start, and writes the config for a new package directory's lwc folder. " +
    "The Lightning Bolts VS Code extension does the same while it runs, so this is for other editors and for scripts.";
  public static readonly examples = ["Watch the SFDX project the current folder is in:\n<%= config.bin %> <%= command.id %>"];
  public static readonly enableJsonFlag = false;
  public static readonly flags = {
    "project-dir": projectDirFlag,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProjectWatch);
    const root = resolveRoot(flags["project-dir"]);
    const controller = new AbortController();
    const stop = () => controller.abort();
    // SfCommand exits on these by throwing from the listener, which crashes; stop watching and return instead
    for (const signal of SIGNALS) {
      process.removeAllListeners(signal);
      process.once(signal, stop);
    }
    this.log(`Watching ${root}. Press Ctrl+C to stop.`);
    try {
      await watchProject(root, {
        log: (message) => this.log(message),
        warn: (message) => void this.warn(message),
        signal: controller.signal,
      });
    } finally {
      SIGNALS.forEach((signal) => process.off(signal, stop));
    }
  }
}
