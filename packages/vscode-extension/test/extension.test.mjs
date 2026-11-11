// Unit tests for the compiled extension (`npm run build` first), with a stub `vscode` module (see loadExtension.mjs).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as realProjectSetup from "@lwc-bolts/project-setup";
import { METADATA_TYPES, OPTION_DEFAULTS, OPTION_NAMES } from "@lwc-bolts/typescript-content-mapper/options";
import { loadExtension } from "./loadExtension.mjs";

const require = createRequire(import.meta.url);
const extensionDir = path.resolve(import.meta.dirname, "..");
const manifest = require("../package.json");
/**
 * Formats a message as vscode.l10n.t does when there's no translation: `{0}` from the arguments, or
 * `{name}` from an object of named arguments.
 */
function formatL10n(message, ...args) {
  const values = args.length === 1 && typeof args[0] === "object" && args[0] !== null ? args[0] : args;
  return message.replace(/\{([^}]+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}
/** The folder of the SFDX projects the tests use. */
const fixturesDir = path.join(extensionDir, "../../tests/fixtures");
/** The extensions the mapper handles, whose diagnostics inferred projects suppress by default. */
const HANDLED = [...realProjectSetup.CONTENT_MAPPER_EXTENSIONS];

/**
 * Loads dist/extension.js against a stub vscode API and returns what it registered. `folders` are the
 * workspace folders; `answer` picks the button for each message (by default, none).
 */
async function activate({
  settings = {},
  typescript7 = true,
  lspMiddleware = true,
  folders = [],
  trusted = true,
  typescriptVersion = undefined,
  /** How TypeScript 7 extensions such as 1.0.1 behave: an already-running server's listener gets no SDK. */
  initializedWithoutSdk = false,
  /** Makes registerContentMappers throw, as a TypeScript 7 extension that rejects the contribution would. */
  contentMapperError = undefined,
  /** Makes loading @lwc-bolts/project-setup fail, as in a broken installation. */
  projectSetupError = undefined,
  /** Replaces @lwc-bolts/project-setup, as {@link fakeProjectSetup} makes one. */
  projectSetup = undefined,
  /** What `node --version` prints for the node on the PATH; null for none. */
  nodeVersion = process.version,
  answer = () => undefined,
  /** The workspace state of a previous session, as {@link activate} returns it in `context`. */
  workspaceState = undefined,
  /** Makes the TypeScript 7 extension's activate() throw this. */
  typescript7Error = undefined,
  /** The exit code of each `npm install` the extension runs. */
  installExitCode = 0,
  /** The TypeScript version the language server says it runs when turning on useTsgo starts it. */
  startedTypeScriptVersion = typescriptVersion,
  /** Picks from the package menu (by default, what's checked); undefined dismisses it. */
  pickPackages = (items) => items.filter((item) => item.picked),
  /** Answers the questions about turning on the workspace settings with Turn On Settings, unless `answer` does. */
  approveSettings = true,
} = {}) {
  const registrations = [];
  /** @type {Record<string, Function>} */
  const middleware = {};
  /** @type {((event: { affectsConfiguration(section: string): boolean }) => void)[]} */
  const configurationListeners = [];
  /** @type {{ level: string, message: string, actions: string[] }[]} */
  const messages = [];
  /** @type {Record<string, Function>} */
  const commands = {};
  const executed = [];
  /** The `npm install` tasks the extension ran: their command line and folder. */
  const installs = [];
  /** The package menus shown: each one's items. */
  const menus = [];
  const output = [];
  /** @type {Function[]} */
  const extensionListeners = [];
  /** TypeScript 7's onLanguageServerInitialized listeners. */
  const serverListeners = [];
  /** @type {Function[]} */
  const taskEndListeners = [];
  /** @type {{ pattern: string, listeners: Record<"change" | "create" | "delete", Function[]> }[]} */
  const watchers = [];
  const state = new Map();
  const message =
    (level) =>
    async (text, ...actions) => {
      const buttons = actions.filter((action) => typeof action === "string");
      const modal = actions.some((action) => typeof action === "object" && action?.modal === true);
      const entry = { level, message: text, actions: buttons, ...(modal && { modal }) };
      messages.push(entry);
      const choice = await answer(entry);
      return choice === undefined && approveSettings && buttons.includes("Turn On Settings") ? "Turn On Settings" : choice;
    };
  const vscode = {
    extensions: {
      getExtension: (id) =>
        typescript7 && id === "TypeScriptTeam.native-preview"
          ? {
              activate: async () => {
                if (typescript7Error) {
                  throw typescript7Error;
                }
                return {
                  registerContentMappers: (contributorId, contributions) => {
                    if (contentMapperError) {
                      throw contentMapperError;
                    }
                    const registration = { contributorId, contributions, disposed: false };
                    registrations.push(registration);
                    return { dispose: () => (registration.disposed = true) };
                  },
                  onLanguageServerInitialized: (listener) => {
                    serverListeners.push(listener);
                    if (initializedWithoutSdk) {
                      listener();
                    } else if (typescriptVersion !== undefined) {
                      listener({ version: typescriptVersion });
                    }
                    return { dispose() {} };
                  },
                  // TypeScript 7 extensions before the LSP middleware API (such as 1.0.1) lack this
                  ...(lspMiddleware && {
                    registerLspMiddleware: (method, transformer) => {
                      middleware[method] = transformer;
                      return { dispose: () => delete middleware[method] };
                    },
                  }),
                };
              },
            }
          : undefined,
      onDidChange: (listener) => {
        extensionListeners.push(listener);
        return { dispose: () => extensionListeners.splice(extensionListeners.indexOf(listener), 1) };
      },
    },
    workspace: {
      workspaceFolders: folders.length > 0 ? folders.map((fsPath) => ({ uri: { scheme: "file", fsPath } })) : undefined,
      isTrusted: trusted,
      getWorkspaceFolder: (uri) => ({ uri }),
      getConfiguration: () => ({
        inspect: (name) => settings[name],
        get: (name, defaultValue) => {
          const inspected = settings[name];
          const value = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue].find(
            (candidate) => candidate !== undefined,
          );
          return value ?? defaultValue;
        },
        update: async (name, value) => {
          settings[name] = { ...settings[name], workspaceValue: value };
          // turning TypeScript 7 on starts its language server, which says which version it runs
          if (name === "experimental.useTsgo" && value === true) {
            setTimeout(() =>
              serverListeners.forEach((listener) =>
                startedTypeScriptVersion === undefined ? listener() : listener({ version: startedTypeScriptVersion }),
              ),
            );
          }
        },
      }),
      onDidChangeConfiguration: (listener) => {
        configurationListeners.push(listener);
        return { dispose() {} };
      },
      createFileSystemWatcher: ({ pattern }) => {
        const watcher = { pattern, listeners: { change: [], create: [], delete: [] } };
        watchers.push(watcher);
        const on = (kind) => (listener) => (watcher.listeners[kind].push(listener), { dispose() {} });
        return { onDidChange: on("change"), onDidCreate: on("create"), onDidDelete: on("delete"), dispose() {} };
      },
    },
    window: {
      showWarningMessage: message("warning"),
      showInformationMessage: message("information"),
      showErrorMessage: message("error"),
      showQuickPick: async (items, options) => {
        if (!options?.canPickMany) {
          return items[0];
        }
        menus.push(items);
        return pickPackages(items);
      },
      createOutputChannel: () => ({ appendLine: (line) => output.push(line), show() {} }),
    },
    tasks: {
      executeTask: async (task) => {
        const execution = { task };
        installs.push({ commandLine: task.execution.commandLine, cwd: task.execution.options.cwd });
        setTimeout(() => [...taskEndListeners].forEach((listener) => listener({ execution, exitCode: installExitCode })));
        return execution;
      },
      onDidEndTaskProcess: (listener) => {
        taskEndListeners.push(listener);
        return { dispose: () => taskEndListeners.splice(taskEndListeners.indexOf(listener), 1) };
      },
    },
    Task: class {
      constructor(definition, scope, name, source, execution) {
        Object.assign(this, { definition, scope, name, source, execution });
      }
    },
    ShellExecution: class {
      constructor(commandLine, options) {
        Object.assign(this, { commandLine, options });
      }
    },
    TaskScope: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand: (id, callback) => {
        commands[id] = callback;
        return { dispose: () => delete commands[id] };
      },
      executeCommand: async (id, ...args) => executed.push([id, ...args]),
    },
    env: { openExternal: async (uri) => executed.push(["openExternal", uri]) },
    // the English source, formatted as vscode.l10n.t formats it without a translation
    l10n: { t: formatL10n },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class {
      constructor(base, pattern) {
        Object.assign(this, { base, pattern });
      }
    },
    Uri: {
      file: (fsPath) => fileUri(fsPath),
      parse: (value) => ({ value }),
      joinPath: (base, ...segments) => fileUri(path.join(base.fsPath, ...segments)),
    },
  };
  const stubs = { vscode, "./nodeOnPath.js": { nodeOnPath: async () => nodeVersion ?? undefined } };
  if (projectSetupError) {
    stubs["./projectSetupLoader.js"] = { loadProjectSetup: async () => Promise.reject(projectSetupError) };
  } else if (projectSetup) {
    stubs["./projectSetupLoader.js"] = { loadProjectSetup: async () => projectSetup };
  }
  // a new copy of every compiled module, so none keeps a previous test's state or stubs
  const extension = await loadExtension(stubs);
  const context = {
    subscriptions: [],
    extension: { id: "aheber.lwc-bolts-vscode" },
    extensionUri: fileUri(extensionDir),
    workspaceState: workspaceState ?? { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) },
  };
  await extension.activate(context);
  const changeSettings = (next, section = "lwcBolts.contentMapper") => {
    Object.assign(settings, next);
    configurationListeners.forEach((listener) => listener({ affectsConfiguration: (s) => s === section }));
  };
  /** Lets the startup checks (which don't block activation) finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  /** Fires the change listeners of the watchers whose pattern is `pattern`, or contains it. */
  const changeFiles = async (pattern) => {
    watchers.filter((w) => w.pattern.includes(pattern)).forEach((w) => w.listeners.change.forEach((listener) => listener()));
    await settle();
  };
  const changeSfdxProject = () => changeFiles("sfdx-project.json");
  /** Starts TypeScript 7's language server after activation, which says it runs `version`. */
  const startServer = async (version) => {
    serverListeners.forEach((listener) => listener({ version }));
    await settle();
  };
  /** Installs TypeScript 7, as the user would from the Extensions view. */
  const installTypeScript7 = async () => {
    typescript7 = true;
    extensionListeners.forEach((listener) => listener());
    await settle();
  };
  return {
    extension,
    registrations,
    middleware,
    context,
    changeSettings,
    messages,
    commands,
    executed,
    installs,
    menus,
    output,
    installTypeScript7,
    startServer,
    settings,
    settle,
    changeFiles,
    changeSfdxProject,
  };
}

