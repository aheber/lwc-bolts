// Every piece of text the extension shows the user at runtime, in one place, ready for translation.
//
// Each string is a literal `vscode.l10n.t(...)` call, so `npm run l10n:export` (@vscode/l10n-dev) can find
// it and write l10n/bundle.l10n.json, the bundle translators work from (bundle.l10n.<locale>.json). The
// manifest's text (command titles, setting descriptions) is in package.nls.json instead.
//
// Writing for translation:
// - Placeholders are named (`{file}`), so a translation can reorder them.
// - Singular and plural are separate sentences, rather than a sentence with "is"/"are" spliced in.
// - Messages are whole sentences, or whole sentences joined (see {@link sentences}), so a sentence several
//   messages share is translated once; the only other pieces joined in code are lists (see {@link and}) and
//   the steps a setup summary lists.
// - The product name, "Lightning Bolts", and file, setting and package names aren't translated.
import * as vscode from "vscode";

/**
 * Starts a message with the product name, as every message the extension shows does. What follows starts
 * with a lowercase word, as the rest of the sentence the prefix begins, rather than a name or a path.
 */
function prefixed(text: string): string {
  return `Lightning Bolts: ${text}`;
}

/** Joins whole sentences into one message. */
function sentences(...parts: readonly string[]): string {
  return parts.join(" ");
}

/** Why the extension leaves a config alone, which the messages about configs it would change end with. */
function configsLeftAloneReason(setting: string): string {
  return vscode.l10n.t("{setting} is off, so the extension doesn't change jsconfig.json or tsconfig.json files.", { setting });
}

/** That the editor's TypeScript can't run content mappers, which the messages about it start with. */
function editorTypeScriptTooOld(version: string): string {
  return vscode.l10n.t("the editor is running TypeScript {version}, which is too old (7.1 or later needed).", { version });
}

/** The question that offers to point js/ts.tsdk.path at the project's TypeScript. */
function useProjectTypeScriptQuestion(tsdk: string): string {
  return vscode.l10n.t("Switch to the project's TypeScript ({tsdk})?", { tsdk });
}

/** That configs aren't valid JSON, so they weren't changed; `list` names them. */
function invalidJson(files: readonly string[], list: string): string {
  return files.length === 1
    ? vscode.l10n.t("{file} isn't valid JSON, so it wasn't changed.", { file: list })
    : vscode.l10n.t("{files} aren't valid JSON, so they weren't changed.", { files: list });
}

/** That sfdx-project.json's packageDirectories changed, so a project config's `include` is out of step. */
/** Joins items into a list: `a`, `a and b`, `a and b and c`. */
export function and(items: readonly string[]): string {
  return items.length === 0 ? "" : items.reduce((list, item) => vscode.l10n.t("{0} and {1}", list, item));
}

/** The labels of the buttons on the extension's messages and the menus' entries. */
export const button = {
  dontAskAgain: vscode.l10n.t("Don't Ask Again"),
  dontRemindMe: vscode.l10n.t("Don't Remind Me"),
  turnOn: vscode.l10n.t("Turn On"),
  learnMore: vscode.l10n.t("Learn More"),
  useProjectTypeScript: vscode.l10n.t("Use Project TypeScript"),
  selectVersion: vscode.l10n.t("Select Version"),
  installPackages: vscode.l10n.t("Install Packages"),
  updatePackages: vscode.l10n.t("Update Packages"),
  showExtension: vscode.l10n.t("Show Extension"),
  turnOnSettings: vscode.l10n.t("Turn On Settings"),
  turnOnAndContinue: vscode.l10n.t("Turn On and Continue"),
  turnOnAndApply: vscode.l10n.t("Turn On and Apply"),
  restartTypeScript: vscode.l10n.t("Restart TypeScript"),
  setUpProject: vscode.l10n.t("Set Up Project"),
  manageWorkspaceTrust: vscode.l10n.t("Manage Workspace Trust"),
  showDetails: vscode.l10n.t("Show Details"),
  showError: vscode.l10n.t("Show Error"),
  reloadWindow: vscode.l10n.t("Reload Window"),
  downloadNodeJs: vscode.l10n.t("Download Node.js"),
} as const;

