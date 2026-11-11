import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CONTENT_MAPPER_EXTENSIONS, CONTENT_MAPPER_PACKAGE } from "@lwc-bolts/project-setup";
import * as vscode from "vscode";
// The TypeScript 7 extension's API types; typescript/vscode is ESM-only, and only its types are used.
import type { ContentMapperManifest, ExtensionAPI } from "typescript/vscode";
import { rewriteCodeActions, rewriteCompletions, rewriteResolvedCompletion } from "./autoImport.ts";
import { loadProjectSetup } from "./projectSetupLoader.ts";
import { readOptions, SETTINGS_SECTION } from "./settings.ts";
import {
  registerSetup,
  registerSetupUnavailable,
  TYPESCRIPT_7_EXTENSION,
  type ProjectSetup,
  type TypeScript7Unavailable,
} from "./setup.ts";
import { satisfiesMinimum } from "./versions.ts";

const requireFromExtension = createRequire(import.meta.url);

export async function activate(context: vscode.ExtensionContext) {
  const typescript7 = vscode.extensions.getExtension<ExtensionAPI>(TYPESCRIPT_7_EXTENSION);
  const nodeEngine = resolveContentMapperManifest()?.nodeEngine;
  let projectSetup: ProjectSetup;
  try {
    projectSetup = await loadProjectSetup();
  } catch (error) {
    // A broken installation. The commands explain it, and the content mapper still works without them.
    console.error("Lightning Bolts: unable to load @lwc-bolts/project-setup", error);
    registerSetupUnavailable(context, error);
    if (typescript7 === undefined) {
      whenInstalled(context, (api) => api !== undefined && registerFeatures(api, context));
      return;
    }
    const { api } = await activateTypeScript7(typescript7);
    if (api !== undefined) {
      registerFeatures(api, context);
    }
    return;
  }
  if (typescript7 === undefined) {
    // Without TypeScript 7 there's no content mapper to register yet. The setup commands are registered,
    // and the startup check explains that TypeScript 7 is needed; once it's installed, the features are
    // registered and the setup runs again, to offer the next step.
    const setup = registerSetup(context, undefined, nodeEngine, projectSetup);
    whenInstalled(context, (api, error) => {
      setup.connect(api, { reason: "failed", error });
      if (api !== undefined) {
        registerFeatures(api, context);
      }
    });
    return;
  }
  const { api, error } = await activateTypeScript7(typescript7);
  // The setup commands first, so a feature that fails below can't leave them unregistered.
  const unavailable: TypeScript7Unavailable = { reason: "failed", error };
  registerSetup(context, api, nodeEngine, projectSetup, unavailable);
  if (api !== undefined) {
    registerFeatures(api, context);
  }
}

/**
 * Waits for the TypeScript 7 extension to be installed, then activates it and passes on its API, or why
 * there isn't one. VS Code doesn't activate an extension again, so this is how one installed after it
 * started is picked up without reloading the window.
 */
function whenInstalled(context: vscode.ExtensionContext, then: (api: ExtensionAPI | undefined, error: unknown) => unknown): void {
  const listener = vscode.extensions.onDidChange(async () => {
    const typescript7 = vscode.extensions.getExtension<ExtensionAPI>(TYPESCRIPT_7_EXTENSION);
    if (typescript7 === undefined) {
      return;
    }
    listener.dispose();
    const { api, error } = await activateTypeScript7(typescript7);
    then(api, error);
  });
  context.subscriptions.push(listener);
}

/** Activates TypeScript 7 for its API; without one, `error` is why, if it threw. */
async function activateTypeScript7(
  typescript7: vscode.Extension<ExtensionAPI> | undefined,
): Promise<{ api?: ExtensionAPI; error?: unknown }> {
  try {
    return { api: (await typescript7?.activate()) ?? undefined };
  } catch (error) {
    console.error("Lightning Bolts: the TypeScript 7 extension failed to activate", error);
    return { error };
  }
}

/**
 * Older TypeScript 7 extensions lack parts of this API, so each feature checks for what it uses, and a
 * feature that fails anyway is logged rather than stopping the others.
 */
function registerFeatures(api: ExtensionAPI, context: vscode.ExtensionContext): void {
  safely("registering the content mapper", () => registerContentMapper(api, context));
  safely("registering the auto-import rewrites", () => registerAutoImportRewrites(api, context));
}

/** Runs one of the extension's features, logging an error instead of failing activation. */
function safely(feature: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`Lightning Bolts: ${feature} failed`, error);
  }
}

export function deactivate() {}

/**
 * Registering makes TypeScript find configured projects for metadata files opened before any LWC file,
 * and lets it map metadata files that belong to no configured project (an inferred project).
 * Configured projects still use the mapper from their own tsconfig `contentMappers`.
 */
/**
 * It's registered for the extensions project configs register it for (CONTENT_MAPPER_EXTENSIONS): `.xml`
 * rather than each `-meta.xml` suffix, which TypeScript 7.1 can't match on case-insensitive file systems
 * when it contains uppercase letters (`.customPermission-meta.xml`), and `.html` for templates.
 */
