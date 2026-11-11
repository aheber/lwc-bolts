import { OPTION_NAMES } from "@lwc-bolts/typescript-content-mapper/options";
import { SfError } from "@salesforce/core";
import { SfCommand } from "@salesforce/sf-plugins-core";
import { changeOptions, parseAssignments, type ChangeResult } from "../../../../options.ts";
import { projectDirFlag, resolveRoot } from "../../../../project.ts";
import { reportChange } from "../../../../report.ts";

export default class ProjectOptionsSet extends SfCommand<ChangeResult> {
  public static readonly summary = "Set the content mapper's options in the project config.";
  public static readonly description =
    "Writes the options, passed as name=value, into the content mapper's contentMappers entry in the project config, keeping its other options and the file's comments and formatting. " +
    `The options are ${OPTION_NAMES.join(", ")}. ` +
    'A value is read as JSON when it is JSON (true, null, ["CustomLabel"]), and otherwise as text (quote one with spaces, such as "inaccessibleApexProperties=include as deprecated"): a comma-separated list for a list option, or a string. ' +
    "Options you don't pass are left as they are; to go back to an option's default, use the unset command. " +
    "Changing lwcConfigFile sets the project up again with that file: the project config moves there, and the other lwc folders get one that references it.";
  public static readonly examples = [
    "Declare Apex classes in the Acme.Apex namespace:\n<%= config.bin %> <%= command.id %> apexNamespace=Acme.Apex",
    "Declare Apex classes globally, and leave out Apex fields LWC can't read:\n<%= config.bin %> <%= command.id %> apexNamespace=null inaccessibleApexProperties=exclude",
    "Don't declare custom labels or permissions:\n<%= config.bin %> <%= command.id %> disabledMetadataTypes=CustomLabel,CustomPermission",
    "Don't show TypeScript's errors in Apex classes:\n<%= config.bin %> <%= command.id %> suppressDiagnosticsExtensions=.cls",
    "Use tsconfig.json files instead of the Salesforce extensions' jsconfig.json:\n<%= config.bin %> <%= command.id %> lwcConfigFile=tsconfig.json",
  ];
  public static readonly usage = "<%= command.id %> name=value... [-d <value>] [--json]";
  public static readonly strict = false;
  public static readonly flags = {
    "project-dir": projectDirFlag,
  };

  public async run(): Promise<ChangeResult> {
    const { flags, argv } = await this.parse(ProjectOptionsSet);
    if (argv.length === 0) {
      throw new SfError("Pass at least one option to set, as name=value.", "NoOptions", [
        'Run "sf lwc-bolts project options set --help" for the options.',
      ]);
    }
    const changes = parseAssignments(argv as string[]);
    const result = changeOptions(resolveRoot(flags["project-dir"]), changes);
    reportChange(this, result);
    return result;
  }
}
