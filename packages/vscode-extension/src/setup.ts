// Sets SFDX projects up for the content mapper (TypeScript 7), keeps the project config in step with
// sfdx-project.json and the `lwc` folders' jsconfig.json files in the shape it needs, and explains the
// usual reasons the mapper isn't running.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { ExtensionAPI } from "typescript/vscode";
import { button, menu, message, nextStep, packagePurpose as purpose, packageUpdate, recommendedPackage, step } from "./messages.ts";
import { nodeOnPath } from "./nodeOnPath.ts";
import { OPTION_SETTINGS, readOptions, SETTINGS_SECTION } from "./settings.ts";
import { satisfiesMinimum } from "./versions.ts";

/** @lwc-bolts/project-setup, which the extension loads with import() when it activates (see projectSetupLoader). */
export type ProjectSetup = typeof import("@lwc-bolts/project-setup");
type OutdatedPackage = import("@lwc-bolts/project-setup").OutdatedPackage;
type FileWrite = import("@lwc-bolts/project-setup").FileWrite;
let config: ProjectSetup;

/** The TypeScript 7 extension, which runs content mappers. Without it, the extension's features aren't available. */
export const TYPESCRIPT_7_EXTENSION = "TypeScriptTeam.native-preview";
export const SET_UP_COMMAND = "lwcBolts.setUpProject";
export const CHECK_COMMAND = "lwcBolts.checkSetup";
export const APPLY_SETTINGS_COMMAND = "lwcBolts.applySettingsToProject";
/** The workspace state that silences every prompt the extension shows on its own (see {@link prompt}). */
const DONT_ASK = "lwcBolts.dontAsk";
/** The extension's own settings section, as package.json contributes them (`lwcBolts.*`). */
const SETTINGS_ROOT = "lwcBolts";
let workspaceState: vscode.Memento;
/** The mapper package's engines.node, which the node on the PATH must satisfy for configured projects. */
let mapperNodeEngine: string | undefined;

/** Why the TypeScript 7 extension's API isn't available: it isn't installed, or it failed to start. */
export type TypeScript7Unavailable = { readonly reason: "missing" } | { readonly reason: "failed"; readonly error: unknown };
/** The TypeScript 7 extension's API, or why there isn't one, which registerSetup and connect() set. */
let typescript7: { api: ExtensionAPI | undefined; unavailable: TypeScript7Unavailable };
const hasTypeScript7 = () => typescript7.api !== undefined;
/** The project whose setup waits for TypeScript 7 to be installed, to carry on once it is. */
let waitingForTypeScript7: string | undefined;
/** The projects being set up, which the setup check doesn't suggest setting up meanwhile. */
const settingUp = new Set<string>();
/** The TypeScript version TypeScript 7's language server last started with, when it said. */
let editorTypeScriptVersion: string | undefined;
/** Setups waiting for the language server to start, which setup does by turning on TypeScript 7. */
const serverStartWaiters = new Set<() => void>();
/** How long setup waits for the language server it started to say which TypeScript it runs. */
const SERVER_START_TIMEOUT_MS = 10_000;
/** Turned off, the extension never changes a jsconfig.json or tsconfig.json, and only says what's wrong with them. */
const MAINTAIN_SETTING = "maintainLwcConfigs";
/**
 * The workspace state that silences the reminders that a config isn't in shape while MAINTAIN_SETTING is
 * off, apart from Don't Ask Again (see {@link remind}).
 */
const CONFIG_REMINDERS_OFF = "lwcBolts.configRemindersOff";
/** What registerSetup does once MAINTAIN_SETTING is turned on: brings the configs back into shape. */
let configsTurnedOn: () => void = () => {};

/** Whether the extension may change the `lwc` folders' configs (MAINTAIN_SETTING). */
function managesConfigs(): boolean {
  return vscode.workspace.getConfiguration(SETTINGS_ROOT).get<boolean>(MAINTAIN_SETTING, true) !== false;
}

/** Whether a file is an `lwc` folder config, a jsconfig.json or tsconfig.json, which MAINTAIN_SETTING covers. */
function isLwcConfig(file: string): boolean {
  return (config.LWC_CONFIG_FILES as readonly string[]).includes(path.basename(file));
}

/** Turns MAINTAIN_SETTING on for the workspace, which brings the configs back into shape. */
async function turnOnConfigs(): Promise<void> {
  await vscode.workspace.getConfiguration(SETTINGS_ROOT).update(MAINTAIN_SETTING, true, vscode.ConfigurationTarget.Workspace);
  configsTurnedOn();
}

/** The setting the messages name when they explain that configs are left alone. */
const MAINTAIN_SETTING_NAME = `${SETTINGS_ROOT}.${MAINTAIN_SETTING}`;

/**
 * Says, on its own, that a config isn't in shape while MAINTAIN_SETTING is off, with a Don't Remind Me
 * button that silences these reminders in the workspace, until Check Content Mapper Setup. Don't Ask
 * Again silences them too. Returns the button chosen, if any.
 */
async function remind(message: string, ...actions: string[]): Promise<string | undefined> {
  if (workspaceState.get<boolean>(DONT_ASK) || workspaceState.get<boolean>(CONFIG_REMINDERS_OFF)) {
    return undefined;
  }
  const choice = await tell("warning", message, "keeping-configs-in-step", actions, { last: [button.dontRemindMe] });
  if (choice === button.dontRemindMe) {
    await workspaceState.update(CONFIG_REMINDERS_OFF, true);
    return undefined;
  }
  return choice;
}

/** A problem that stops the mapper from working, with the actions that fix it. */
interface Issue {
  readonly message: string;
  readonly actions?: readonly { readonly title: string; readonly run: () => unknown }[];
  /** The section of the setup guide that explains it, which Learn More opens. */
  readonly docs: DocsSection;
  /** How it's shown: a warning unless it's only an offer, such as setting a project up. */
  readonly level?: "information" | "warning";
}

/**
 * The setup guide, docs/setup.md, which ships with the extension. Each setup message's Learn More opens
 * it in the Markdown preview, at the section about it.
 */
let guide: vscode.Uri;
/** The setup guide's sections, by the anchors GitHub gives their headings. */
type DocsSection =
  | "how-setup-runs"
  | "typescript-7-extension"
  | "typescript-version"
  | "editor-typescript"
  | "project-config-jsconfigjson"
  | "workspace-settings"
  | "packages"
  | "nodejs-on-your-path"
  | "keeping-configs-in-step"
  | "troubleshooting"
  | "workspace-trust"
  | "mapper-not-installed"
  | "comments-in-jsconfigjson";