describe("content mapper registration", () => {
  it("registers the bundled mapper for .cls, .xml and .html with TypeScript 7", async () => {
    const { registrations } = await activate();
    assert.equal(registrations.length, 1);
    const [{ contributorId, contributions }] = registrations;
    assert.equal(contributorId, "aheber.lwc-bolts-vscode");
    assert.deepEqual(contributions[0].extensions, [".cls", ".xml", ".html"]);
    const { manifest: mapper, options } = contributions[0].inferredProjectContribution;
    assert.equal(mapper.name, "@lwc-bolts/typescript-content-mapper");
    // the test runner's Node.js satisfies the mapper's engines and isn't Electron, so it runs the mapper
    assert.deepEqual(mapper.exec, [process.execPath, "./dist/server.js"]);
    assert.equal(mapper.dynamicConfig, true);
    assert.equal(path.basename(mapper.cwd.fsPath), "typescript-content-mapper");
    assert.deepEqual(options, { suppressDiagnosticsExtensions: [".cls", ".xml", ".html"] });
  });

  it("registers auto-import middleware for completions and quick fixes", async () => {
    const { middleware, context } = await activate();
    assert.deepEqual(Object.keys(middleware).sort(), ["completionItem/resolve", "textDocument/codeAction", "textDocument/completion"]);
    // the code action middleware passes the document the fixes are for
    const lwc = path.join(fixturesDir, "example-project/force-app/main/default/lwc");
    const uri = new URL(`file://${path.join(lwc, "comp3/comp3.js")}`).href;
    const fixed = middleware["textDocument/codeAction"]([{ title: 'Add import from "../comp2/comp2"', kind: "quickfix" }], {
      params: { textDocument: { uri } },
    });
    assert.equal(fixed[0].title, 'Add import from "c/comp2"');
    context.subscriptions.forEach((subscription) => subscription.dispose());
    assert.deepEqual(Object.keys(middleware), []);
  });

  it("still registers the content mapper with a TypeScript 7 extension that has no LSP middleware API", async () => {
    const { registrations, middleware } = await activate({ lspMiddleware: false });
    assert.equal(registrations.length, 1);
    assert.deepEqual(Object.keys(middleware), []);
  });

  it("activates with a TypeScript 7 extension that initializes listeners without the SDK (1.0.1)", async () => {
    // 1.0.1 calls the listener at once, without an argument, when its server is already running; the
    // setup check used to read the SDK's version from it, which failed activation ("command not found")
    const errors = [];
    const consoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const { commands, registrations, messages, settle } = await activate({ initializedWithoutSdk: true });
      await settle();
      assert.deepEqual(Object.keys(commands).sort(), ["lwcBolts.applySettingsToProject", "lwcBolts.checkSetup", "lwcBolts.setUpProject"]);
      assert.equal(registrations.length, 1);
      assert.ok(!messages.some((m) => /TypeScript .* can't run content mappers/.test(m.message)), "no version, so no version warning");
      assert.deepEqual(errors, [], "nothing failed along the way");
    } finally {
      console.error = consoleError;
    }
  });

  it("still registers the setup commands and the other features when one fails", async () => {
    const errors = [];
    const consoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const { commands, middleware, registrations } = await activate({ contentMapperError: new Error("rejected") });
      assert.deepEqual(Object.keys(commands).sort(), ["lwcBolts.applySettingsToProject", "lwcBolts.checkSetup", "lwcBolts.setUpProject"]);
      assert.deepEqual(registrations, []);
      assert.equal(Object.keys(middleware).length, 3, "the auto-import rewrites are still registered");
      assert.ok(errors.some((e) => /registering the content mapper failed .*rejected/.test(e)));
    } finally {
      console.error = consoleError;
    }
  });

  it("still registers the content mapper when @lwc-bolts/project-setup can't load, and the commands explain why", async () => {
    const errors = [];
    const consoleError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const { commands, middleware, registrations, messages } = await activate({
        projectSetupError: new Error("Cannot find package '@lwc-bolts/project-setup'"),
      });
      assert.equal(registrations.length, 1);
      assert.deepEqual(registrations[0].contributions[0].extensions, [...realProjectSetup.CONTENT_MAPPER_EXTENSIONS]);
      assert.equal(Object.keys(middleware).length, 3);
      assert.ok(errors.some((e) => /unable to load @lwc-bolts\/project-setup/.test(e)));
      assert.deepEqual(messages, [], "nothing is shown until a command runs");
      await commands["lwcBolts.setUpProject"]();
      await commands["lwcBolts.checkSetup"]();
      assert.equal(messages.length, 2);
      for (const { level, message } of messages) {
        assert.equal(level, "error");
        assert.match(message, /Cannot find package '@lwc-bolts\/project-setup'.*Reinstall the extension/);
      }
    } finally {
      console.error = consoleError;
    }
  });

  it("registers the explaining commands without TypeScript 7 when @lwc-bolts/project-setup can't load", async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { commands, registrations } = await activate({ typescript7: false, projectSetupError: "broken" });
      assert.deepEqual(registrations, []);
      assert.deepEqual(Object.keys(commands).sort(), ["lwcBolts.applySettingsToProject", "lwcBolts.checkSetup", "lwcBolts.setUpProject"]);
    } finally {
      console.error = consoleError;
    }
  });

  it("only registers the setup commands without TypeScript 7, and says nothing outside an SFDX project", async () => {
    const { registrations, middleware, commands, messages, settle } = await activate({ typescript7: false });
    await settle();
    assert.deepEqual(registrations, []);
    assert.deepEqual(Object.keys(middleware), []);
    assert.deepEqual(Object.keys(commands).sort(), ["lwcBolts.applySettingsToProject", "lwcBolts.checkSetup", "lwcBolts.setUpProject"]);
    assert.deepEqual(messages, []);
  });

  it("says nothing outside an SFDX project, even with problems, until a command is run", async () => {
    const { messages, commands, settle } = await activate({
      trusted: false,
      typescriptVersion: "7.0.2",
      settings: { "contentMappers.enabled": { workspaceValue: false } },
    });
    await settle();
    assert.deepEqual(messages, []);
    await commands["lwcBolts.checkSetup"]();
    assert.deepEqual(
      messages.map((m) => [m.level, m.message]),
      [["error", "Lightning Bolts: open a folder with an sfdx-project.json first."]],
    );
  });

  it("passes the most specific settings as inferred-project options, including null", async () => {
    const { registrations } = await activate({
      settings: {
        apexNamespace: { globalValue: "Acme.Apex", workspaceValue: null },
        inaccessibleApexProperties: { globalValue: "include", workspaceFolderValue: "exclude" },
        disabledMetadataTypes: { globalValue: ["CustomPermission"] },
        respectForceIgnore: { workspaceValue: false },
      },
    });
    assert.deepEqual(registrations[0].contributions[0].inferredProjectContribution.options, {
      apexNamespace: null,
      inaccessibleApexProperties: "exclude",
      disabledMetadataTypes: ["CustomPermission"],
      respectForceIgnore: false,
      suppressDiagnosticsExtensions: HANDLED,
    });
  });

  it("suppresses diagnostics on every handled extension until suppressDiagnosticsExtensions is set", async () => {
    const setting = manifest.contributes.configuration.properties["lwcBolts.contentMapper.suppressDiagnosticsExtensions"];
    assert.deepEqual(setting.default, HANDLED);
    const { registrations, changeSettings } = await activate();
    assert.deepEqual(registrations[0].contributions[0].inferredProjectContribution.options, { suppressDiagnosticsExtensions: HANDLED });
    changeSettings({ suppressDiagnosticsExtensions: { globalValue: [] } });
    assert.deepEqual(registrations[1].contributions[0].inferredProjectContribution.options, { suppressDiagnosticsExtensions: [] });
    changeSettings({ suppressDiagnosticsExtensions: { workspaceValue: [".cls"] } });
    assert.deepEqual(registrations[2].contributions[0].inferredProjectContribution.options, { suppressDiagnosticsExtensions: [".cls"] });
  });

  it("leaves respectForceIgnore to the mapper's default, true, until it's set", async () => {
    const setting = manifest.contributes.configuration.properties["lwcBolts.contentMapper.respectForceIgnore"];
    assert.equal(setting.type, "boolean");
    assert.equal(setting.default, true);
    const { registrations, changeSettings } = await activate();
    assert.deepEqual(registrations[0].contributions[0].inferredProjectContribution.options, { suppressDiagnosticsExtensions: HANDLED });
    changeSettings({ respectForceIgnore: { globalValue: false } });
    assert.deepEqual(registrations[1].contributions[0].inferredProjectContribution.options, {
      respectForceIgnore: false,
      suppressDiagnosticsExtensions: HANDLED,
    });
  });

  it("runs the mapper with the node on the PATH when useVSCodeNode is off", async () => {
    const { registrations, changeSettings } = await activate({ settings: { useVSCodeNode: { globalValue: false } } });
    assert.deepEqual(registrations[0].contributions[0].inferredProjectContribution.manifest.exec, ["node", "./dist/server.js"]);
    changeSettings({ useVSCodeNode: { globalValue: true } });
    assert.deepEqual(registrations[1].contributions[0].inferredProjectContribution.manifest.exec, [process.execPath, "./dist/server.js"]);
  });

  it("re-registers when the settings change", async () => {
    const { registrations, changeSettings } = await activate();
    changeSettings({ apexNamespace: { workspaceValue: "Org" } }, "editor");
    assert.equal(registrations.length, 1, "unrelated settings don't re-register");
    changeSettings({ apexNamespace: { workspaceValue: "Org" } });
    assert.equal(registrations.length, 2);
    assert.equal(registrations[0].disposed, true);
    assert.deepEqual(registrations[1].contributions[0].inferredProjectContribution.options, {
      apexNamespace: "Org",
      suppressDiagnosticsExtensions: HANDLED,
    });
  });
});

