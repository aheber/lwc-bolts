import { OPTION_NAMES, type OptionName } from "@lwc-bolts/typescript-content-mapper/options";
import * as vscode from "vscode";

/** Settings holding the mapper's `options` for inferred projects; configured projects use their tsconfig's. */
export const SETTINGS_SECTION = "lwcBolts.contentMapper";
/**
 * The settings that are mapper options, named as the options are: all but `lwcConfigFile`, which only a
 * project config sets. The tests keep the settings package.json contributes, and their defaults, in step.
 */
export const OPTION_SETTINGS: readonly OptionName[] = OPTION_NAMES.filter((name) => name !== "lwcConfigFile");

/**
 * Reads the mapper options from the settings, for `scope` (a workspace folder) when given, leaving out
 * unset ones so the mapper applies its defaults. The mapper validates the values, as it does for tsconfig
 * options.
 */
export function readOptions(scope?: vscode.Uri): Record<string, unknown> {
  const settings = vscode.workspace.getConfiguration(SETTINGS_SECTION, scope);
  const options: Record<string, unknown> = {};
  for (const name of OPTION_SETTINGS) {
    const inspected = settings.inspect(name);
    // The most specific value that's set; `null` is a value (`apexNamespace: null` declares types globally).
    const value = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue].find(
      (candidate) => candidate !== undefined,
    );
    if (value !== undefined) {
      options[name] = value;
    }
  }
  return options;
}