/**
 * Opens the setup guide in the Markdown preview, which scrolls to the heading the fragment names. Without
 * the preview (the built-in Markdown extension can be turned off), it opens the file instead.
 */
async function openDocs(section: DocsSection): Promise<void> {
  try {
    await vscode.commands.executeCommand("markdown.showPreview", guide.with({ fragment: section }));
  } catch (error) {
    console.error("Lightning Bolts: unable to preview the setup guide", error);
    await vscode.window.showTextDocument(guide);
  }
}

/**
 * Shows a message with a Learn More button after `actions`, which opens the setup guide at `section`.
 * Returns the action chosen, if any. A question, which setup waits on, asks again after Learn More, so
 * reading the guide doesn't answer it. Modals are always questions.
 */
async function tell(
  level: "information" | "warning" | "error",
  message: string,
  section: DocsSection,
  actions: readonly string[],
  /** `last`: buttons after Learn More, such as Don't Ask Again. */
  { modal = false, question = modal, last = [] }: { modal?: boolean; question?: boolean; last?: readonly string[] } = {},
): Promise<string | undefined> {
  const show = {
    information: vscode.window.showInformationMessage,
    warning: vscode.window.showWarningMessage,
    error: vscode.window.showErrorMessage,
  }[level];
  for (;;) {
    const choice = await (modal
      ? show(message, { modal }, ...actions, button.learnMore, ...last)
      : show(message, ...actions, button.learnMore, ...last));
    if (choice !== button.learnMore) {
      return choice;
    }
    await openDocs(section);
    if (!question) {
      return undefined;
    }
  }
}

/** The workspace folders that are SFDX projects. */
export function sfdxRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath)
    .filter((root) => existsSync(path.join(root, config.SFDX_PROJECT_FILE)));
}

/** What the extension calls once TypeScript 7 is installed after it started without it. */
export interface SetupConnection {
  /**
   * Starts using TypeScript 7's API, or records why there isn't one, and runs the startup setup again,
   * so the checks offer the next step.
   */
  connect(api: ExtensionAPI | undefined, unavailable: TypeScript7Unavailable): void;
}

/**
 * Registers the setup commands, and with TypeScript 7 checks each SFDX project's setup now and its
 * project config whenever sfdx-project.json changes. Without it, it explains what's needed, and does the
 * rest once the returned connection gets TypeScript 7's API.
 */
export function registerSetup(
  context: vscode.ExtensionContext,
  initialApi: ExtensionAPI | undefined,
  nodeEngine: string | undefined,
  projectSetup: ProjectSetup,
  initiallyUnavailable: TypeScript7Unavailable = { reason: "missing" },
): SetupConnection {
  config = projectSetup;
  workspaceState = context.workspaceState;
  guide = vscode.Uri.joinPath(context.extensionUri, "docs", "setup.md");
  mapperNodeEngine = nodeEngine;
  typescript7 = { api: initialApi, unavailable: initiallyUnavailable };
  let health: SetupHealth | undefined;
  const getHealth = () => (health ??= new SetupHealth(context));
  const keeper = new LwcConfigKeeper(context);
  // The commands first, so nothing that goes wrong below can leave them unregistered ("command not found").
  context.subscriptions.push(
    vscode.commands.registerCommand(SET_UP_COMMAND, async () => {
      const root = await pickRoot();
      if (root !== undefined) {
        await setUpProject(root);
        if (hasTypeScript7()) {
          keeper.watch(root);
        }
      }
    }),
    vscode.commands.registerCommand(CHECK_COMMAND, async () => {
      // checking on demand turns the prompts back on after Don't Ask Again and Don't Remind Me, and suggests the recommended
      // packages and updates unchecked in the package menu again
      await workspaceState.update(DONT_ASK, undefined);
      await workspaceState.update(CONFIG_REMINDERS_OFF, undefined);
      await workspaceState.update(DECLINED_PACKAGES, undefined);
      await workspaceState.update(DECLINED_UPDATES, undefined);
      await getHealth().check({ quiet: false });
    }),
    vscode.commands.registerCommand(APPLY_SETTINGS_COMMAND, async () => {
      const root = activeRoot() ?? (await pickRoot(menu.projectToApplySettingsTo()));
      if (root !== undefined) {
        await applySettings(root);
      }
    }),
  );
  // turning the setting on brings the configs back into shape, as at startup
  configsTurnedOn = () => {
    if (hasTypeScript7() && managesConfigs()) {
      for (const root of sfdxRoots()) {
        keeper.enforce(root);
      }
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(MAINTAIN_SETTING_NAME)) {
        configsTurnedOn();
      }
    }),
  );
  /** Watches each project's configs with TypeScript 7, and checks the setup, which offers the next step. */
  const start = () => {
    try {
      if (hasTypeScript7()) {
        for (const root of sfdxRoots()) {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(root), config.SFDX_PROJECT_FILE),
          );
          // the package directories are part of the project config's policy, and a new one's lwc folder needs a config
          const changed = () => keeper.enforce(root);
          context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));
          keeper.watch(root);
        }
      }
      // offers to set up each project that isn't, which starts with installing TypeScript 7 when it's missing
      void getHealth().check({ quiet: true });
    } catch (error) {
      console.error("Lightning Bolts: the startup setup checks failed", error);
    }
  };
  start();
  return {
    connect(api, unavailable) {
      if (hasTypeScript7()) {
        return;
      }
      typescript7 = { api, unavailable };
      health?.listen(context);
      // a setup that waited for TypeScript 7 carries on, rather than the check suggesting it again
      const waiting = waitingForTypeScript7;
      waitingForTypeScript7 = undefined;
      const resumed = waiting === undefined ? undefined : setUpProject(waiting);
      start();
      void resumed?.then(() => hasTypeScript7() && keeper.watch(waiting!));
    },
  };
}

/**
 * Registers the setup commands for when @lwc-bolts/project-setup can't be loaded, so running one
 * explains that the extension needs reinstalling rather than failing with "command not found".
 */