describe("hostNodeExec", () => {
  let hostNodeExec;
  before(async () => {
    ({ hostNodeExec } = (await activate()).extension);
  });
  const exec = ["node", "./dist/server.js"];
  const vscodeHost = {
    execPath: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    versions: { node: "24.21.0", electron: "43.7.3" },
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };

  it("uses VS Code's Electron as Node.js when the extension host runs as Node.js", () => {
    assert.deepEqual(hostNodeExec(exec, ">=22.18", vscodeHost), [vscodeHost.execPath, "./dist/server.js"]);
  });

  it("keeps node when Electron wouldn't run as Node.js", () => {
    // the mapper inherits the server's environment, which is copied from the extension host's
    assert.deepEqual(hostNodeExec(exec, ">=22.18", { ...vscodeHost, env: {} }), exec);
  });

  it("uses a plain Node.js host, such as a remote extension host, as is", () => {
    const remote = { execPath: "/home/me/.vscode-server/bin/abc/node", versions: { node: "22.18.0" }, env: {} };
    assert.deepEqual(hostNodeExec(exec, ">=22.18", remote), [remote.execPath, "./dist/server.js"]);
  });

  it("keeps node when the host's Node.js is older than the mapper supports", () => {
    for (const node of ["22.17.9", "20.19.0", "18.17.1"]) {
      assert.deepEqual(hostNodeExec(exec, ">=22.18", { ...vscodeHost, versions: { node, electron: "37.0.0" } }), exec, node);
    }
  });

  it("only understands >= ranges, and keeps node for anything else", () => {
    assert.deepEqual(hostNodeExec(exec, ">=24", vscodeHost)[0], vscodeHost.execPath);
    assert.deepEqual(hostNodeExec(exec, ">= 24.21.0", vscodeHost)[0], vscodeHost.execPath);
    assert.deepEqual(hostNodeExec(exec, ">=24.21.1", vscodeHost), exec);
    for (const range of [undefined, "^22.18.0", ">=22 <25", "*"]) {
      assert.deepEqual(hostNodeExec(exec, range, vscodeHost), exec, String(range));
    }
  });

  it("leaves an exec that doesn't run node alone", () => {
    assert.deepEqual(hostNodeExec(["./bin/mapper"], ">=22.18", vscodeHost), ["./bin/mapper"]);
  });

  it("supports the mapper's engines.node", () => {
    const { engines } = require("@lwc-bolts/typescript-content-mapper/package.json");
    assert.deepEqual(hostNodeExec(exec, engines.node, vscodeHost)[0], vscodeHost.execPath);
  });
});

const mapperDir = path.dirname(require.resolve("@lwc-bolts/typescript-content-mapper/package.json"));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
// an empty PATH, so the machine's own tsc doesn't count
process.env.PATH = mkdtempSync(path.join(tmpdir(), "lwc-bolts-setup-bin-"));
tempDirs.push(process.env.PATH);

/**
 * An SFDX project in a temp dir with a `force-app` package directory. `installed` links the mapper and
 * TypeScript 7.1 into its node_modules, as `npm install` would, with the Lightning types, and `typescript`
 * only TypeScript.
 */
