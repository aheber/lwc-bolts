import { SfCommand } from "@salesforce/sf-plugins-core";
import { readOptions, type OptionsResult } from "../../../../options.ts";
import { projectDirFlag, resolveRoot } from "../../../../project.ts";
import { showOptions } from "../../../../report.ts";

export default class ProjectOptionsDisplay extends SfCommand<OptionsResult> {
  public static readonly summary = "Display the content mapper's options in the project config.";
  public static readonly description =
    "Shows each option of the content mapper's contentMappers entry in the project config, or the default the mapper uses when it isn't set.";
  public static readonly examples = ["<%= config.bin %> <%= command.id %>", "<%= config.bin %> <%= command.id %> --json"];
  public static readonly flags = {
    "project-dir": projectDirFlag,
  };

  public async run(): Promise<OptionsResult> {
    const { flags } = await this.parse(ProjectOptionsDisplay);
    const result = readOptions(resolveRoot(flags["project-dir"]));
    showOptions(this, result);
    return result;
  }
}