export function registerSetupUnavailable(context: vscode.ExtensionContext, error: unknown): void {
  const explain = () =>
    void vscode.window.showErrorMessage(message.setupUnavailable(error instanceof Error ? error.message : String(error)));
  context.subscriptions.push(
    vscode.commands.registerCommand(SET_UP_COMMAND, explain),
    vscode.commands.registerCommand(CHECK_COMMAND, explain),
    vscode.commands.registerCommand(APPLY_SETTINGS_COMMAND, explain),
  );
}

let output: vscode.OutputChannel | undefined;

/** Writes an error to the extension's output channel and shows it. */
function showError(title: string, error: unknown): void {
  output ??= vscode.window.createOutputChannel("Lightning Bolts");
  output.appendLine(`${title}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  output.show(true);
}

async function pickRoot(placeHolder = menu.projectToSetUp()): Promise<string | undefined> {
  const roots = sfdxRoots();
  if (roots.length === 0) {
    void vscode.window.showErrorMessage(message.openSfdxFolder());
    return undefined;
  }
  if (roots.length === 1) {
    return roots[0];
  }
  return vscode.window.showQuickPick(roots, { placeHolder });
}

/** The SFDX project of the active editor's file, if it's in one. */
function activeRoot(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
  return folder !== undefined && sfdxRoots().includes(folder) ? folder : undefined;
}

/**
 * Shows a warning the extension raises on its own rather than in answer to a command, with a Don't Ask
 * Again button that silences every such prompt in the workspace. Returns the button chosen, if any.
 */
async function prompt(
  text: string,
  section: DocsSection,
  actions: readonly string[] = [],
  level: "information" | "warning" = "warning",
): Promise<string | undefined> {
  if (workspaceState.get<boolean>(DONT_ASK)) {
    return undefined;
  }
  const choice = await tell(level, text, section, actions, { last: [button.dontAskAgain] });
  if (choice === button.dontAskAgain) {
    await workspaceState.update(DONT_ASK, true);
    return undefined;
  }
  return choice;
}

function relative(root: string, files: readonly string[]): string {
  return files.map((file) => path.relative(root, file)).join(", ");
}

/** What `js/ts.tsdk.path` is set to, to run the TypeScript installed in the project. */
const PROJECT_TSDK = "node_modules/typescript";

/** The `js/ts.tsdk.path` setting, unless it's unset. */
function tsdkPath(root: string): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  return vscode.workspace.getConfiguration("js/ts", folder?.uri).get<string>("tsdk.path") || undefined;
}

/**
 * The TypeScript the `js/ts.tsdk.path` setting names, which the editor runs ahead of the project's or a
 * global one. It can name a `tsc` that checking the version runs, and a workspace's settings come with the
 * workspace, so it's ignored until the workspace is trusted.
 */
function typescriptOptions(root: string): { typescriptPath?: string } {
  const typescriptPath = tsdkPath(root);
  return typescriptPath === undefined || vscode.workspace.isTrusted === false ? {} : { typescriptPath };
}

/**
 * Runs `npm install --save-dev` in the project as a task, whose terminal shows its output, and resolves
 * to whether it succeeded, so what needed the packages can carry on. A failure is explained.
 */
async function installPackages(root: string, packages: readonly string[]): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  const task = new vscode.Task(
    { type: "lwcBolts", task: "install" },
    folder ?? vscode.TaskScope.Workspace,
    `npm install ${packages.join(" ")}`,
    "Lightning Bolts",
    new vscode.ShellExecution(`npm install --save-dev ${packages.join(" ")}`, { cwd: root }),
  );
  let execution: vscode.TaskExecution | undefined;
  // listening before the task starts, so its end can't be missed
  const ended = new Promise<number | undefined>((resolve) => {
    const listener = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution === execution) {
        listener.dispose();
        resolve(event.exitCode);
      }
    });
  });
  execution = await vscode.tasks.executeTask(task);
  const exitCode = await ended;
  if (exitCode !== 0) {
    void tell("error", message.installFailed(exitCode), "packages", []);
    return false;
  }
  return true;
}

const RESTART_TYPESCRIPT = "typescript.native-preview.restart";
const SELECT_TYPESCRIPT_VERSION = "typescript.native-preview.selectVersion";
/** The recommended packages the user unchecked, which the menu leaves unchecked and setup stops suggesting. */
const DECLINED_PACKAGES = "lwcBolts.declinedPackages";
/**
 * The updates the user unchecked, as `name@version`, which the menu leaves unchecked and the checks stop
 * suggesting, until the extension knows of a newer version.
 */
const DECLINED_UPDATES = "lwcBolts.declinedUpdates";

/** The package's name, without the version an install names, such as typescript in typescript@7.1.0-beta. */
function packageName(spec: string): string {
  const at = spec.indexOf("@", 1);
  return at === -1 ? spec : spec.slice(0, at);
}

/** What a package does for the project, for the menu. */
function packagePurpose(spec: string): string {
  switch (packageName(spec)) {
    case config.CONTENT_MAPPER_PACKAGE:
      return purpose.contentMapper();
    case packageName(config.TYPESCRIPT_PACKAGE):
      return purpose.typescript();
    case config.LIGHTNING_TYPES_PACKAGE:
      return purpose.lightningTypes();
    default:
      return "";
  }
}

/** The recommended packages the project doesn't have, without the ones the user declined. */
function suggestedPackages(root: string): string[] {
  const declined = workspaceState.get<string[]>(DECLINED_PACKAGES) ?? [];
  return config.recommendedPackages(root).filter((spec) => !declined.includes(packageName(spec)));
}

/**
 * The installed packages older than the versions the extension knows of (see project-setup's
 * KNOWN_VERSIONS), without the updates the user declined.
 */
function suggestedUpdates(root: string): OutdatedPackage[] {
  const declined = workspaceState.get<string[]>(DECLINED_UPDATES) ?? [];
  return config.outdatedPackages(root).filter((update) => !declined.includes(update.spec));
}

/** The updates, as the messages list them: `name (installed → known)`. */
function describeUpdates(updates: readonly OutdatedPackage[]): string {
  return updates.map(({ name, installed, known }) => packageUpdate(name, installed, known)).join(", ");
}

/**
 * Every install and update goes through here: a menu of the packages `required` names, updates to the
 * installed ones older than the versions the extension knows of, and the recommended ones the project
 * doesn't have, each checked unless the user declined it before, installed together in one `npm install`.
 * The user can uncheck any, such as one they install another way; the recommended packages and updates
 * they uncheck are remembered. Resolves to the packages installed, or undefined when nothing was.
 */
async function choosePackages(root: string, required: readonly string[]): Promise<string[] | undefined> {
  const declined = workspaceState.get<string[]>(DECLINED_PACKAGES) ?? [];
  const declinedUpdates = workspaceState.get<string[]>(DECLINED_UPDATES) ?? [];
  const recommended = config.recommendedPackages(root).filter((spec) => !required.includes(spec));
  // a required package replaces an outdated one of the same name, such as an older TypeScript
  const updates = config.outdatedPackages(root).filter(({ name }) => !required.some((spec) => packageName(spec) === name));
  const items = [
    ...required.map((spec) => ({ label: spec, description: menu.required(), detail: packagePurpose(spec), picked: true })),
    ...updates.map(({ spec, installed }) => ({
      label: spec,
      description: menu.updateFrom(installed),
      detail: packagePurpose(spec),
      picked: !declinedUpdates.includes(spec),
    })),
    ...recommended.map((spec) => ({
      label: spec,
      description: menu.recommended(),
      detail: packagePurpose(spec),
      picked: !declined.includes(packageName(spec)),
    })),
  ];
  if (items.length === 0) {
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    title: menu.packagesTitle(path.basename(root)),
    placeHolder: menu.packagesPlaceholder(),
  });
  if (picked === undefined) {
    return undefined;
  }
  const chosen = picked.map((item) => item.label);
  const unchosen = recommended.filter((spec) => !chosen.includes(spec)).map(packageName);
  const rechosen = new Set(chosen.map(packageName));
  await workspaceState.update(DECLINED_PACKAGES, [...new Set([...declined.filter((name) => !rechosen.has(name)), ...unchosen])]);
  const updateSpecs = updates.map((update) => update.spec);
  const unchosenUpdates = updateSpecs.filter((spec) => !chosen.includes(spec));
  await workspaceState.update(DECLINED_UPDATES, [
    ...new Set([...declinedUpdates.filter((spec) => !chosen.includes(spec)), ...unchosenUpdates]),
  ]);
  if (chosen.length === 0 || !(await installPackages(root, chosen))) {
    return undefined;
  }
  return chosen;
}

/** Offers the packages in a menu, installs the ones chosen, and sets the project up again with them. */
async function installAndSetUp(root: string, required: readonly string[]): Promise<void> {
  const installed = await choosePackages(root, required);
  if (installed !== undefined) {
    // setting up again picks the new packages up (the Lightning types' typings), and restarts TypeScript
    await setUpProject(root, { installed });
  }
}

/**
 * Sets a project up. The first step is the TypeScript 7 extension, which runs the mapper: without it,
 * setup asks for it, and carries on once it's installed (see registerSetup's connect).
 */
export async function setUpProject(
  root: string,
  /** The packages Install Packages just installed, to carry on setting up with them. */
  options: { installed?: readonly string[] } = {},
): Promise<void> {
  if (!hasTypeScript7()) {
    await askForTypeScript7(root);
    return;
  }
  settingUp.add(root);
  try {
    await setUpWithTypeScript7(root, options);
  } finally {
    settingUp.delete(root);
  }
}

/** Setup's first step without TypeScript 7: asks for it, or explains why it didn't start. */
async function askForTypeScript7(root: string): Promise<void> {
  const { unavailable } = typescript7;
  if (unavailable.reason === "failed") {
    await showIssue(typescript7FailedIssue(unavailable.error));
    return;
  }
  waitingForTypeScript7 = root;
  const choice = await tell("warning", message.installTypeScript7(path.basename(root)), "typescript-7-extension", [button.showExtension]);
  if (choice === button.showExtension) {
    await vscode.commands.executeCommand("extension.open", TYPESCRIPT_7_EXTENSION);
  }
}

/**
 * Writes the configuration the mapper's README describes (see planSetup), asking before replacing another
 * `lwc` folder's `tsconfig.json`. It turns on the workspace settings TypeScript 7 needs to run the mapper,
 * offers to point `js/ts.tsdk.path` at the project's TypeScript, and offers to install the packages the
 * config uses, which a project without TypeScript 7.1 available needs first.
 */
async function setUpWithTypeScript7(root: string, { installed = [] }: { installed?: readonly string[] }): Promise<void> {
  const typescript = typescriptOptions(root);
  const plan = config.planSetup(root, typescript);
  if ("error" in plan) {
    const { error, missing } = plan;
    // the errors are about the TypeScript version, or a project there's nothing to set up in
    const section = missing !== undefined || error.includes("TypeScript") ? "typescript-version" : "project-config-jsconfigjson";
    const choice = await tell("error", message.setupError(error), section, missing !== undefined ? [button.installPackages] : []);
    if (choice === button.installPackages) {
      await installAndSetUp(root, missing!);
    }
    return;
  }
  // The TypeScript the editor runs comes first, before anything is written: turning TypeScript 7 on
  // starts its language server, which says which version it runs. Content mappers run code from the
  // project's node_modules, so turning them on is the user's call: setup asks, and stops without it.
  const settingsNeeded = workspaceSettingsToEnable(root);
  if (settingsNeeded.length > 0) {
    const names = settingsNeeded.map(([key]) => `js/ts.${key}`);
    const choice = await tell(
      "warning",
      message.turnOnWorkspaceSettings(path.basename(root), names),
      "workspace-settings",
      [button.turnOnSettings],
      {
        question: true,
      },
    );
    if (choice !== button.turnOnSettings) {
      return;
    }
  }
  const settingsChanged = await enableWorkspaceSettings(root, settingsNeeded);
  const done: string[] = installed.length > 0 ? [step.installed(installed)] : [];
  // the project's TypeScript, which the version check passed, unless the setting names another
  const projectTypeScript = tsdkPath(root) === undefined && config.installedVersion(root, "typescript") !== undefined;
  const version = await languageServerVersion({ starting: settingsChanged.some((change) => change.includes("useTsgo")) });
  let restarted = false;
  if (version !== undefined && !config.supportsContentMappers(version)) {
    const choice = await tell(
      "warning",
      projectTypeScript
        ? message.editorTypeScriptUseProject(version, PROJECT_TSDK)
        : message.editorTypeScriptSelect(version, path.basename(root)),
      "editor-typescript",
      [...(projectTypeScript ? [button.useProjectTypeScript] : []), button.selectVersion],
      { question: true },
    );
    if (choice === button.selectVersion) {
      await vscode.commands.executeCommand(SELECT_TYPESCRIPT_VERSION);
    }
    if (choice !== button.useProjectTypeScript) {
      return;
    }
    await useProjectTypeScript(root);
    done.push(step.setSetting("js/ts.tsdk.path", PROJECT_TSDK));
    restarted = true;
  }
  // checked now, rather than at the next startup, since the project will run the mapper with it
  void nodeIssue().then((issue) => issue && showIssue(issue));
  const { file, projectConfig, shadowing, invalid } = plan;
  const configPath = projectConfig.path;
  // with the setting off, the configs only change when the user turns it on
  const configChanges = [
    ...(plan.projectConfigChange === "unchanged" ? [] : [configPath, ...(plan.movedFrom === undefined ? [] : [plan.movedFrom])]),
    ...plan.writes.map((write) => write.path).filter(isLwcConfig),
    ...plan.removals,
  ];
  let applied = plan;
  if (configChanges.length > 0 && !managesConfigs()) {
    const choice = await tell(
      "warning",
      message.setupChangesConfigs(path.basename(root), relative(root, configChanges), MAINTAIN_SETTING_NAME),
      "keeping-configs-in-step",
      [button.turnOnAndContinue],
      { modal: true },
    );
    if (choice === button.turnOnAndContinue) {
      await turnOnConfigs();
    } else {
      applied = {
        ...plan,
        projectConfigChange: "unchanged",
        writes: plan.writes.filter((write) => !isLwcConfig(write.path)),
        removals: [],
      };
      done.push(step.leftUnchanged(relative(root, configChanges), MAINTAIN_SETTING_NAME));
    }
  }
  const { written, removed } = config.applySetup(applied);

  if (applied.projectConfigChange === "created") {
    done.push(step.created(path.relative(root, configPath)));
  } else if (applied.projectConfigChange === "moved") {
    done.push(step.moved(path.relative(root, plan.movedFrom!), path.relative(root, configPath)));
  } else if (applied.projectConfigChange === "updated") {
    done.push(step.updated(path.relative(root, configPath)));
  }
  if (written.length > 0) {
    done.push(step.wrote(relative(root, written)));
  }
  if (removed.length > 0) {
    done.push(step.removed(relative(root, removed)));
  }

  done.push(...settingsChanged);
  // the new packages only take effect once TypeScript restarts
  if (installed.length > 0 && !restarted) {
    await vscode.commands.executeCommand(RESTART_TYPESCRIPT);
    restarted = true;
  }
  if (restarted) {
    done.push(step.restartedTypeScript());
  }

  const missing = config.missingPackages(root, typescript);
  const recommended = suggestedPackages(root);
  const updates = suggestedUpdates(root).filter(({ name }) => !missing.some((spec) => packageName(spec) === name));
  const packages = [...missing, ...recommended, ...updates.map((update) => update.spec)];
  // updating is all there is to do, or installing, which offers the updates too
  const packagesAction = missing.length === 0 && recommended.length === 0 ? button.updatePackages : button.installPackages;
  // the version check passed, so with nothing else named, the project's TypeScript is the one it checked
  const offerTsdk = tsdkPath(root) === undefined && config.installedVersion(root, "typescript") !== undefined;
  // a server that said its version only once setup was under way, which the check above didn't see
  const lateVersion = editorTypeScriptVersion !== undefined && !config.supportsContentMappers(editorTypeScriptVersion);
  const actions = [
    ...(offerTsdk ? [button.useProjectTypeScript] : []),
    ...(lateVersion && !offerTsdk ? [button.selectVersion] : []),
    ...(packages.length > 0 ? [packagesAction] : []),
    // only when setup changed something for TypeScript to pick up
    ...(restarted || done.length === 0 ? [] : [button.restartTypeScript]),
  ];
  const next = [
    ...(lateVersion ? [nextStep.editorTypeScript(editorTypeScriptVersion!)] : []),
    ...(file === "jsconfig.json" && !config.isStrictJson(projectConfig.text)
      ? [nextStep.jsconfigComments(path.relative(root, configPath))]
      : []),
    ...(invalid.length > 0 ? [nextStep.invalidJson(invalid, relative(root, invalid))] : []),
    ...(shadowing.length > 0 ? [nextStep.shadowing(shadowing, relative(root, shadowing))] : []),
    ...(missing.length > 0 ? [nextStep.stillNeeds(missing)] : []),
    ...(recommended.length > 0 ? [nextStep.recommended(recommended)] : []),
    ...(updates.length > 0 ? [nextStep.updates(updates.length, describeUpdates(updates))] : []),
    ...(offerTsdk ? [nextStep.useProjectTypeScript(PROJECT_TSDK)] : []),
  ];
  // nothing left to do or fix: say so, and celebrate
  const text =
    next.length === 0
      ? done.length > 0
        ? message.setUp(path.basename(root))
        : message.alreadySetUp(path.basename(root))
      : message.setupSummary(done, next);
  const choice = await tell("information", text, "how-setup-runs", actions);
  if (choice === button.useProjectTypeScript) {
    await useProjectTypeScript(root);
  } else if (choice === button.installPackages || choice === button.updatePackages) {
    await installAndSetUp(root, missing);
  } else if (choice === button.restartTypeScript) {
    await vscode.commands.executeCommand(RESTART_TYPESCRIPT);
  } else if (choice === button.selectVersion) {
    await vscode.commands.executeCommand(SELECT_TYPESCRIPT_VERSION);
  }
}

/** Points `js/ts.tsdk.path` at the project's TypeScript for the workspace, and restarts TypeScript with it. */
async function useProjectTypeScript(root: string): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  await vscode.workspace.getConfiguration("js/ts", folder?.uri).update("tsdk.path", PROJECT_TSDK, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand(RESTART_TYPESCRIPT);
}

/**
 * Writes the `lwcBolts.contentMapper.*` settings that are mapper options into the project config's
 * `contentMappers` entry, so the project maps metadata as metadata files outside any config do. A setting
 * that's unset removes its option, so the mapper applies its default, which is the setting's default.
 * `useVSCodeNode` isn't an option: projects with a config always run the `node` on the PATH.
 */
export async function applySettings(root: string): Promise<void> {
  const project = config.findProjectConfig(root);
  if (project === undefined) {
    const choice = await vscode.window.showWarningMessage(message.noProjectConfig(path.basename(root)), button.setUpProject);
    if (choice === button.setUpProject) {
      await setUpProject(root);
    }
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  const settings = readOptions(folder?.uri);
  const options = Object.fromEntries(OPTION_SETTINGS.map((name) => [name, settings[name]]));
  const relativePath = path.relative(root, project.path);
  const text = config.setContentMapperOptions(project.text, options);
  if (text === undefined) {
    void vscode.window.showErrorMessage(message.invalidJson(relativePath));
    return;
  }
  if (text === project.text) {
    void vscode.window.showInformationMessage(message.alreadyUsesSettings(relativePath, SETTINGS_SECTION));
    return;
  }
  if (!managesConfigs()) {
    const choice = await tell(
      "warning",
      message.applyChangesConfig(SETTINGS_SECTION, relativePath, MAINTAIN_SETTING_NAME),
      "keeping-configs-in-step",
      [button.turnOnAndApply],
    );
    if (choice !== button.turnOnAndApply) {
      return;
    }
    await turnOnConfigs();
  }
  writeFileSync(project.path, text);
  const set = Object.keys(settings);
  void vscode.window.showInformationMessage(message.appliedSettings(SETTINGS_SECTION, relativePath, set));
}

/** The workspace settings TypeScript 7 needs to run the mapper, which setup asks before turning on. */
const WORKSPACE_SETTINGS: readonly (readonly [string, unknown])[] = [
  ["experimental.useTsgo", true],
  ["contentMappers.enabled", true],
];

/** The workspace settings the project's config needs that aren't on yet. */
function workspaceSettingsToEnable(root: string): (readonly [string, unknown])[] {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  const settings = vscode.workspace.getConfiguration("js/ts", folder?.uri);
  return WORKSPACE_SETTINGS.filter(([key, value]) => settings.get(key) !== value);
}

/** Turns on the workspace settings the user agreed to (see workspaceSettingsToEnable). Returns what it changed. */
async function enableWorkspaceSettings(root: string, updates: readonly (readonly [string, unknown])[]): Promise<string[]> {
  const changed: string[] = [];
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
  const settings = vscode.workspace.getConfiguration("js/ts", folder?.uri);
  for (const [key, value] of updates) {
    try {
      await settings.update(key, value, vscode.ConfigurationTarget.Workspace);
      changed.push(step.setSetting(`js/ts.${key}`, JSON.stringify(value)));
    } catch {
      // a setting this VS Code doesn't know; the summary's other steps still apply
    }
  }
  return changed;
}

/**
 * Keeps a project's `lwc` folder configs, jsconfig.json or tsconfig.json, in the shape the content mapper
 * needs (see project-setup's planMaintenance): each is checked against its policy, which blocks the
 * settings known to break the mapper and enforces the ones it needs, with sfdx-project.json's package
 * directories merged in, and one that doesn't conform gets just those changes. The Salesforce extensions
 * merge their template into every jsconfig.json when they start, and other tools or people can change
 * either file. This undoes just those parts, at startup and whenever a config changes, and keeps the rest. A file something keeps rewriting is left alone (see
 * project-setup's RewriteLimiter), so the two extensions don't fight over it.
 */
class LwcConfigKeeper {
  readonly #watched = new Set<string>();
  /** The configs left alone that the user was reminded of, so a change doesn't remind them again. */
  readonly #reminded = new Set<string>();
  readonly #rewrites = new config.RewriteLimiter();
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /** Enforces the configs in a project now, and from then on whenever one changes. */
  watch(root: string): void {
    if (!this.#watched.has(root)) {
      this.#watched.add(root);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), "{**/jsconfig.json,**/tsconfig.json}"),
      );
      const enforce = () => this.enforce(root);
      this.context.subscriptions.push(watcher, watcher.onDidChange(enforce), watcher.onDidCreate(enforce), watcher.onDidDelete(enforce));
    }
    this.enforce(root);
  }

  enforce(root: string): void {
    if (!this.#watched.has(root)) {
      return;
    }
    const writes = config.planMaintenance(root);
    const manages = managesConfigs();
    // with the setting off, the configs are left alone, and only the other files (the Lightning typings) written
    for (const write of writes.filter((each) => manages || !isLwcConfig(each.path))) {
      this.restore(root, write);
    }
    const leftAlone = manages ? [] : writes.map((write) => write.path).filter(isLwcConfig);
    // once a session for the same files, as a config that's out of shape changes often
    const key = `${root}\0${leftAlone.join("\0")}`;
    if (leftAlone.length > 0 && !this.#reminded.has(key)) {
      this.#reminded.add(key);
      void remind(configsIssue(root, leftAlone).message, button.turnOn).then((choice) =>
        choice === button.turnOn ? turnOnConfigs() : undefined,
      );
    }
  }

  /** Writes a restored config, unless something keeps rewriting it. */
  private restore(root: string, { path: file, text, changes = [] }: FileWrite): void {
    const decision = this.#rewrites.rewrite(file);
    if (decision === "stop") {
      void prompt(message.stoppedRestoring(path.relative(root, file)), "keeping-configs-in-step");
    }
    if (decision !== "write") {
      return;
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`Lightning Bolts: restored ${file}${changes.length > 0 ? ` (${changes.join("; ")})` : ""}`);
    } catch (error) {
      console.error(`Lightning Bolts: unable to restore ${file}`, error);
    }
  }
}

/** Checks for the usual reasons the content mapper doesn't run, and explains each with a fix. */
class SetupHealth {
  /** Issues already shown this session, so the startup check doesn't repeat them. */
  readonly #shown = new Set<string>();

  constructor(context: vscode.ExtensionContext) {
    this.listen(context);
  }

  /** Checks the TypeScript version each time TypeScript 7's language server starts, once there's one. */
  listen(context: vscode.ExtensionContext): void {
    const { api } = typescript7;
    if (typeof api?.onLanguageServerInitialized === "function") {
      context.subscriptions.push(
        // TypeScript 7 extensions such as 1.0.1 call this without the SDK when the server is already
        // running, so there's no version to check then.
        api.onLanguageServerInitialized((sdk: { version?: string } | undefined) => {
          if (typeof sdk?.version === "string") {
            editorTypeScriptVersion = sdk.version;
          }
          // a setup waiting for the server it started checks the version itself
          serverStartWaiters.forEach((resume) => resume());
          serverStartWaiters.clear();
          if (typeof sdk?.version !== "string") {
            return;
          }
          // Nothing to say outside an SFDX project. During setup, setup says it, before writing anything.
          const roots = sfdxRoots().filter((root) => root !== waitingForTypeScript7);
          if (roots.length === 0 || settingUp.size > 0) {
            return;
          }
          // The packages come first (see editorTypeScriptIssue), and the startup check offers them.
          const configured = roots.filter((root) => config.findProjectConfig(root) !== undefined);
          if (configured.length < roots.length || configured.some((root) => packageIssues(root).length > 0)) {
            return;
          }
          const issue = editorTypeScriptIssue(configured);
          if (issue !== undefined) {
            void this.show([issue], { quiet: true });
          }
        }),
      );
    }
  }

  async check({ quiet }: { quiet: boolean }): Promise<void> {
    const issues: Issue[] = [];
    const allRoots = sfdxRoots();
    if (allRoots.length === 0) {
      // nothing to check, or say, outside an SFDX project; asked for, it says what it needs
      if (!quiet) {
        void vscode.window.showErrorMessage(message.openSfdxFolder());
      }
      return;
    }
    const roots = allRoots.filter((root) => !settingUp.has(root) && root !== waitingForTypeScript7);
    if (!hasTypeScript7()) {
      // Setup starts with TypeScript 7, so without it, each project is offered setup, which asks for
      // TypeScript 7, or explains why it didn't start. Nothing else asks for it.
      issues.push(...roots.map(setUpIssue));
      return this.show(issues, { quiet });
    }
    const configured = roots.filter((root) => config.findProjectConfig(root) !== undefined);
    issues.push(...roots.filter((r) => !configured.includes(r)).map(setUpIssue));
    // Setting a project up, or installing its packages, checks the editor's TypeScript itself once the
    // packages are in, so the version waits until there's nothing to install (see editorTypeScriptIssue).
    let packagesFirst = configured.length < roots.length;
    if (vscode.workspace.isTrusted === false) {
      issues.push({
        message: message.untrustedWorkspace(),
        actions: [{ title: button.manageWorkspaceTrust, run: () => vscode.commands.executeCommand("workbench.trust.manage") }],
        docs: "workspace-trust",
      });
    }
    // a project that isn't set up yet is asked about them by setup
    const settingsIssue = configured.map(workspaceSettingsIssue).find((issue) => issue !== undefined);
    if (settingsIssue !== undefined) {
      issues.push(settingsIssue);
    }
    for (const root of configured) {
      // on demand, the configs the extension leaves alone with the setting off; startup's reminders come from the keeper
      if (!quiet && !managesConfigs()) {
        const leftAlone = config
          .planMaintenance(root)
          .map((write) => write.path)
          .filter(isLwcConfig);
        if (leftAlone.length > 0) {
          issues.push(configsIssue(root, leftAlone));
        }
      }
      const project = config.findProjectConfig(root);
      if (project?.file === "jsconfig.json" && !config.isStrictJson(project.text)) {
        issues.push({
          message: message.jsconfigComments(path.relative(root, project.path)),
          docs: "comments-in-jsconfigjson",
        });
      }
      const packages = packageIssues(root);
      issues.push(...packages);
      packagesFirst ||= packages.length > 0;
      if (config.installedVersion(root, config.CONTENT_MAPPER_PACKAGE) === undefined) {
        // the install menu that fixes it offers the recommended packages too
        continue;
      }
      if (!quiet) {
        // only on demand: they're suggestions, not problems, so startup leaves them to setup
        const suggested = suggestedPackages(root);
        if (suggested.length > 0) {
          issues.push({
            message: message.recommendedPackages(
              path.basename(root),
              // lowercased to read mid-sentence, unless it starts with a name such as TypeScript
              suggested.map((spec) =>
                recommendedPackage(
                  spec,
                  packagePurpose(spec).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()),
                ),
              ),
            ),
            actions: [{ title: button.installPackages, run: () => installAndSetUp(root, []) }],
            docs: "packages",
          });
        }
      }
    }
    if (configured.length > 0) {
      const issue = await nodeIssue();
      if (issue !== undefined) {
        issues.push(issue);
      }
    }
    const typescript = packagesFirst ? undefined : editorTypeScriptIssue(configured);
    if (typescript !== undefined) {
      issues.push(typescript);
    }
    if (issues.length === 0 && !quiet) {
      void vscode.window.showInformationMessage(message.setupLooksGood());
    }
    return this.show(issues, { quiet });
  }

  /**
   * Shows the issues, each with its fixes. At startup (quiet), they're prompts, and several at once are
   * one prompt whose Show Details lists them, as Check Content Mapper Setup does whether or not they're
   * silenced; each is only shown once a session.
   */
  private async show(issues: readonly Issue[], { quiet }: { quiet: boolean }): Promise<void> {
    if (!quiet) {
      await Promise.all(issues.map((issue) => showIssue(issue)));
      return;
    }
    const unshown = issues.filter((issue) => !this.#shown.has(issue.message));
    unshown.forEach((issue) => this.#shown.add(issue.message));
    if (unshown.length === 1) {
      await showIssue(unshown[0]!, { quiet });
    } else if (unshown.length > 1) {
      const choice = await prompt(message.foundProblems(unshown.length), "troubleshooting", [button.showDetails]);
      if (choice === button.showDetails) {
        await Promise.all(unshown.map((issue) => showIssue(issue)));
      }
    }
  }
}

/** The configs that aren't in shape, which the extension leaves alone while MAINTAIN_SETTING is off. */
function configsIssue(root: string, files: readonly string[]): Issue {
  return {
    message: message.configsLeftAlone(files, relative(root, files), MAINTAIN_SETTING_NAME),
    actions: [{ title: button.turnOn, run: turnOnConfigs }],
    docs: "keeping-configs-in-step",
  };
}

/**
 * A configured project's package problems: the mapper it registers isn't installed, or packages are older
 * than the versions the extension knows of. Each offers the package menu, which sets the project up again
 * once they're installed. Not missingPackages, which can run the global tsc, and this runs at startup.
 */
function packageIssues(root: string): Issue[] {
  if (config.installedVersion(root, config.CONTENT_MAPPER_PACKAGE) === undefined) {
    const missing = [config.CONTENT_MAPPER_PACKAGE];
    // the install menu that fixes it offers the updates too
    return [
      {
        message: message.mapperNotInstalled(path.basename(root), config.CONTENT_MAPPER_PACKAGE),
        actions: [{ title: button.installPackages, run: () => installAndSetUp(root, missing) }],
        docs: "mapper-not-installed",
      },
    ];
  }
  const updates = suggestedUpdates(root);
  if (updates.length > 0) {
    return [
      {
        message: message.updatesAvailable(updates.length, path.basename(root), describeUpdates(updates)),
        actions: [{ title: button.updatePackages, run: () => installAndSetUp(root, []) }],
        docs: "packages",
      },
    ];
  }
  return [];
}

/**
 * The editor's TypeScript, when it can't run content mappers. Selecting another version only helps once
 * there's a TypeScript 7.1 to select, so a configured project without one installed (and no
 * `js/ts.tsdk.path` naming another) is offered TypeScript 7.1 first; setting it up again with it then
 * asks to use it. Only asked once the projects have nothing else to install (see packageIssues).
 */
function editorTypeScriptIssue(configured: readonly string[]): Issue | undefined {
  const version = typescriptVersionIssue();
  if (version === undefined) {
    return undefined;
  }
  const root = configured.find((each) => {
    const installed = config.installedVersion(each, "typescript");
    return tsdkPath(each) === undefined && (installed === undefined || !config.supportsContentMappers(installed));
  });
  if (root === undefined) {
    return version;
  }
  const required = [config.TYPESCRIPT_PACKAGE];
  return {
    message: message.installTypeScriptForEditor(editorTypeScriptVersion!, path.basename(root)),
    actions: [{ title: button.installPackages, run: () => installAndSetUp(root, required) }],
    docs: "editor-typescript",
  };
}

/**
 * The workspace settings a set-up project needs that are off (see workspaceSettingsToEnable). Turning them
 * on is the user's call, as in setup, so it's only done from the message's button.
 */
function workspaceSettingsIssue(root: string): Issue | undefined {
  const needed = workspaceSettingsToEnable(root);
  if (needed.length === 0) {
    return undefined;
  }
  const names = needed.map(([key]) => `js/ts.${key}`);
  return {
    message: message.workspaceSettingsOff(names),
    actions: [{ title: button.turnOnSettings, run: () => enableWorkspaceSettings(root, needed) }],
    docs: "workspace-settings",
  };
}

/** The TypeScript the language server runs, when it's one that can't run content mappers. */
function typescriptVersionIssue(): Issue | undefined {
  const version = editorTypeScriptVersion;
  if (version === undefined || config.supportsContentMappers(version)) {
    return undefined;
  }
  return {
    message: message.typescriptCantRunMappers(version),
    actions: [{ title: button.selectVersion, run: () => vscode.commands.executeCommand(SELECT_TYPESCRIPT_VERSION) }],
    docs: "editor-typescript",
  };
}

/**
 * The TypeScript version the language server runs. When setup just turned TypeScript 7 on, which starts
 * the server, it waits a while for the server to say; otherwise it's what the server said when it last
 * started, if it did.
 */
async function languageServerVersion({ starting }: { starting: boolean }): Promise<string | undefined> {
  if (starting && typeof typescript7.api?.onLanguageServerInitialized === "function") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      serverStartWaiters.add(resolve);
      timer = setTimeout(() => (serverStartWaiters.delete(resolve), resolve()), SERVER_START_TIMEOUT_MS);
    });
    clearTimeout(timer);
  }
  return editorTypeScriptVersion;
}

/**
 * Offers to set a project up: one without a config, or any project without TypeScript 7, which setup
 * starts with.
 */
function setUpIssue(root: string): Issue {
  // a project that isn't set up is an offer; one set up without TypeScript 7 running is a problem
  const notSetUp = hasTypeScript7() || config.findProjectConfig(root) === undefined;
  return {
    message: notSetUp ? message.notSetUp(path.basename(root)) : message.typescript7NotRunning(path.basename(root)),
    actions: [{ title: button.setUpProject, run: () => setUpProject(root) }],
    docs: "how-setup-runs",
    level: notSetUp ? "information" : "warning",
  };
}

/** Why the TypeScript 7 extension, which is installed, has no API for setup to use, with what fixes it. */
function typescript7FailedIssue(error: unknown): Issue {
  return {
    message:
      error === undefined
        ? message.typescript7WithoutApi()
        : message.typescript7Failed(error instanceof Error ? error.message : String(error)),
    actions: [
      ...(error === undefined
        ? [{ title: button.showExtension, run: () => vscode.commands.executeCommand("extension.open", TYPESCRIPT_7_EXTENSION) }]
        : [{ title: button.showError, run: () => showError(message.typescript7FailedTitle(), error) }]),
      { title: button.reloadWindow, run: () => vscode.commands.executeCommand("workbench.action.reloadWindow") },
    ],
    docs: "typescript-7-extension",
  };
}

/** Shows an issue with its fixes, and runs the one chosen. At startup (quiet), it's a prompt. */
async function showIssue(issue: Issue, { quiet = false } = {}): Promise<void> {
  const actions = issue.actions ?? [];
  const titles = actions.map((action) => action.title);
  const level = issue.level ?? "warning";
  const choice = await (quiet ? prompt(issue.message, issue.docs, titles, level) : tell(level, issue.message, issue.docs, titles));
  await actions.find((action) => action.title === choice)?.run();
}

/**
 * Projects with a config run the mapper as its package.json says, with the `node` on the PATH, which
 * an extension can't change (only metadata files outside any config use VS Code's own Node.js).
 */
async function nodeIssue(): Promise<Issue | undefined> {
  const version = await nodeOnPath();
  const required = mapperNodeEngine ?? ">=22.18";
  if (version !== undefined && satisfiesMinimum(version, required)) {
    return undefined;
  }
  return {
    message: message.nodeTooOld(required.replace(/^>=\s*/, ""), version),
    actions: [{ title: button.downloadNodeJs, run: () => vscode.env.openExternal(vscode.Uri.parse("https://nodejs.org/en/download")) }],
    docs: "nodejs-on-your-path",
  };
}