function sfdxProject({ installed = false, typescript = installed } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lwc-bolts-setup-")));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
  mkdirSync(path.join(dir, "force-app/main/default/lwc"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules/@lwc-bolts"), { recursive: true });
  if (installed) {
    symlinkSync(mapperDir, path.join(dir, "node_modules/@lwc-bolts/typescript-content-mapper"), "dir");
    mkdirSync(path.join(dir, "node_modules/@salesforce/lightning-types"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules/@salesforce/lightning-types/package.json"), JSON.stringify({ version: "0.10.1" }));
  }
  if (typescript) {
    symlinkSync(path.dirname(require.resolve("typescript/package.json")), path.join(dir, "node_modules/typescript"), "dir");
  }
  return dir;
}

/**
 * A stand-in for @lwc-bolts/project-setup: its constants and helpers, with the functions that plan and
 * write configs replaced by `overrides` (by default, a project with nothing planned), and each call to them
 * recorded. What those plans hold is project-setup's to test; these tests check what the extension does
 * with them.
 */
function fakeProjectSetup(overrides = {}) {
  const calls = [];
  const fakes = {
    planSetup: () => ({ error: "nothing planned" }),
    applySetup: () => ({ written: [], removed: [] }),
    planMaintenance: () => [],
    writeFiles: () => {},
    findProjectConfig: () => undefined,
    setContentMapperOptions: (text) => text,
    ...overrides,
  };
  const spied = Object.fromEntries(
    Object.entries(fakes).map(([name, fake]) => [name, (...args) => (calls.push([name, ...args]), fake(...args))]),
  );
  return {
    projectSetup: { ...realProjectSetup, ...spied },
    /** The arguments of each call to the fake `name`. */
    called: (name) => calls.filter(([called]) => called === name).map(([, ...args]) => args),
  };
}

/** A file URI, as vscode.Uri.file makes one. */
const fileUri = (fsPath, fragment = "") => ({
  scheme: "file",
  fsPath,
  fragment,
  with: (change) => fileUri(fsPath, change.fragment ?? fragment),
});

const PROJECT_CONFIG = "force-app/main/default/lwc/jsconfig.json";
/** A setup plan for `dir`, as planSetup returns one, that changes nothing unless `fields` say so. */
const setupPlan = (dir, fields = {}) => ({
  root: dir,
  file: "jsconfig.json",
  projectConfig: { path: path.join(dir, PROJECT_CONFIG), text: "{}" },
  projectConfigChange: "unchanged",
  writes: [],
  removals: [],
  shadowing: [],
  invalid: [],
  ...fields,
});
/** A project config, as findProjectConfig finds one. */
const foundConfig = (dir, text = "{}") => ({
  folder: path.join(dir, "force-app/main/default/lwc"),
  path: path.join(dir, PROJECT_CONFIG),
  file: "jsconfig.json",
  text,
});
/** The workspace settings TypeScript 7 needs, as already turned on. */
const TS7_SETTINGS = {
  "experimental.useTsgo": { workspaceValue: true },
  "contentMappers.enabled": { workspaceValue: true },
};
/** The workspace settings setup turns on, as already set. */
const SET_UP_SETTINGS = {
  "experimental.useTsgo": { workspaceValue: true },
  "contentMappers.enabled": { workspaceValue: true },
  "tsdk.path": { workspaceValue: "node_modules/typescript" },
};

/** Answers the first message that offers `action` with it, and no other. */
const once = (action) => {
  let answered = false;
  return ({ actions }) => (!answered && actions.includes(action) ? ((answered = true), action) : undefined);
};
const warnings = (messages) => messages.filter((m) => m.level === "warning").map((m) => m.message);
/** Setup's summaries: information messages, apart from the startup check's offer to set a project up. */
const summaries = (messages) => messages.filter((m) => m.level === "information" && !m.actions.includes("Set Up Project"));
const summaryOf = (messages) => summaries(messages)[0];
/** The messages the extension shows on its own, warnings and offers alike. */
const notices = (messages) => messages.filter((m) => m.level !== "error").map((m) => m.message);

describe("project setup", () => {
  it("applies project-setup's plan, turns on the settings it needs, and offers to install the packages", async () => {
    const dir = sfdxProject({ typescript: true });
    const common = path.join(dir, "common/main/default/lwc/jsconfig.json");
    const plan = setupPlan(dir, {
      projectConfigChange: "created",
      writes: [{ path: common, text: "{}" }],
    });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => plan, applySetup: () => ({ written: [common], removed: [] }) });
    const { commands, messages, settings, installs, executed } = await activate({
      folders: [dir],
      projectSetup,
      answer: once("Install Packages"),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.deepEqual(called("planSetup")[0], [dir, {}]);
    assert.deepEqual(called("applySetup")[0], [plan]);
    assert.ok(!messages.some((m) => m.actions.includes("Replace")), "nothing to replace, so nothing to ask");
    assert.equal(settings["contentMappers.enabled"].workspaceValue, true);
    assert.equal(settings["experimental.useTsgo"].workspaceValue, true);
    assert.equal(settings["tsdk.path"], undefined, "only set when the user agrees");
    const summary = summaryOf(messages);
    assert.match(
      summary.message,
      /^Lightning Bolts: created force-app\/main\/default\/lwc\/jsconfig\.json; wrote common\/main\/default\/lwc\/jsconfig\.json; set js\/ts\./,
    );
    assert.match(summary.message, /It still needs @lwc-bolts\/typescript-content-mapper installed\./);
    assert.doesNotMatch(summary.message, /✅/, "only celebrated when nothing's left to do");
    assert.match(summary.message, /@salesforce\/lightning-types is recommended\./);
    assert.deepEqual(summary.actions, ["Use Project TypeScript", "Install Packages", "Restart TypeScript", "Learn More"]);
    assert.deepEqual(installs, [
      { commandLine: "npm install --save-dev @lwc-bolts/typescript-content-mapper @salesforce/lightning-types", cwd: dir },
    ]);
    // once they're installed, it sets the project up again with them, and restarts TypeScript
    assert.equal(called("planSetup").length, 2);
    const again = summaries(messages)[1];
    assert.match(
      again.message,
      /^Lightning Bolts: installed @lwc-bolts\/typescript-content-mapper and @salesforce\/lightning-types; created /,
    );
    assert.match(again.message, /; restarted TypeScript\./);
    assert.ok(!again.actions.includes("Restart TypeScript"));
    assert.deepEqual(executed, [["typescript.native-preview.restart"]]);
  });

  it("asks before turning on the workspace settings, naming the ones it changes", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    let writtenBeforeAnswer;
    const { commands, messages, settings } = await activate({
      folders: [dir],
      projectSetup,
      settings: { "contentMappers.enabled": { workspaceValue: true } },
      answer: (entry) => {
        if (entry.actions.includes("Turn On Settings")) {
          writtenBeforeAnswer = { applied: called("applySetup").length, useTsgo: settings["experimental.useTsgo"] };
        }
      },
    });
    await commands["lwcBolts.setUpProject"]();
    assert.deepEqual(writtenBeforeAnswer, { applied: 0, useTsgo: undefined }, "asked before changing anything");
    const question = messages.find((m) => m.actions.includes("Turn On Settings"));
    assert.equal(question.level, "warning");
    assert.equal(question.modal, undefined, "a toast, not a modal");
    assert.match(question.message, /needs TypeScript 7 turned on for this workspace \(js\/ts\.experimental\.useTsgo\)/);
    assert.doesNotMatch(question.message, /contentMappers\.enabled/, "only the settings that change");
    assert.deepEqual(question.actions, ["Turn On Settings", "Learn More"]);
    assert.equal(settings["experimental.useTsgo"].workspaceValue, true);
    assert.equal(called("applySetup").length, 1);
  });

  it("stops setup, changing nothing, when the user doesn't turn on the workspace settings", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    const { commands, messages, settings } = await activate({ folders: [dir], projectSetup, approveSettings: false });
    await commands["lwcBolts.setUpProject"]();
    assert.ok(messages.some((m) => m.actions.includes("Turn On Settings")));
    assert.equal(settings["experimental.useTsgo"], undefined);
    assert.equal(settings["contentMappers.enabled"], undefined);
    assert.deepEqual(called("applySetup"), [], "nothing written");
    assert.equal(summaryOf(messages), undefined, "no summary");
  });

  it("doesn't ask about the workspace settings when they're already on", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    const { commands, messages } = await activate({ folders: [dir], projectSetup, settings: { ...SET_UP_SETTINGS } });
    await commands["lwcBolts.setUpProject"]();
    assert.ok(!messages.some((m) => m.actions.includes("Turn On Settings")));
    assert.ok(summaryOf(messages));
  });

  it("checks the TypeScript the editor runs before writing anything, and stops when it can't run the mapper", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    const { commands, messages, settings, executed } = await activate({
      folders: [dir],
      projectSetup,
      startedTypeScriptVersion: "7.0.2",
      answer: once("Select Version"),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(settings["experimental.useTsgo"].workspaceValue, true, "turned on, which starts the server");
    assert.deepEqual(called("applySetup"), [], "nothing written");
    assert.deepEqual(
      messages.filter((m) => /TypeScript 7\.0\.2/.test(m.message)).map((m) => [m.message, m.actions]),
      [
        [
          "Lightning Bolts: the editor is running TypeScript 7.0.2, which is too old (7.1 or later needed). Switch to the project's TypeScript (node_modules/typescript)?",
          ["Use Project TypeScript", "Select Version", "Learn More"],
        ],
      ],
      "only the question, not the startup warning too",
    );
    assert.deepEqual(executed, [["typescript.native-preview.selectVersion"]]);
    assert.ok(
      messages.filter((m) => /TypeScript 7\.0\.2/.test(m.message)).every((m) => !m.modal),
      "a toast, not a modal",
    );
  });

  it("carries on setting up with the project's TypeScript when the editor's can't run the mapper", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    let writtenBeforeAnswer;
    const { commands, messages, settings, executed } = await activate({
      folders: [dir],
      projectSetup,
      startedTypeScriptVersion: "7.0.2",
      answer: (entry) => {
        if (entry.actions.includes("Use Project TypeScript") && writtenBeforeAnswer === undefined) {
          writtenBeforeAnswer = called("applySetup").length;
          return "Use Project TypeScript";
        }
      },
    });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(writtenBeforeAnswer, 0, "asked before writing");
    assert.equal(settings["tsdk.path"].workspaceValue, "node_modules/typescript");
    assert.deepEqual(executed, [["typescript.native-preview.restart"]]);
    assert.equal(called("applySetup").length, 1);
    const summary = summaryOf(messages);
    assert.match(
      summary.message,
      /^Lightning Bolts: set js\/ts\.tsdk\.path to node_modules\/typescript; created force-app\/main\/default\/lwc\/jsconfig\.json; .*; restarted TypeScript\./,
    );
    assert.ok(!summary.actions.includes("Use Project TypeScript") && !summary.actions.includes("Restart TypeScript"));
  });

  it("opens the setup guide at the section a message is about, and asks a question again after", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    let asked = 0;
    const { commands, executed } = await activate({
      folders: [dir],
      projectSetup,
      startedTypeScriptVersion: "7.0.2",
      // Learn More the first time the editor's TypeScript is asked about, then stop
      answer: ({ message }) => (/the editor is running/.test(message) && asked++ === 0 ? "Learn More" : undefined),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(asked, 2, "asked again after Learn More");
    const previews = executed.filter(([id]) => id === "markdown.showPreview").map(([, uri]) => [uri.fsPath, uri.fragment]);
    assert.deepEqual(previews, [[path.join(extensionDir, "docs/setup.md"), "editor-typescript"]]);
    assert.ok(existsSync(previews[0][0]), "the guide the extension ships");
    assert.deepEqual(called("applySetup"), [], "reading the guide didn't answer the question");
  });

  it("asks the workspace settings question again after Learn More, without turning them on", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    let asked = 0;
    const { commands, settings } = await activate({
      folders: [dir],
      projectSetup,
      approveSettings: false,
      answer: ({ actions }) => (actions.includes("Turn On Settings") && asked++ === 0 ? "Learn More" : undefined),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(asked, 2, "asked again after Learn More");
    assert.equal(settings["experimental.useTsgo"], undefined);
    assert.deepEqual(called("applySetup"), []);
  });

  it("sets a project up with the real project-setup", async () => {
    // the one setup test that runs project-setup, to check the extension loads and calls it as it is
    const dir = sfdxProject({ installed: true });
    const { commands, messages } = await activate({ folders: [dir] });
    await commands["lwcBolts.setUpProject"]();
    const config = realProjectSetup.findProjectConfig(dir, realProjectSetup.readPackageDirectories(dir) ?? []);
    assert.equal(config?.path, path.join(dir, PROJECT_CONFIG));
    assert.ok(realProjectSetup.registersContentMapper(config.text));
    assert.match(summaryOf(messages).message, /^Lightning Bolts: created force-app\/main\/default\/lwc\/jsconfig\.json; /);
  });

  it("explains a project it can't set up", async () => {
    const dir = sfdxProject();
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => ({ error: "the project has no packageDirectories." }) });
    const { commands, messages } = await activate({ folders: [dir], projectSetup });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(messages.find((m) => m.level === "error").message, "Lightning Bolts: the project has no packageDirectories.");
    assert.deepEqual(called("applySetup"), []);
  });

  it("offers to install the packages a project needs before it can be set up", async () => {
    const dir = sfdxProject();
    const { commands, messages, installs } = await activate({ folders: [dir], answer: once("Install Packages") });
    await commands["lwcBolts.setUpProject"]();
    const { message, actions } = messages.find((m) => m.level === "error");
    assert.match(
      message,
      /^Lightning Bolts: the content mapper needs TypeScript 7\.1 or later, but it isn't installed in the project or globally\./,
    );
    assert.deepEqual(actions, ["Install Packages", "Learn More"]);
    // the recommended packages go in the same install
    assert.deepEqual(installs, [
      {
        commandLine: "npm install --save-dev @lwc-bolts/typescript-content-mapper typescript@7.1.0-beta @salesforce/lightning-types",
        cwd: dir,
      },
    ]);
    assert.equal(realProjectSetup.findProjectConfig(dir), undefined, "nothing is written");
  });

  it("offers the required and recommended packages in one menu, all checked", async () => {
    const dir = sfdxProject();
    const { commands, menus } = await activate({ folders: [dir], answer: once("Install Packages") });
    await commands["lwcBolts.setUpProject"]();
    assert.deepEqual(
      menus[0].map(({ label, description, picked }) => [label, description, picked]),
      [
        ["@lwc-bolts/typescript-content-mapper", "required", true],
        ["typescript@7.1.0-beta", "required", true],
        ["@salesforce/lightning-types", "recommended", true],
      ],
    );
    assert.ok(
      menus[0].every((item) => item.detail.length > 0),
      "each says what it's for",
    );
  });

  it("installs only what's left checked, and remembers the recommended packages left unchecked", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup } = fakeProjectSetup({ planSetup: () => setupPlan(dir) });
    const { commands, messages, installs, menus, context } = await activate({
      folders: [dir],
      projectSetup,
      answer: once("Install Packages"),
      pickPackages: (items) => items.filter((item) => item.description === "required"),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.deepEqual(
      installs.map((i) => i.commandLine),
      ["npm install --save-dev @lwc-bolts/typescript-content-mapper"],
    );
    assert.deepEqual(context.workspaceState.get("lwcBolts.declinedPackages"), ["@salesforce/lightning-types"]);
    // setup no longer suggests it, and the menu leaves it unchecked
    const again = summaries(messages).at(-1);
    assert.doesNotMatch(again.message, /lightning-types/);
    const next = await activate({ folders: [dir], projectSetup, workspaceState: context.workspaceState, answer: once("Install Packages") });
    await next.commands["lwcBolts.setUpProject"]();
    assert.deepEqual(
      next.menus[0].map(({ label, picked }) => [label, picked]),
      [
        ["@lwc-bolts/typescript-content-mapper", true],
        ["@salesforce/lightning-types", false],
      ],
    );
    assert.equal(menus.length, 1);
  });

  it("installs nothing when the menu is dismissed", async () => {
    const dir = sfdxProject();
    const { commands, installs } = await activate({ folders: [dir], answer: once("Install Packages"), pickPackages: () => undefined });
    await commands["lwcBolts.setUpProject"]();
    assert.deepEqual(installs, []);
  });

  it("carries on setting up once the packages it needed first are installed", async () => {
    const dir = sfdxProject({ installed: true });
    let installed = false;
    const { projectSetup, called } = fakeProjectSetup({
      planSetup: () =>
        installed
          ? setupPlan(dir, { projectConfigChange: "created" })
          : { error: "it needs TypeScript 7.1.", missing: ["typescript@7.1.0-beta"] },
    });
    const { commands, messages, executed } = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...SET_UP_SETTINGS },
      answer: ({ actions }) => (actions.includes("Install Packages") ? ((installed = true), "Install Packages") : undefined),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(called("applySetup").length, 1);
    assert.deepEqual(summaryOf(messages), {
      level: "information",
      message: `Lightning Bolts: ✅ finished setting up ${path.basename(dir)}, LWCs are now bolted to your other Metadata!`,
      actions: ["Learn More"],
    });
    assert.deepEqual(executed, [["typescript.native-preview.restart"]]);
  });

  it("explains a failed install, and doesn't carry on", async () => {
    const dir = sfdxProject();
    const { projectSetup, called } = fakeProjectSetup({
      planSetup: () => ({ error: "it needs TypeScript 7.1.", missing: ["typescript@7.1.0-beta"] }),
    });
    const { commands, messages } = await activate({ folders: [dir], projectSetup, installExitCode: 1, answer: once("Install Packages") });
    await commands["lwcBolts.setUpProject"]();
    assert.equal(called("planSetup").length, 1);
    assert.equal(messages.at(-1).message, "Lightning Bolts: npm install failed (exit code 1); its terminal shows why.");
  });

  it("checks the node on the PATH when it sets a project up", async () => {
    const dir = sfdxProject({ installed: true });
    const { projectSetup } = fakeProjectSetup({ planSetup: () => setupPlan(dir) });
    const { commands, messages, settle } = await activate({ folders: [dir], projectSetup, nodeVersion: null });
    await settle();
    assert.ok(!warnings(messages).some((m) => /node on your PATH/.test(m)), "not at startup: the project has no config yet");
    await commands["lwcBolts.setUpProject"]();
    await settle();
    assert.ok(warnings(messages).some((m) => /on your PATH \(none found\)/.test(m)));
  });

  it("checks the TypeScript js/ts.tsdk.path names ahead of the project's", async () => {
    const old = path.join(sfdxProject(), "typescript");
    mkdirSync(old);
    writeFileSync(path.join(old, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
    const dir = sfdxProject({ installed: true });
    const { commands, messages, settings } = await activate({
      folders: [dir],
      settings: { "tsdk.path": { globalValue: old } },
    });
    await commands["lwcBolts.setUpProject"]();
    const { message, actions } = messages.find((m) => m.level === "error");
    assert.match(message, /5\.9\.3\. Use a newer one/);
    assert.deepEqual(actions, ["Learn More"], "installing TypeScript in the project wouldn't change which one is used");
    assert.equal(settings["tsdk.path"].workspaceValue, undefined);
    assert.equal(realProjectSetup.findProjectConfig(dir), undefined, "nothing is written");
  });

  it("names the tsc js/ts.tsdk.path points at, but doesn't run it in an untrusted workspace", async () => {
    const dir = sfdxProject();
    const tsc = path.join(dir, "tsc");
    const ran = path.join(dir, "ran");
    writeFileSync(tsc, `#!/bin/sh\necho ran > "${ran}"\necho "Version 5.9.3"\n`, { mode: 0o755 });
    const settings = { "tsdk.path": { workspaceValue: "tsc" } };
    const untrusted = await activate({ folders: [dir], settings, trusted: false });
    await untrusted.commands["lwcBolts.setUpProject"]();
    assert.equal(existsSync(ran), false);
    assert.ok(!summaryOf(untrusted.messages)?.actions.includes("Use Project TypeScript"));
    const trusted = await activate({ folders: [dir], settings });
    await trusted.commands["lwcBolts.setUpProject"]();
    assert.ok(existsSync(ran));
    assert.ok(trusted.messages.find((m) => m.level === "error").message.includes(`${tsc} is 5.9.3`));
  });

  it("sets up a project that only js/ts.tsdk.path has TypeScript for, keeping the setting", async () => {
    const dir = sfdxProject();
    const typescript = path.dirname(require.resolve("typescript/package.json"));
    const { commands, messages, settings } = await activate({
      folders: [dir],
      settings: { "tsdk.path": { workspaceValue: typescript } },
    });
    await commands["lwcBolts.setUpProject"]();
    assert.ok(realProjectSetup.findProjectConfig(dir));
    assert.equal(settings["tsdk.path"].workspaceValue, typescript);
    assert.doesNotMatch(summaryOf(messages).message, /typescript@/);
  });

  it("offers to set js/ts.tsdk.path to the project's TypeScript, and restarts TypeScript with it", async () => {
    const dir = sfdxProject({ installed: true });
    const { commands, messages, settings, executed } = await activate({
      folders: [dir],
      answer: ({ actions }) => (actions.includes("Use Project TypeScript") ? "Use Project TypeScript" : undefined),
    });
    await commands["lwcBolts.setUpProject"]();
    assert.match(summaryOf(messages).message, /Switch to the project's TypeScript \(node_modules\/typescript\)\?/);
    assert.equal(settings["tsdk.path"].workspaceValue, "node_modules/typescript");
    assert.deepEqual(executed, [["typescript.native-preview.restart"]]);
  });

  it("doesn't offer js/ts.tsdk.path to a project that relies on the global tsc", async () => {
    const dir = sfdxProject();
    writeFileSync(path.join(process.env.PATH, "tsc"), `#!/bin/sh\necho "Version 7.1.0"\n`, { mode: 0o755 });
    try {
      const { commands, messages, settings } = await activate({ folders: [dir] });
      await commands["lwcBolts.setUpProject"]();
      assert.ok(realProjectSetup.findProjectConfig(dir));
      assert.equal(settings["tsdk.path"], undefined);
      assert.ok(!summaryOf(messages).actions.includes("Use Project TypeScript"));
    } finally {
      rmSync(path.join(process.env.PATH, "tsc"));
    }
  });

  it("celebrates a finished setup, without listing its steps, or says the project was already set up", async () => {
    const dir = sfdxProject({ installed: true });
    const ready = `✅ finished setting up ${path.basename(dir)}, LWCs are now bolted to your other Metadata!`;
    const cases = [
      [{ projectConfigChange: "updated" }, ready],
      [{ projectConfigChange: "moved", movedFrom: path.join(dir, "force-app/main/default/lwc/tsconfig.json") }, ready],
      [{}, `✅ nothing to do: ${path.basename(dir)} is already set up.`],
    ];
    for (const [fields, summary] of cases) {
      const { projectSetup } = fakeProjectSetup({ planSetup: () => setupPlan(dir, fields) });
      const { commands, messages } = await activate({ folders: [dir], projectSetup, settings: { ...SET_UP_SETTINGS } });
      await commands["lwcBolts.setUpProject"]();
      // installed, so nothing to install; with nothing changed, nothing to restart TypeScript for
      assert.deepEqual(summaryOf(messages), {
        level: "information",
        message: `Lightning Bolts: ${summary}`,
        actions: Object.keys(fields).length > 0 ? ["Restart TypeScript", "Learn More"] : ["Learn More"],
      });
    }
  });

  it("lists how the project config changed when something's left to do", async () => {
    const dir = sfdxProject({ installed: true });
    const cases = [
      [{ projectConfigChange: "updated" }, "updated force-app/main/default/lwc/jsconfig.json"],
      [
        { projectConfigChange: "moved", movedFrom: path.join(dir, "force-app/main/default/lwc/tsconfig.json") },
        "moved force-app/main/default/lwc/tsconfig.json to force-app/main/default/lwc/jsconfig.json",
      ],
    ];
    for (const [fields, step] of cases) {
      const { projectSetup } = fakeProjectSetup({
        planSetup: () => setupPlan(dir, fields),
        missingPackages: () => ["@lwc-bolts/typescript-content-mapper"],
      });
      const { commands, messages } = await activate({ folders: [dir], projectSetup, settings: { ...SET_UP_SETTINGS } });
      await commands["lwcBolts.setUpProject"]();
      assert.equal(summaryOf(messages).message, `Lightning Bolts: ${step}. It still needs @lwc-bolts/typescript-content-mapper installed.`);
    }
  });

  it("explains what it removed, what shadows the jsconfig.json files and what isn't valid JSON", async () => {
    const dir = sfdxProject();
    const removed = path.join(dir, "extra/main/default/lwc/tsconfig.json");
    const plan = setupPlan(dir, {
      removals: [removed],
      shadowing: [path.join(dir, "common/main/default/lwc/tsconfig.json")],
      invalid: [path.join(dir, "sales/main/default/lwc/jsconfig.json")],
    });
    const { projectSetup } = fakeProjectSetup({ planSetup: () => plan, applySetup: () => ({ written: [], removed: [removed] }) });
    const { commands, messages } = await activate({ folders: [dir], projectSetup });
    await commands["lwcBolts.setUpProject"]();
    const summary = summaryOf(messages).message;
    assert.match(summary, /removed extra\/main\/default\/lwc\/tsconfig\.json/);
    assert.match(summary, /sales\/main\/default\/lwc\/jsconfig\.json isn't valid JSON, so it wasn't changed/);
    assert.match(summary, /TypeScript uses common\/main\/default\/lwc\/tsconfig\.json instead of the jsconfig\.json: remove it/);
  });

  it("warns about a jsconfig.json project config with comments, which the Salesforce extensions can't read", async () => {
    const dir = sfdxProject();
    const withComments = { path: path.join(dir, PROJECT_CONFIG), text: "// mine\n{}" };
    for (const [file, warned] of [
      ["jsconfig.json", true],
      ["tsconfig.json", false],
    ]) {
      const { projectSetup } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { file, projectConfig: withComments }) });
      const { commands, messages } = await activate({ folders: [dir], projectSetup });
      await commands["lwcBolts.setUpProject"]();
      assert.equal(/Comments or trailing commas in/.test(summaryOf(messages).message), warned, file);
    }
  });
});