/** The text of the project picker and the package menu. */
export const menu = {
  projectToSetUp: () => vscode.l10n.t("SFDX project to set up"),
  projectToApplySettingsTo: () => vscode.l10n.t("SFDX project to apply the settings to"),
  packagesTitle: (project: string) => prefixed(vscode.l10n.t("install or update packages in {project}", { project })),
  packagesPlaceholder: () => vscode.l10n.t("npm install --save-dev: uncheck any you don't want"),
  required: () => vscode.l10n.t("required"),
  recommended: () => vscode.l10n.t("recommended"),
  updateFrom: (installed: string) => vscode.l10n.t("update from {installed}", { installed }),
};

/** What each package the extension installs does for the project, for the menu and recommendations. */
export const packagePurpose = {
  contentMapper: () => vscode.l10n.t("Transforms your Apex, labels, schema and other metadata for @salesforce/... imports"),
  typescript: () => vscode.l10n.t("TypeScript 7.1, which runs the content mapper"),
  lightningTypes: () => vscode.l10n.t("Types the lightning/* modules"),
};

/** An update as the messages list it: `name (installed → known)`. */
export function packageUpdate(name: string, installed: string, known: string): string {
  return vscode.l10n.t("{name} ({installed} → {known})", { name, installed, known });
}

/** A recommended package as the messages list it: `name (what it does)`. */
export function recommendedPackage(name: string, purpose: string): string {
  return purpose === "" ? name : vscode.l10n.t("{name} ({purpose})", { name, purpose });
}

/** The steps a setup took, which its summary lists. */
export const step = {
  installed: (packages: readonly string[]) => vscode.l10n.t("installed {packages}", { packages: and(packages) }),
  setSetting: (setting: string, value: string) => vscode.l10n.t("set {setting} to {value}", { setting, value }),
  leftUnchanged: (files: string, setting: string) => vscode.l10n.t("left {files} unchanged ({setting} is off)", { files, setting }),
  created: (file: string) => vscode.l10n.t("created {file}", { file }),
  moved: (from: string, to: string) => vscode.l10n.t("moved {from} to {to}", { from, to }),
  updated: (file: string) => vscode.l10n.t("updated {file}", { file }),
  wrote: (files: string) => vscode.l10n.t("wrote {files}", { files }),
  removed: (files: string) => vscode.l10n.t("removed {files}", { files }),
  restartedTypeScript: () => vscode.l10n.t("restarted TypeScript"),
};

/** The sentences after a setup's summary, about what's left to do. */
export const nextStep = {
  editorTypeScript: (version: string) =>
    vscode.l10n.t("The editor is running TypeScript {version}, which is too old (7.1 or later needed).", { version }),
  jsconfigComments: (file: string) => vscode.l10n.t("Comments or trailing commas in {file} will cause problems.", { file }),
  invalidJson,
  shadowing: (files: readonly string[], list: string) =>
    files.length === 1
      ? vscode.l10n.t(
          'TypeScript uses {file} instead of the jsconfig.json: remove it, or set the mapper\'s lwcConfigFile option to "tsconfig.json".',
          { file: list },
        )
      : vscode.l10n.t(
          'TypeScript uses {files} instead of the jsconfig.json: remove them, or set the mapper\'s lwcConfigFile option to "tsconfig.json".',
          { files: list },
        ),
  stillNeeds: (packages: readonly string[]) => vscode.l10n.t("It still needs {packages} installed.", { packages: and(packages) }),
  recommended: (packages: readonly string[]) =>
    packages.length === 1
      ? vscode.l10n.t("{package} is recommended.", { package: packages[0]! })
      : vscode.l10n.t("{packages} are recommended.", { packages: and(packages) }),
  updates: (count: number, updates: string) =>
    count === 1
      ? vscode.l10n.t("An update is available: {updates}.", { updates })
      : vscode.l10n.t("Updates are available: {updates}.", { updates }),
  useProjectTypeScript: useProjectTypeScriptQuestion,
};

