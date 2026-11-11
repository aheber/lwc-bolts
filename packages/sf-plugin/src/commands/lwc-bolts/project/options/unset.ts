import { OPTION_NAMES } from "@lwc-bolts/typescript-content-mapper/options";
import { Flags, SfCommand } from "@salesforce/sf-plugins-core";
import { changeOptions, type ChangeResult } from "../../../../options.ts";
import { projectDirFlag, resolveRoot } from "../../../../project.ts";
import { reportChange } from "../../../../report.ts";

export default class ProjectOptionsUnset extends SfCommand<ChangeResult> {
  public static readonly summary = "Remove content mapper options from the project config, so the mapper uses their defaults.";
  public static readonly description =
    "Removes the options from the content mapper's contentMappers entry in the project config, keeping its other options and the file's comments and formatting. " +
    "Unsetting lwcConfigFile goes back to jsconfig.json, and sets the project up again with it.";
  public static readonly examples = [
    "<%= config.bin %> <%= command.id %> --option apexNamespace",
    "<%= config.bin %> <%= command.id %> --option disabledMetadataTypes --option respectForceIgnore",
  ];
  public static readonly flags = {
    "project-dir": projectDirFlag,
    option: Flags.string({
      char: "o",
      summary: "An option to remove; pass it once for each option.",
      multiple: true,
      required: true,
      options: OPTION_NAMES,
    }),
  };

  public async run(): Promise<ChangeResult> {
    const { flags } = await this.parse(ProjectOptionsUnset);
    const changes = Object.fromEntries(flags.option.map((name) => [name, undefined]));
    const result = changeOptions(resolveRoot(flags["project-dir"]), changes);
    reportChange(this, result);
    return result;
  }
}