function registerContentMapper(api: ExtensionAPI, context: vscode.ExtensionContext) {
  if (typeof api.registerContentMappers !== "function") {
    console.warn("Lightning Bolts: this TypeScript 7 extension can't register content mappers; update it");
    return;
  }
  const manifest = resolveContentMapperManifest();
  if (manifest === undefined) {
    console.error(`Lightning Bolts: unable to resolve ${CONTENT_MAPPER_PACKAGE}`);
    return;
  }
  let registration: vscode.Disposable | undefined;
  const register = () => {
    registration?.dispose();
    const useHostNode = vscode.workspace.getConfiguration(SETTINGS_SECTION).get<boolean>("useVSCodeNode", true);
    const { exec } = manifest.contentMapper;
    const launch = useHostNode ? hostNodeExec(exec, manifest.nodeEngine) : exec;
    registration = api.registerContentMappers(context.extension.id, [
      {
        extensions: [...CONTENT_MAPPER_EXTENSIONS],
        inferredProjectContribution: { manifest: { ...manifest.contentMapper, exec: launch }, options: inferredProjectOptions() },
      },
    ]);
  };
  register();
  context.subscriptions.push(
    { dispose: () => registration?.dispose() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SETTINGS_SECTION)) {
        register();
      }
    }),
  );
}

/**
 * The mapper options for inferred projects: the settings, with every extension the mapper is registered for
 * (CONTENT_MAPPER_EXTENSIONS) suppressing its diagnostics until `suppressDiagnosticsExtensions` is set.
 * Files outside any config are often ones the user only opened, so their errors are more noise than help.
 */
function inferredProjectOptions(): Record<string, unknown> {
  return { suppressDiagnosticsExtensions: [...CONTENT_MAPPER_EXTENSIONS], ...readOptions() };
}

/** Auto-imports another component through its `c/<name>` module rather than a relative path. */
function registerAutoImportRewrites(api: ExtensionAPI, context: vscode.ExtensionContext) {
  if (typeof api.registerLspMiddleware !== "function") {
    console.warn(
      "Lightning Bolts: this TypeScript 7 extension has no LSP middleware API, so auto-imports of other " +
        "components' named exports keep relative paths; update the extension to rewrite them to c/<name>",
    );
    return;
  }
  context.subscriptions.push(
    api.registerLspMiddleware("textDocument/completion", (result) => rewriteCompletions(result)),
    api.registerLspMiddleware("completionItem/resolve", (result) => rewriteResolvedCompletion(result)),
    api.registerLspMiddleware("textDocument/codeAction", (result, { params }) => rewriteCodeActions(result, params.textDocument.uri)),
  );
}

/** The parts of the running Node.js process that decide whether it can run the mapper. */
export interface NodeHost {
  readonly execPath: string;
  readonly versions: { readonly node: string; readonly electron?: string };
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs the mapper with the Node.js that runs this extension instead of the `node` on the user's PATH,
 * which may be missing or too old. In desktop VS Code that's Electron, which only behaves as Node.js
 * with `ELECTRON_RUN_AS_NODE=1`. VS Code sets it in the extension host, and the TypeScript 7 extension
 * starts its server with a copy of the extension host's environment, which the server passes on to the
 * mapper. The manifest can't set environment variables itself, so without it this keeps `node`; so it
 * does when the host's Node.js doesn't satisfy the mapper's `engines.node`, or `exec` doesn't use `node`.
 *
 * Only inferred projects use this manifest. Configured projects run the `exec` from the mapper's own
 * package.json, which TypeScript reads itself.
 */
export function hostNodeExec(exec: readonly string[], nodeEngine: string | undefined, host: NodeHost = process): readonly string[] {
  const [command, ...args] = exec;
  if (command !== "node" || !satisfiesMinimum(host.versions.node, nodeEngine)) {
    return exec;
  }
  if (host.versions.electron !== undefined && host.env.ELECTRON_RUN_AS_NODE !== "1") {
    return exec;
  }
  return [host.execPath, ...args];
}

/**
 * Builds the manifest for inferred projects from the mapper package's own package.json, preferring a
 * copy installed in a workspace folder (so it matches what that project's tsconfig uses) over the copy
 * bundled with this extension.
 */
function resolveContentMapperManifest(): { contentMapper: ContentMapperManifest; nodeEngine: string | undefined } | undefined {
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  for (const paths of [...workspaceFolders.map((folder) => [folder]), undefined]) {
    let packageJsonPath: string;
    try {
      packageJsonPath = requireFromExtension.resolve(`${CONTENT_MAPPER_PACKAGE}/package.json`, paths && { paths });
    } catch {
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const contentMapper = packageJson.typescript?.contentMapper;
    if (!Array.isArray(contentMapper?.exec)) {
      continue;
    }
    return {
      contentMapper: {
        name: packageJson.name,
        version: packageJson.version,
        exec: contentMapper.exec,
        // `exec` is relative to the package, as when TypeScript launches it from a tsconfig registration.
        cwd: vscode.Uri.file(path.dirname(packageJsonPath)),
        compilerOptions: contentMapper.compilerOptions,
        dynamicConfig: contentMapper.dynamicConfig,
      },
      nodeEngine: packageJson.engines?.node,
    };
  }
  return undefined;
}