describe("keeping the lwc folders' configs in shape", () => {
  it("writes what project-setup plans to restore, at startup and whenever a config changes", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, "common/main/default/lwc/jsconfig.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "merged");
    const { projectSetup, called } = fakeProjectSetup({ planMaintenance: () => [{ path: file, text: "restored" }] });
    const { changeFiles, messages } = await activate({ folders: [dir], projectSetup });
    assert.deepEqual(called("planMaintenance")[0], [dir]);
    assert.equal(readFileSync(file, "utf8"), "restored", "at startup");
    writeFileSync(file, "merged");
    await changeFiles("jsconfig.json");
    assert.equal(readFileSync(file, "utf8"), "restored", "when it changes");
    // something that keeps rewriting it wins after a few rounds, with a warning
    for (let i = 0; i < 6; i++) {
      writeFileSync(file, "merged");
      await changeFiles("jsconfig.json");
    }
    assert.equal(readFileSync(file, "utf8"), "merged");
    assert.ok(warnings(messages).some((m) => /something keeps rewriting common\/main\/default\/lwc\/jsconfig\.json/.test(m)));
  });

  it("never changes a config when maintainLwcConfigs is off, and reminds once, until Don't Remind Me", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    const typings = path.join(dir, ".sfdx/typings/lwc/lightning.d.ts");
    writeFileSync(file, "merged");
    const { projectSetup } = fakeProjectSetup({
      findProjectConfig: () => foundConfig(dir),
      planMaintenance: () => [
        { path: file, text: "restored" },
        { path: typings, text: "typings" },
      ],
    });
    const off = { maintainLwcConfigs: { workspaceValue: false } };
    const first = await activate({ folders: [dir], projectSetup, settings: { ...off }, answer: once("Don't Remind Me") });
    await first.changeFiles("jsconfig.json");
    assert.equal(readFileSync(file, "utf8"), "merged", "left alone");
    assert.equal(readFileSync(typings, "utf8"), "typings", "not a config, so still written");
    const reminders = first.messages.filter((m) => /an update is needed for/.test(m.message));
    assert.deepEqual(
      reminders.map((m) => [m.message, m.actions]),
      [
        [
          "Lightning Bolts: an update is needed for force-app/main/default/lwc/jsconfig.json. lwcBolts.maintainLwcConfigs is off, so the extension doesn't change jsconfig.json or tsconfig.json files.",
          ["Turn On", "Learn More", "Don't Remind Me"],
        ],
      ],
      "once, though the file changed",
    );
    assert.equal(first.context.workspaceState.get("lwcBolts.configRemindersOff"), true);

    // the next session stays quiet, until the check, which reports it and turns the reminders back on
    const second = await activate({ folders: [dir], projectSetup, settings: { ...off }, workspaceState: first.context.workspaceState });
    await second.settle();
    assert.ok(!second.messages.some((m) => /an update is needed for/.test(m.message)));
    await second.commands["lwcBolts.checkSetup"]();
    assert.ok(second.messages.some((m) => /an update is needed for .*jsconfig\.json/.test(m.message)));
    assert.equal(second.context.workspaceState.get("lwcBolts.configRemindersOff"), undefined);
  });

  it("restores the configs once the reminder's Turn On turns maintainLwcConfigs on", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    writeFileSync(file, "merged");
    const { projectSetup } = fakeProjectSetup({ planMaintenance: () => [{ path: file, text: "restored" }] });
    const { settings, settle } = await activate({
      folders: [dir],
      projectSetup,
      settings: { maintainLwcConfigs: { workspaceValue: false } },
      answer: once("Turn On"),
    });
    await settle();
    assert.equal(settings.maintainLwcConfigs.workspaceValue, true);
    assert.equal(readFileSync(file, "utf8"), "restored");
  });

  it("asks before setup changes a config while maintainLwcConfigs is off, and leaves them alone otherwise", async () => {
    const dir = sfdxProject({ typescript: true });
    const common = path.join(dir, "common/main/default/lwc/jsconfig.json");
    const typings = path.join(dir, ".sfdx/typings/lwc/lightning.d.ts");
    const plan = setupPlan(dir, {
      projectConfigChange: "created",
      writes: [
        { path: common, text: "{}" },
        { path: typings, text: "typings" },
      ],
    });
    for (const [answer, applied] of [
      [undefined, { ...plan, projectConfigChange: "unchanged", writes: [{ path: typings, text: "typings" }], removals: [] }],
      ["Turn On and Continue", plan],
    ]) {
      const { projectSetup, called } = fakeProjectSetup({ planSetup: () => plan });
      const { commands, messages, settings } = await activate({
        folders: [dir],
        projectSetup,
        settings: { ...SET_UP_SETTINGS, maintainLwcConfigs: { workspaceValue: false } },
        answer: ({ actions }) => actions.find((action) => action === answer),
      });
      await commands["lwcBolts.setUpProject"]();
      const question = messages.find((m) => m.actions.includes("Turn On and Continue"));
      assert.equal(
        question.message,
        `Lightning Bolts: setting up ${path.basename(dir)} wants to change force-app/main/default/lwc/jsconfig.json, common/main/default/lwc/jsconfig.json. lwcBolts.maintainLwcConfigs is off, so the extension doesn't change jsconfig.json or tsconfig.json files. Turn it on?`,
      );
      assert.deepEqual(called("applySetup"), [[applied]], String(answer));
      assert.equal(settings.maintainLwcConfigs.workspaceValue, answer !== undefined);
      const summary = summaryOf(messages).message;
      assert.equal(/left .* unchanged \(lwcBolts\.maintainLwcConfigs is off\)/.test(summary), answer === undefined, summary);
    }
  });

  it("doesn't apply the settings to the project config while maintainLwcConfigs is off, unless turned on", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    for (const [answer, expected] of [
      [undefined, "old"],
      ["Turn On and Apply", "new"],
    ]) {
      writeFileSync(file, "old");
      const { projectSetup } = fakeProjectSetup({
        findProjectConfig: () => foundConfig(dir, readFileSync(file, "utf8")),
        setContentMapperOptions: () => "new",
      });
      const { commands, messages } = await activate({
        folders: [dir],
        projectSetup,
        settings: { maintainLwcConfigs: { workspaceValue: false } },
        answer: ({ actions }) => actions.find((action) => action === answer),
      });
      await commands["lwcBolts.applySettingsToProject"]();
      assert.ok(messages.some((m) => /applying your lwcBolts\.contentMapper settings would change/.test(m.message)));
      assert.equal(readFileSync(file, "utf8"), expected, String(answer));
    }
  });
});

