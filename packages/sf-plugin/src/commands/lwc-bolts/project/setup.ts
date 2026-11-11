import { applySetup, planSetup } from "@lwc-bolts/project-setup";
import { SfError } from "@salesforce/core";
import { SfCommand } from "@salesforce/sf-plugins-core";
import { describeSetup, projectDirFlag, resolveRoot, type SetupSummary } from "../../../project.ts";
import { sentence } from "../../../report.ts";

export type ProjectSetupResult = SetupSummary;

export default class ProjectSetup extends SfCommand<ProjectSetupResult> {
  public static readonly summary = "Set up an SFDX project's jsconfig.json or tsconfig.json files for the content mapper.";
  public static readonly description =
    "Writes the project config, the one TypeScript project for the whole SFDX project, in the lwc folder of the default package directory, " +
    "with an include for each of sfdx-project.json's packageDirectories, and the content mapper registered in contentMappers. " +
    "Every other lwc folder gets a config with no files of its own that references it. " +
    "An existing project config keeps its other settings, and is moved to the file its lwcConfigFile option names. " +
    "It imports @salesforce/lightning-types in .sfdx/typings/lwc/lightning.d.ts once it's installed, and recommends installing it until then. " +
    "It needs TypeScript 7.1 or later: the project's, or the global tsc when the project has none. " +
    "It fails without changing anything otherwise, naming the path it tested. " +
    "It's safe to run again: it only changes what's out of date.";
  public static readonly examples = [
    "Set up the SFDX project the current folder is in:\n<%= config.bin %> <%= command.id %>",
    "Set up another project:\n<%= config.bin %> <%= command.id %> --project-dir ../my-project",
  ];
  public static readonly flags = {
    "project-dir": projectDirFlag,
  };

  public async run(): Promise<ProjectSetupResult> {
    const { flags } = await this.parse(ProjectSetup);
    const root = resolveRoot(flags["project-dir"]);
    const plan = planSetup(root);
    if ("error" in plan) {
      throw new SfError(`Unable to set up ${root}: ${plan.error}`, "SetupFailed");
    }
    const summary = describeSetup(plan, applySetup(plan));
    if (summary.done.length === 0) {
      this.log(`${root} was already set up.`);
    }
    for (const done of summary.done) {
      this.logSuccess(sentence(done));
    }
    for (const warning of summary.warnings) {
      this.warn(warning);
    }
    return summary;
  }
}
