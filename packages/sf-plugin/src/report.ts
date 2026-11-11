// How the options commands show their result.
import type { SfCommand } from "@salesforce/sf-plugins-core";
import type { ChangeResult, OptionsResult } from "./options.ts";

/** Shows the options as a table, after the project config they're in. */
export function showOptions(command: SfCommand<unknown>, { projectConfig, options }: OptionsResult): void {
  command.styledHeader(`Content mapper options in ${projectConfig}`);
  command.table({
    data: options.map(({ name, value, set }) => ({
      option: name,
      value: JSON.stringify(value),
      source: set ? "project config" : "default",
    })),
  });
}

/** Reports what changing the options did, then the options as they are now. */
export function reportChange(command: SfCommand<unknown>, result: ChangeResult): void {
  if (result.updated !== undefined) {
    command.logSuccess(`Updated ${result.updated}.`);
  } else {
    command.log(`${result.projectConfig} already has those options.`);
  }
  for (const done of result.setup?.done ?? []) {
    command.logSuccess(sentence(done));
  }
  for (const warning of result.setup?.warnings ?? []) {
    command.warn(warning);
  }
  showOptions(command, result);
}

/** "created x" as "Created x." */
export function sentence(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}