describe("keeping include in step with sfdx-project.json", () => {
  it("checks the configs against their policies again when sfdx-project.json changes, without asking", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    let writes = [];
    const { projectSetup, called } = fakeProjectSetup({ planMaintenance: () => writes });
    const { messages, settle, changeSfdxProject } = await activate({ folders: [dir], projectSetup });
    await settle();
    const maintained = called("planMaintenance").length;
    // a new package directory, which the project config's policy enforces an include entry for
    writes = [{ path: file, text: "{}\n", changes: [`added "../../../../common" to include`] }];
    await changeSfdxProject();
    assert.ok(called("planMaintenance").length > maintained);
    assert.equal(readFileSync(file, "utf8"), "{}\n");
    assert.deepEqual(
      messages.filter((m) => /packageDirectories|include/.test(m.message)),
      [],
      "include is part of the policy, so there's nothing to ask",
    );
  });

  it("doesn't set up projects at startup, but suggests it", async () => {
    const dir = sfdxProject();
    const { projectSetup, called } = fakeProjectSetup();
    const { messages, settle } = await activate({ folders: [dir], projectSetup });
    await settle();
    assert.deepEqual(called("planSetup"), []);
    const suggestion = messages.find((m) => m.actions.includes("Set Up Project"));
    assert.match(suggestion.message, /isn't set up for the content mapper/);
    assert.deepEqual(suggestion.actions, ["Set Up Project", "Learn More", "Don't Ask Again"]);
  });
});

describe("startup prompts", () => {
  it("shows one problem as it is, with its fix", async () => {
    const { messages, settle } = await activate({ folders: [sfdxProject()], projectSetup: fakeProjectSetup().projectSetup });
    await settle();
    assert.equal(messages.length, 1);
    assert.match(messages[0].message, /isn't set up for the content mapper/);
    assert.deepEqual(messages[0].actions, ["Set Up Project", "Learn More", "Don't Ask Again"]);
  });

  it("combines several problems into one prompt whose Show Details lists each with its fix", async () => {
    const { messages, settle } = await activate({
      folders: [sfdxProject()],
      projectSetup: fakeProjectSetup().projectSetup,
      trusted: false,
      settings: { "contentMappers.enabled": { workspaceValue: false } },
      answer: once("Show Details"),
    });
    await settle();
    const [combined, ...details] = messages;
    assert.equal(
      combined.message,
      "Lightning Bolts: found 2 problems that stop the content mapper from declaring your @salesforce/... imports.",
    );
    assert.deepEqual(combined.actions, ["Show Details", "Learn More", "Don't Ask Again"]);
    assert.deepEqual(
      details.map((m) => m.actions),
      [
        ["Set Up Project", "Learn More"],
        ["Manage Workspace Trust", "Learn More"],
      ],
      "the workspace settings are setup's to ask about, for a project that isn't set up",
    );
  });
});

describe("TypeScript 7 extension", () => {
  it("offers setup at startup without TypeScript 7, rather than asking for TypeScript 7 itself", async () => {
    const dir = sfdxProject();
    const { messages, settle } = await activate({ folders: [dir], projectSetup: fakeProjectSetup().projectSetup, typescript7: false });
    await settle();
    assert.deepEqual(
      messages.map(({ message, actions }) => [message, actions]),
      [
        [
          `Lightning Bolts: the ${path.basename(dir)} project isn't set up for the content mapper, which declares your Apex, labels, schema and other metadata for LWC imports.`,
          ["Set Up Project", "Learn More", "Don't Ask Again"],
        ],
      ],
    );
  });

  it("offers setup to a configured project without TypeScript 7", async () => {
    const dir = sfdxProject({ installed: true });
    const { projectSetup } = fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) });
    const { messages, settle } = await activate({ folders: [dir], projectSetup, typescript7: false });
    await settle();
    assert.equal(messages.length, 1);
    assert.match(messages[0].message, /isn't fully set up for the content mapper: the TypeScript 7 extension isn't running\./);
    assert.deepEqual(messages[0].actions, ["Set Up Project", "Learn More", "Don't Ask Again"]);
  });

  it("starts setup by asking for TypeScript 7, and carries on once it's installed, without reloading", async () => {
    const dir = sfdxProject({ installed: true });
    const { projectSetup, called } = fakeProjectSetup({ planSetup: () => setupPlan(dir, { projectConfigChange: "created" }) });
    const { messages, registrations, middleware, executed, installTypeScript7, settle } = await activate({
      folders: [dir],
      projectSetup,
      typescript7: false,
      settings: { ...SET_UP_SETTINGS },
      answer: ({ actions }) => ["Set Up Project", "Show Extension"].find((action) => actions.includes(action)),
    });
    await settle();
    // Set Up Project, whose first step asks for TypeScript 7
    assert.deepEqual(called("planSetup"), [], "nothing is set up without TypeScript 7");
    const ask = messages.find((m) => /needs the TypeScript 7 extension/.test(m.message));
    assert.equal(
      ask.message,
      `Lightning Bolts: setting up ${path.basename(dir)} needs the TypeScript 7 extension. Install it to continue.`,
    );
    assert.deepEqual(ask.actions, ["Show Extension", "Learn More"]);
    assert.deepEqual(executed, [["extension.open", "TypeScriptTeam.native-preview"]]);
    const before = messages.length;

    await installTypeScript7();
    assert.equal(registrations.length, 1, "the content mapper");
    assert.equal(Object.keys(middleware).length, 3, "the auto-import rewrites");
    assert.deepEqual(called("planSetup"), [[dir, { typescriptPath: "node_modules/typescript" }]], "setup carried on");
    assert.deepEqual(called("planMaintenance")[0], [dir], "the lwc folders' configs are kept");
    const after = messages.slice(before);
    assert.deepEqual(
      after.map((m) => m.message),
      [`Lightning Bolts: ✅ finished setting up ${path.basename(dir)}, LWCs are now bolted to your other Metadata!`],
      "the summary, and no other suggestion",
    );
    assert.ok(!messages.some((m) => /reload/i.test(m.message)));
    // later changes to the extensions don't set it up again
    await installTypeScript7();
    assert.equal(registrations.length, 1);
    assert.equal(called("planSetup").length, 1);
  });

  it("starts working when TypeScript 7 is installed without setup asking for it", async () => {
    const dir = sfdxProject();
    const { projectSetup, called } = fakeProjectSetup();
    const { messages, registrations, installTypeScript7, settle } = await activate({ folders: [dir], projectSetup, typescript7: false });
    await settle();
    await installTypeScript7();
    assert.equal(registrations.length, 1);
    assert.deepEqual(called("planMaintenance")[0], [dir]);
    assert.deepEqual(called("planSetup"), []);
    assert.equal(messages.length, 1, "the setup suggestion isn't repeated this session");
  });

  it("explains that TypeScript 7 failed to start, once installed, when setup runs", async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { messages, registrations, commands, installTypeScript7, settle } = await activate({
        folders: [sfdxProject()],
        projectSetup: fakeProjectSetup().projectSetup,
        typescript7: false,
        typescript7Error: new Error("boom"),
      });
      await settle();
      await installTypeScript7();
      assert.deepEqual(registrations, []);
      assert.ok(!messages.some((m) => /TypeScript 7 extension/.test(m.message)), "not outside setup");
      await commands["lwcBolts.setUpProject"]();
      assert.match(messages.at(-1).message, /the TypeScript 7 extension failed to start \(boom\)/);
    } finally {
      console.error = consoleError;
    }
  });

  it("offers setup when TypeScript 7 failed to start, whose first step explains it", async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const dir = sfdxProject();
      const { messages, output, executed, settle } = await activate({
        folders: [dir],
        projectSetup: fakeProjectSetup().projectSetup,
        typescript7Error: new Error("boom"),
        answer: ({ actions }) => ["Set Up Project", "Show Error"].find((action) => actions.includes(action)),
      });
      await settle();
      assert.deepEqual(
        messages.map((m) => [m.message, m.actions]),
        [
          [
            `Lightning Bolts: the ${path.basename(dir)} project isn't set up for the content mapper, which declares your Apex, labels, schema and other metadata for LWC imports.`,
            ["Set Up Project", "Learn More", "Don't Ask Again"],
          ],
          [
            "Lightning Bolts: the TypeScript 7 extension failed to start (boom), so the content mapper isn't running.",
            ["Show Error", "Reload Window", "Learn More"],
          ],
        ],
      );
      assert.match(output[0], /^The TypeScript 7 extension failed to start: Error: boom/);
      assert.deepEqual(executed, []);
    } finally {
      console.error = consoleError;
    }
  });
});