/** The messages the extension shows, each starting with the product name. */
export const message = {
  setupUnavailable: (error: string) =>
    prefixed(
      vscode.l10n.t("the setup commands are unavailable because part of the extension failed to load ({error}). Reinstall the extension.", {
        error,
      }),
    ),
  openSfdxFolder: () => prefixed(vscode.l10n.t("open a folder with an sfdx-project.json first.")),
  installFailed: (exitCode: number | undefined) =>
    prefixed(
      exitCode === undefined
        ? vscode.l10n.t("npm install didn't finish; its terminal shows why.")
        : vscode.l10n.t("npm install failed (exit code {exitCode}); its terminal shows why.", { exitCode }),
    ),
  installTypeScript7: (project: string) =>
    prefixed(vscode.l10n.t("setting up {project} needs the TypeScript 7 extension. Install it to continue.", { project })),
  /** A reason project-setup gives for not setting a project up, which it words itself. */
  setupError: (error: string) => prefixed(error),
  turnOnWorkspaceSettings: (project: string, settings: readonly string[]) =>
    prefixed(
      vscode.l10n.t("setting up {project} needs TypeScript 7 turned on for this workspace ({settings}). Turn it on?", {
        project,
        settings: and(settings),
      }),
    ),
  editorTypeScriptUseProject: (version: string, tsdk: string) =>
    prefixed(sentences(editorTypeScriptTooOld(version), useProjectTypeScriptQuestion(tsdk))),
  editorTypeScriptSelect: (version: string, project: string) =>
    prefixed(
      sentences(editorTypeScriptTooOld(version), vscode.l10n.t("Select a newer version, then set up {project} again.", { project })),
    ),
  setupChangesConfigs: (project: string, files: string, setting: string) =>
    prefixed(
      sentences(
        vscode.l10n.t("setting up {project} wants to change {files}.", { project, files }),
        configsLeftAloneReason(setting),
        vscode.l10n.t("Turn it on?"),
      ),
    ),
  setUp: (project: string) =>
    prefixed(vscode.l10n.t("✅ finished setting up {project}, LWCs are now bolted to your other Metadata!", { project })),
  alreadySetUp: (project: string) => prefixed(vscode.l10n.t("✅ nothing to do: {project} is already set up.", { project })),
  /** A setup's summary, the steps it took, followed by the sentences about what's left to do. */
  setupSummary: (steps: readonly string[], next: readonly string[]) =>
    prefixed(
      (steps.length > 0 ? `${steps.join("; ")}.` : vscode.l10n.t("the project was already set up.")) +
        next.map((sentence) => ` ${sentence}`).join(""),
    ),
  noProjectConfig: (project: string) =>
    prefixed(vscode.l10n.t("the {project} project has no config to apply the settings to. Set it up first.", { project })),
  invalidJson: (file: string) => prefixed(vscode.l10n.t("couldn't apply the settings: {file} isn't valid JSON.", { file })),
  alreadyUsesSettings: (file: string, section: string) =>
    prefixed(vscode.l10n.t("nothing to apply: {file} already uses your {section} settings.", { file, section })),
  applyChangesConfig: (section: string, file: string, setting: string) =>
    prefixed(
      sentences(vscode.l10n.t("applying your {section} settings would change {file}.", { section, file }), configsLeftAloneReason(setting)),
    ),
  appliedSettings: (section: string, file: string, set: readonly string[]) =>
    prefixed(
      set.length > 0
        ? vscode.l10n.t("applied your {section} settings to {file} ({settings}; the rest use their defaults).", {
            section,
            file,
            settings: set.join(", "),
          })
        : vscode.l10n.t("applied your {section} settings to {file}; they all use their defaults.", { section, file }),
    ),
  stoppedRestoring: (file: string) =>
    prefixed(
      vscode.l10n.t(
        'something keeps rewriting {file}, so the extension stopped restoring it. Components may not see the project\'s types until you run "Set Up Project" again.',
        { file },
      ),
    ),
  untrustedWorkspace: () =>
    prefixed(vscode.l10n.t("content mappers only run in trusted workspaces, so @salesforce/... imports aren't declared.")),
  jsconfigComments: (file: string) => prefixed(vscode.l10n.t("comments or trailing commas in {file} will cause problems.", { file })),
  /** `packages` are each described as {@link recommendedPackage} does. */
  recommendedPackages: (project: string, packages: readonly string[]) =>
    prefixed(vscode.l10n.t("recommended for {project}: {packages}.", { project, packages: and(packages) })),
  setupLooksGood: () => prefixed(vscode.l10n.t("the content mapper setup looks good.")),
  foundProblems: (count: number) =>
    prefixed(vscode.l10n.t("found {count} problems that stop the content mapper from declaring your @salesforce/... imports.", { count })),
  configsLeftAlone: (files: readonly string[], list: string, setting: string) =>
    prefixed(
      sentences(
        files.length === 1
          ? vscode.l10n.t("an update is needed for {file}.", { file: list })
          : vscode.l10n.t("updates are needed for {files}.", { files: list }),
        configsLeftAloneReason(setting),
      ),
    ),
  mapperNotInstalled: (project: string, mapper: string) =>
    prefixed(vscode.l10n.t("the {project} project registers {mapper} in its config, but doesn't have it installed.", { project, mapper })),
  updatesAvailable: (count: number, project: string, updates: string) =>
    prefixed(
      count === 1
        ? vscode.l10n.t("an update is available for {project}: {updates}.", { project, updates })
        : vscode.l10n.t("updates are available for {project}: {updates}.", { project, updates }),
    ),
  installTypeScriptForEditor: (version: string, project: string) =>
    prefixed(
      sentences(
        editorTypeScriptTooOld(version),
        vscode.l10n.t("{project} doesn't have TypeScript 7.1 installed. Install it, then use it in the editor.", { project }),
      ),
    ),
  workspaceSettingsOff: (settings: readonly string[]) =>
    prefixed(
      settings.length === 1
        ? vscode.l10n.t(
            "{setting} is off in this workspace, so the content mapper isn't running and @salesforce/... imports aren't declared.",
            { setting: settings[0]! },
          )
        : vscode.l10n.t(
            "{settings} are off in this workspace, so the content mapper isn't running and @salesforce/... imports aren't declared.",
            { settings: and(settings) },
          ),
    ),
  typescriptCantRunMappers: (version: string) =>
    prefixed(sentences(editorTypeScriptTooOld(version), vscode.l10n.t("Select a newer version."))),
  notSetUp: (project: string) =>
    prefixed(
      vscode.l10n.t(
        "the {project} project isn't set up for the content mapper, which declares your Apex, labels, schema and other metadata for LWC imports.",
        { project },
      ),
    ),
  typescript7NotRunning: (project: string) =>
    prefixed(
      vscode.l10n.t("the {project} project isn't fully set up for the content mapper: the TypeScript 7 extension isn't running.", {
        project,
      }),
    ),
  typescript7WithoutApi: () =>
    prefixed(vscode.l10n.t("the TypeScript 7 extension started without the API the content mapper needs. Check for updates.")),
  typescript7Failed: (error: string) =>
    prefixed(vscode.l10n.t("the TypeScript 7 extension failed to start ({error}), so the content mapper isn't running.", { error })),
  /** The heading of the error the output channel shows when the TypeScript 7 extension fails to start. */
  typescript7FailedTitle: () => vscode.l10n.t("The TypeScript 7 extension failed to start"),
  nodeTooOld: (required: string, version: string | undefined) =>
    prefixed(
      version === undefined
        ? vscode.l10n.t(
            "the content mapper needs Node.js {required} or later on your PATH (none found). Install it, then restart VS Code.",
            { required },
          )
        : vscode.l10n.t(
            "the content mapper needs Node.js {required} or later on your PATH (found {version}). Update it, then restart VS Code.",
            { required, version },
          ),
    ),
};