describe("package updates", () => {
  /** A set-up project whose Lightning types are older than the version the extension knows of. */
  const outdated = () => {
    const dir = sfdxProject({ installed: true });
    writeFileSync(path.join(dir, "node_modules/@salesforce/lightning-types/package.json"), JSON.stringify({ version: "0.1.0" }));
    return { dir, ...fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) }) };
  };
  const known = realProjectSetup.KNOWN_VERSIONS["@salesforce/lightning-types"];
  const update = `@salesforce/lightning-types@${known}`;

  it("says at startup that an installed package is older than the extension knows of, and updates it from the package menu", async () => {
    const { dir, projectSetup } = outdated();
    const { messages, menus, installs, settle } = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.1.0-beta",
      answer: once("Update Packages"),
    });
    await settle();
    const notice = messages.find((m) => /available for/.test(m.message));
    assert.equal(
      notice.message,
      `Lightning Bolts: an update is available for ${path.basename(dir)}: @salesforce/lightning-types (0.1.0 → ${known}).`,
    );
    assert.deepEqual(notice.actions, ["Update Packages", "Learn More", "Don't Ask Again"]);
    assert.deepEqual(
      menus[0].map(({ label, description, picked }) => [label, description, picked]),
      [[update, "update from 0.1.0", true]],
    );
    assert.deepEqual(installs, [{ commandLine: `npm install --save-dev ${update}`, cwd: dir }]);
  });

  it("stops suggesting an update unchecked in the menu, until Check Content Mapper Setup", async () => {
    const { dir, projectSetup } = outdated();
    const first = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.1.0-beta",
      answer: once("Update Packages"),
      pickPackages: () => [],
    });
    await first.settle();
    assert.deepEqual(first.installs, []);
    assert.deepEqual(first.context.workspaceState.get("lwcBolts.declinedUpdates"), [update]);

    const second = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.1.0-beta",
      workspaceState: first.context.workspaceState,
    });
    await second.settle();
    assert.deepEqual(second.messages, [], "no update suggested");
    await second.commands["lwcBolts.checkSetup"]();
    assert.ok(
      second.messages.some((m) => /an update is available/.test(m.message)),
      "suggested again once asked",
    );
    assert.equal(second.context.workspaceState.get("lwcBolts.declinedUpdates"), undefined);
  });

  it("offers updates in setup's summary, through the same menu", async () => {
    const { dir } = outdated();
    const setup = fakeProjectSetup({ planSetup: () => setupPlan(dir), findProjectConfig: () => foundConfig(dir) });
    const { commands, messages, menus } = await activate({
      folders: [dir],
      projectSetup: setup.projectSetup,
      settings: { ...SET_UP_SETTINGS },
      answer: once("Update Packages"),
      pickPackages: () => undefined,
    });
    await commands["lwcBolts.setUpProject"]();
    const summary = summaryOf(messages);
    assert.match(
      summary.message,
      new RegExp(`An update is available: @salesforce/lightning-types \\(0\\.1\\.0 → ${known.replaceAll(".", "\\.")}\\)\\.`),
    );
    assert.deepEqual(summary.actions, ["Update Packages", "Learn More"], "nothing changed, so nothing to restart for");
    assert.deepEqual(
      menus.at(-1).map(({ label }) => label),
      [update],
    );
  });
});

describe("Don't Ask Again", () => {
  const dontAsk = ({ actions }) => (actions.includes("Don't Ask Again") ? "Don't Ask Again" : undefined);

  it("is offered by every prompt the extension shows on its own", async () => {
    const dir = sfdxProject();
    // not set up (no project config), untrusted, and content mappers off
    const { projectSetup } = fakeProjectSetup();
    const { messages, settle } = await activate({
      folders: [dir],
      projectSetup,
      trusted: false,
      settings: { "contentMappers.enabled": { workspaceValue: false } },
    });
    await settle();
    // one prompt for the three startup problems
    assert.equal(messages.length, 1, JSON.stringify(messages));
    for (const { message, actions } of messages) {
      assert.equal(actions.at(-1), "Don't Ask Again", message);
    }
  });

  it("silences every prompt in the workspace once chosen, until Check Content Mapper Setup runs", async () => {
    const dir = sfdxProject();
    const { projectSetup } = fakeProjectSetup();
    const first = await activate({ folders: [dir], projectSetup, trusted: false, answer: dontAsk });
    await first.settle();
    assert.ok(first.messages.length > 0);
    assert.equal(first.context.workspaceState.get("lwcBolts.dontAsk"), true);

    // the next session in the same workspace
    const { messages, settle, commands } = await activate({
      folders: [dir],
      projectSetup,
      trusted: false,
      workspaceState: first.context.workspaceState,
    });
    await settle();
    assert.deepEqual(messages, []);
    await commands["lwcBolts.checkSetup"]();
    assert.ok(
      messages.some((m) => /isn't set up/.test(m.message)),
      "Check Content Mapper Setup still answers",
    );
    assert.ok(messages.every((m) => !m.actions.includes("Don't Ask Again")));
    assert.ok(
      messages.every((m) => !/looks good/.test(m.message)),
      "no confirmation",
    );
    assert.equal(first.context.workspaceState.get("lwcBolts.dontAsk"), undefined);

    // and the session after that prompts again
    const third = await activate({ folders: [dir], projectSetup, trusted: false, workspaceState: first.context.workspaceState });
    await third.settle();
    assert.deepEqual(
      third.messages.map((m) => m.actions),
      [["Show Details", "Learn More", "Don't Ask Again"]],
    );
  });

  it("forgets the recommended packages unchecked in the package menu, and suggests them again", async () => {
    const dir = sfdxProject({ typescript: true });
    symlinkSync(mapperDir, path.join(dir, "node_modules/@lwc-bolts/typescript-content-mapper"), "dir");
    const { projectSetup } = fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) });
    const { commands, messages, menus, context, settle } = await activate({
      folders: [dir],
      projectSetup,
      typescriptVersion: "7.1.0-beta",
      answer: once("Install Packages"),
    });
    await settle();
    await context.workspaceState.update("lwcBolts.declinedPackages", ["@salesforce/lightning-types"]);
    await commands["lwcBolts.checkSetup"]();
    assert.deepEqual(context.workspaceState.get("lwcBolts.declinedPackages") ?? [], [], "none unchecked any more");
    assert.ok(
      messages.every((m) => !/looks good/.test(m.message)),
      "no confirmation",
    );
    const suggestion = messages.find((m) => /recommended for/.test(m.message));
    assert.equal(
      suggestion.message,
      `Lightning Bolts: recommended for ${path.basename(dir)}: @salesforce/lightning-types (types the lightning/* modules).`,
    );
    assert.deepEqual(suggestion.actions, ["Install Packages", "Learn More"]);
    assert.deepEqual(
      menus[0].map(({ label, picked }) => [label, picked]),
      [["@salesforce/lightning-types", true]],
    );
  });

  it("only suggests recommended packages when asked, not at startup", async () => {
    const dir = sfdxProject({ typescript: true });
    symlinkSync(mapperDir, path.join(dir, "node_modules/@lwc-bolts/typescript-content-mapper"), "dir");
    const { projectSetup } = fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) });
    const { messages, settle } = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.1.0-beta",
    });
    await settle();
    assert.deepEqual(messages, []);
  });
});

describe("applying the settings to the project config", () => {
  it("sets the project config's options from the most specific settings, as project-setup sets them", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    writeFileSync(file, "old");
    const { projectSetup, called } = fakeProjectSetup({
      findProjectConfig: () => foundConfig(dir, readFileSync(file, "utf8")),
      setContentMapperOptions: (text) => (text === "old" ? "new" : text),
    });
    const { commands, messages } = await activate({
      folders: [dir],
      projectSetup,
      settings: {
        apexNamespace: { globalValue: "Acme", workspaceValue: null },
        disabledMetadataTypes: { workspaceValue: ["CustomPermission"] },
        useVSCodeNode: { globalValue: false },
      },
    });
    await commands["lwcBolts.applySettingsToProject"]();
    // an unset setting removes its option, so the mapper applies its default; useVSCodeNode isn't an option
    assert.deepEqual(called("setContentMapperOptions"), [
      [
        "old",
        {
          apexNamespace: null,
          inaccessibleApexProperties: undefined,
          disabledMetadataTypes: ["CustomPermission"],
          respectForceIgnore: undefined,
          suppressDiagnosticsExtensions: undefined,
        },
      ],
    ]);
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.match(
      messages.at(-1).message,
      /applied .* to force-app\/main\/default\/lwc\/jsconfig\.json \(apexNamespace, disabledMetadataTypes; the rest use their defaults\)/,
    );
    await commands["lwcBolts.applySettingsToProject"]();
    assert.match(messages.at(-1).message, /already uses your lwcBolts\.contentMapper settings/);
  });

  it("offers to set up a project without a project config", async () => {
    const dir = sfdxProject();
    const { projectSetup, called } = fakeProjectSetup();
    const { commands, messages } = await activate({
      folders: [dir],
      projectSetup,
      // only this command's offer, not the startup check's suggestion
      answer: ({ message }) => (message.includes("no config to apply") ? "Set Up Project" : undefined),
    });
    await commands["lwcBolts.applySettingsToProject"]();
    assert.deepEqual(messages.find((m) => m.message.includes("no config to apply")).actions, ["Set Up Project"]);
    assert.deepEqual(called("planSetup"), [[dir, {}]]);
  });

  it("leaves a project config alone when project-setup can't set options in it", async () => {
    const dir = sfdxProject();
    const file = path.join(dir, PROJECT_CONFIG);
    writeFileSync(file, "{ not json");
    const { projectSetup } = fakeProjectSetup({
      findProjectConfig: () => foundConfig(dir, "{ not json"),
      setContentMapperOptions: () => undefined,
    });
    const { commands, messages } = await activate({ folders: [dir], projectSetup, settings: { apexNamespace: { globalValue: "Acme" } } });
    await commands["lwcBolts.applySettingsToProject"]();
    assert.equal(readFileSync(file, "utf8"), "{ not json");
    assert.equal(
      messages.at(-1).message,
      "Lightning Bolts: couldn't apply the settings: force-app/main/default/lwc/jsconfig.json isn't valid JSON.",
    );
  });
});

describe("setup checks", () => {
  /** An installed project that project-setup finds a project config in. */
  const setUp = (text = "{}") => {
    const dir = sfdxProject({ installed: true });
    return { dir, ...fakeProjectSetup({ findProjectConfig: () => foundConfig(dir, text) }) };
  };

  it("reports nothing for a set-up project", async () => {
    const { dir, projectSetup } = setUp();
    const { commands, messages, settle } = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.1.0-beta",
    });
    await settle();
    assert.deepEqual(warnings(messages), []);
    await commands["lwcBolts.checkSetup"]();
    assert.deepEqual(
      messages.map((m) => m.message),
      ["Lightning Bolts: the content mapper setup looks good."],
    );
  });

  it("explains an untrusted workspace, disabled content mappers and an old TypeScript", async () => {
    const { dir, projectSetup } = setUp();
    const { messages, settle, executed, settings } = await activate({
      folders: [dir],
      projectSetup,
      trusted: false,
      typescriptVersion: "7.0.2",
      settings: { "experimental.useTsgo": { workspaceValue: true }, "contentMappers.enabled": { workspaceValue: false } },
      answer: ({ actions }) => actions[0],
    });
    await settle();
    const shown = warnings(messages);
    assert.ok(shown.some((m) => /only run in trusted workspaces/.test(m)));
    assert.ok(shown.some((m) => /^Lightning Bolts: js\/ts\.contentMappers\.enabled is off in this workspace/.test(m)));
    assert.ok(shown.some((m) => /the editor is running TypeScript 7\.0\.2, which is too old/.test(m)));
    assert.deepEqual(executed.map(([id]) => id).sort(), ["typescript.native-preview.selectVersion", "workbench.trust.manage"]);
    assert.equal(settings["contentMappers.enabled"].workspaceValue, true, "Turn On Settings");
  });

  it("offers the missing mapper first, not the editor's TypeScript too, at startup or when the server starts", async () => {
    const dir = sfdxProject({ typescript: true });
    const { projectSetup } = fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) });
    const { messages, settle, startServer, commands } = await activate({
      folders: [dir],
      projectSetup,
      settings: { ...TS7_SETTINGS },
      typescriptVersion: "7.0.2",
    });
    await settle();
    await startServer("7.0.2");
    const versionWarning = (m) => /can't run content mappers/.test(m);
    assert.deepEqual(warnings(messages).length, 1);
    assert.match(warnings(messages)[0], /doesn't have it installed/);
    assert.ok(!warnings(messages).some(versionWarning));
    // nor when asked
    await commands["lwcBolts.checkSetup"]();
    assert.ok(!warnings(messages).some(versionWarning));
  });

  it("offers an update first, not the editor's TypeScript too", async () => {
    const { dir, projectSetup } = setUp();
    writeFileSync(path.join(dir, "node_modules/@salesforce/lightning-types/package.json"), JSON.stringify({ version: "0.9.0" }));
    const { messages, settle, startServer } = await activate({ folders: [dir], projectSetup, settings: { ...TS7_SETTINGS } });
    await settle();
    await startServer("7.0.2");
    assert.deepEqual(warnings(messages).length, 1);
    assert.match(warnings(messages)[0], /an update is available/);
  });

  it("offers to install TypeScript 7.1 rather than select a version when the project has none", async () => {
    const { dir, projectSetup } = setUp();
    rmSync(path.join(dir, "node_modules/typescript"), { force: true });
    const { messages, settle, startServer } = await activate({ folders: [dir], projectSetup, settings: { ...TS7_SETTINGS } });
    await settle();
    await startServer("7.0.2");
    const shown = messages.filter((m) => m.level === "warning");
    assert.equal(shown.length, 1);
    assert.match(
      shown[0].message,
      /the editor is running TypeScript 7\.0\.2, which is too old \(7\.1 or later needed\)\. .* doesn't have TypeScript 7\.1 installed/,
    );
    assert.deepEqual(shown[0].actions, ["Install Packages", "Learn More", "Don't Ask Again"]);
  });

  it("asks to select the editor's TypeScript once the project has everything installed", async () => {
    const { dir, projectSetup } = setUp();
    const { messages, settle, startServer } = await activate({ folders: [dir], projectSetup, settings: { ...TS7_SETTINGS } });
    await settle();
    await startServer("7.0.2");
    const shown = messages.filter((m) => m.level === "warning");
    assert.equal(shown.length, 1);
    assert.match(shown[0].message, /the editor is running TypeScript 7\.0\.2, which is too old/);
    assert.ok(shown[0].actions.includes("Select Version"));
  });

  it("says when a set-up project's workspace settings are off or unset, and turns them on only from its button", async () => {
    const { dir, projectSetup } = setUp();
    const settings = { "contentMappers.enabled": { workspaceValue: false } };
    const first = await activate({ folders: [dir], projectSetup, typescriptVersion: "7.1.0-beta", settings, approveSettings: false });
    await first.settle();
    const [notice] = warnings(first.messages);
    assert.match(notice, /^Lightning Bolts: js\/ts\.experimental\.useTsgo and js\/ts\.contentMappers\.enabled are off in this workspace/);
    assert.equal(settings["experimental.useTsgo"], undefined, "not without the user's say-so");
    assert.equal(settings["contentMappers.enabled"].workspaceValue, false);
    const second = await activate({
      folders: [dir],
      projectSetup,
      typescriptVersion: "7.1.0-beta",
      settings,
      answer: once("Turn On Settings"),
    });
    await second.settle();
    assert.equal(settings["experimental.useTsgo"].workspaceValue, true);
    assert.equal(settings["contentMappers.enabled"].workspaceValue, true);
  });

  it("leaves the workspace settings to setup for a project that isn't set up", async () => {
    const { messages, settle } = await activate({ folders: [sfdxProject()], projectSetup: fakeProjectSetup().projectSetup });
    await settle();
    assert.equal(notices(messages).length, 1);
    assert.match(notices(messages)[0], /isn't set up for the content mapper/);
    assert.equal(messages[0].level, "information", "an offer, not a problem");
  });

  it("explains a configured project's missing mapper package", async () => {
    const dir = sfdxProject();
    const { projectSetup } = fakeProjectSetup({ findProjectConfig: () => foundConfig(dir) });
    const { messages, settle } = await activate({ folders: [dir], projectSetup, settings: { ...TS7_SETTINGS } });
    await settle();
    assert.ok(
      warnings(messages).some((m) =>
        /registers @lwc-bolts\/typescript-content-mapper in its config, but doesn't have it installed/.test(m),
      ),
    );
  });

  it("explains a jsconfig.json project config the Salesforce extensions can't read", async () => {
    const { dir, projectSetup } = setUp("// mine\n{}");
    const { messages, settle } = await activate({ folders: [dir], projectSetup, settings: { ...TS7_SETTINGS } });
    await settle();
    assert.ok(warnings(messages).some((m) => /comments or trailing commas in force-app\/main\/default\/lwc\/jsconfig\.json/.test(m)));
  });

  it("explains that configured projects need a recent enough node on the PATH", async () => {
    for (const [nodeVersion, found] of [
      [null, "(none found). Install it"],
      ["v20.19.0", "(found v20.19.0). Update it"],
    ]) {
      const { dir, projectSetup } = setUp();
      const { messages, settle } = await activate({ folders: [dir], projectSetup, nodeVersion, settings: { ...TS7_SETTINGS } });
      await settle();
      assert.ok(
        warnings(messages).some((m) =>
          m.includes(`the content mapper needs Node.js 22.18 or later on your PATH ${found}, then restart VS Code.`),
        ),
        String(nodeVersion),
      );
    }
  });
});

describe("setup guide", () => {
  it("has a heading for each section the setup messages link to", () => {
    const source = readFileSync(new URL("../src/setup.ts", import.meta.url), "utf8");
    const sections = [...source.match(/type DocsSection =([^;]*);/)[1].matchAll(/"([^"]+)"/g)].map(([, name]) => name);
    assert.ok(sections.length > 10);
    const guide = readFileSync(new URL("../docs/setup.md", import.meta.url), "utf8");
    // as GitHub makes a heading's anchor: lowercased, punctuation dropped, spaces as hyphens
    const anchors = [...guide.matchAll(/^#{2,} (.+)$/gm)].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^\w\- ]/g, "")
        .replace(/ /g, "-"),
    );
    assert.deepEqual(
      sections.filter((section) => !anchors.includes(section)),
      [],
    );
  });
});

describe("settings", () => {
  const properties = manifest.contributes.configuration.properties;

  it("lists every metadata type the mapper converts", () => {
    const setting = properties["lwcBolts.contentMapper.disabledMetadataTypes"];
    assert.deepEqual(setting.items.enum, [...METADATA_TYPES].sort());
  });

  it("has a setting for each mapper option but lwcConfigFile, with the option's default (or every handled extension)", async () => {
    const prefix = "lwcBolts.contentMapper.";
    const settings = Object.keys(properties)
      .filter((key) => key.startsWith(prefix) && key !== `${prefix}useVSCodeNode`)
      .map((key) => key.slice(prefix.length));
    const options = OPTION_NAMES.filter((name) => name !== "lwcConfigFile");
    assert.deepEqual(settings.sort(), [...options].sort());
    for (const name of options) {
      const expected = name === "suppressDiagnosticsExtensions" ? HANDLED : OPTION_DEFAULTS[name];
      assert.deepEqual(properties[prefix + name].default, expected, name);
    }
    // and each is passed to the mapper when it's set
    const set = Object.fromEntries(options.map((name) => [name, { globalValue: OPTION_DEFAULTS[name] }]));
    const { registrations } = await activate({ settings: set });
    assert.deepEqual(Object.keys(registrations[0].contributions[0].inferredProjectContribution.options).sort(), [...options].sort());
  });
});
