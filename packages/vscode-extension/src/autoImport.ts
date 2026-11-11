// Rewrites auto-imports of another LWC component from a relative path to its `c/<name>` module.
//
// The content mapper declares `c/<name>` for each bundle as an ambient module whose `export =` is the
// component's module type. That types every import, but TypeScript's auto-import only attributes the
// component's named exports to the component's file, so for them it writes a relative path
// (`import { data } from "../comp2/comp2"`), which LWC doesn't allow between bundles. These functions
// rewrite TypeScript 7's language server responses (through the TypeScript extension's LSP middleware)
// so the import uses `c/<name>`. They have no `vscode` dependency, so they can be tested directly.
//
// A template's default export is offered too, and LWC only lets a bundle import its own templates, so
// other bundles' templates are dropped. They have no module to rewrite them to.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeAction, Command, CompletionItem, CompletionList, TextEdit, WorkspaceEdit } from "typescript/vscode";

/** Reports whether `mainFile` (a bundle's main module, without extension) belongs to an LWC bundle. */
export type BundleCheck = (mainFile: string) => boolean;

/** A bundle is a folder with a `<name>.js-meta.xml`, which the mapper declares the `c/<name>` module from. */
export const hasBundleMetadata: BundleCheck = (mainFile) => existsSync(`${mainFile}.js-meta.xml`);

/**
 * Returns `c/<name>` when `specifier`, written in `importer`, is a relative path to another LWC bundle's
 * main module (`<...>/lwc/<name>/<name>`, with or without a `.js` or `.ts` extension). Imports within
 * the importer's own bundle (including its `__tests__`) and anything else are left alone.
 */
export function componentSpecifier(importer: string, specifier: string, isBundle: BundleCheck = hasBundleMetadata): string | undefined {
  if (!/^\.\.?\//.test(specifier)) {
    return undefined;
  }
  const mainFile = path.resolve(path.dirname(importer), specifier).replace(/\.(js|ts)$/, "");
  const name = path.basename(mainFile);
  const bundleDir = path.dirname(mainFile);
  if (path.basename(bundleDir) !== name || path.basename(path.dirname(bundleDir)) !== "lwc") {
    return undefined;
  }
  const relativeToBundle = path.relative(bundleDir, importer);
  if (!relativeToBundle.startsWith("..") && !path.isAbsolute(relativeToBundle)) {
    return undefined;
  }
  return isBundle(mainFile) ? `c/${name}` : undefined;
}

/** The folder of the bundle `file` is in (`<...>/lwc/<name>`), if it's in one. */
function bundleFolder(file: string): string | undefined {
  const parts = file.split(path.sep);
  const lwc = parts.lastIndexOf("lwc");
  return lwc === -1 || lwc + 2 >= parts.length ? undefined : parts.slice(0, lwc + 2).join(path.sep);
}

/** Whether `specifier`, written in `importer`, is a relative path to a template in another bundle. */
export function otherBundleTemplate(importer: string, specifier: string): boolean {
  if (!/^\.\.?\/.*\.html$/i.test(specifier)) {
    return false;
  }
  const bundle = bundleFolder(path.resolve(path.dirname(importer), specifier));
  return bundle !== undefined && bundle !== bundleFolder(importer);
}

/** Module specifiers in import declarations, `import()`, `require()`, and "... from "x"" titles. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\2/g;

/** Rewrites the module specifiers of other bundles' main modules in import text or a fix's title. */
export function rewriteImportText(text: string, importer: string, isBundle: BundleCheck = hasBundleMetadata): string {
  return text.replace(SPECIFIER, (match, prefix: string, quote: string, specifier: string) => {
    const rewritten = componentSpecifier(importer, specifier, isBundle);
    return rewritten === undefined ? match : `${prefix}${quote}${rewritten}${quote}`;
  });
}

/** Whether import text or a fix's title imports a template from another bundle. */
function importsOtherBundleTemplate(text: string, importer: string): boolean {
  return [...text.matchAll(SPECIFIER)].some((match) => otherBundleTemplate(importer, match[3]!));
}

/**
 * The auto-import part of a completion item's `data`, as TypeScript 7's language server sends it. The
 * server builds the import edit from `moduleSpecifier` when the item is resolved.
 */
interface AutoImportData {
  fileName: string;
  source?: string;
  autoImport: { moduleSpecifier: string; importKind?: number };
}

function autoImportData(item: CompletionItem): AutoImportData | undefined {
  const data = item.data as Partial<AutoImportData> | undefined;
  return typeof data?.fileName === "string" && typeof data.autoImport?.moduleSpecifier === "string" ? (data as AutoImportData) : undefined;
}

const completionKey = (label: string, specifier: string, importKind: number | undefined) => `${label}\0${specifier}\0${importKind}`;

/**
 * Points auto-import completions for another bundle's exports at its `c/<name>` module. The server
 * then writes the `c/<name>` import itself when the item is resolved. A rewritten item that duplicates
 * one TypeScript already offers from `c/<name>` (as it does for default imports) is dropped, and so is
 * another bundle's template.
 */
export function rewriteCompletions<T extends CompletionItem[] | CompletionList | null>(
  result: T,
  isBundle: BundleCheck = hasBundleMetadata,
): T {
  if (result === null) {
    return result;
  }
  const items = Array.isArray(result) ? result : result.items;
  const offered = new Set<string>();
  for (const item of items) {
    const data = autoImportData(item);
    if (data !== undefined) {
      offered.add(completionKey(item.label, data.autoImport.moduleSpecifier, data.autoImport.importKind));
    }
  }
  let changed = false;
  const rewritten: CompletionItem[] = [];
  for (const item of items) {
    const data = autoImportData(item);
    if (data !== undefined && otherBundleTemplate(data.fileName, data.autoImport.moduleSpecifier)) {
      changed = true;
      continue;
    }
    const specifier = data && componentSpecifier(data.fileName, data.autoImport.moduleSpecifier, isBundle);
    if (data === undefined || specifier === undefined) {
      rewritten.push(item);
      continue;
    }
    changed = true;
    if (offered.has(completionKey(item.label, specifier, data.autoImport.importKind))) {
      continue;
    }
    const original = data.autoImport.moduleSpecifier;
    rewritten.push({
      ...item,
      ...(item.labelDetails?.description === original && {
        labelDetails: { ...item.labelDetails, description: specifier },
      }),
      ...(item.detail !== undefined && { detail: rewriteImportText(item.detail, data.fileName, isBundle) }),
      data: {
        ...data,
        ...(data.source === original && { source: specifier }),
        autoImport: { ...data.autoImport, moduleSpecifier: specifier },
      },
    });
  }
  if (!changed) {
    return result;
  }
  return (Array.isArray(result) ? rewritten : { ...result, items: rewritten }) as T;
}

/**
 * Rewrites a resolved completion's import edit and description. The server normally already uses the
 * `c/<name>` specifier `rewriteCompletions` gave it; this covers items rewritten some other way.
 */
export function rewriteResolvedCompletion(item: CompletionItem, isBundle: BundleCheck = hasBundleMetadata): CompletionItem {
  const importer = (item.data as { fileName?: unknown } | undefined)?.fileName;
  if (typeof importer !== "string") {
    return item;
  }
  return {
    ...item,
    ...(item.detail !== undefined && { detail: rewriteImportText(item.detail, importer, isBundle) }),
    ...(item.additionalTextEdits && {
      additionalTextEdits: item.additionalTextEdits.map((edit) => rewriteTextEdit(edit, importer, isBundle)),
    }),
  };
}

/**
 * Rewrites "Add import from ..." quick fixes for another bundle's exports to import its `c/<name>`
 * module, dropping a rewritten fix that duplicates one already offered, and one that imports another
 * bundle's template.
 */
export function rewriteCodeActions(
  result: (Command | CodeAction)[] | null,
  documentUri: string,
  isBundle: BundleCheck = hasBundleMetadata,
): (Command | CodeAction)[] | null {
  const importer = toFilePath(documentUri);
  if (result === null || importer === undefined) {
    return result;
  }
  // A bare Command's `command` is the command's id; a CodeAction's is an optional Command object.
  const isCommand = (action: Command | CodeAction): action is Command => typeof action.command === "string";
  const offered = new Set(result.map((action) => action.title));
  const rewritten: (Command | CodeAction)[] = [];
  for (const action of result) {
    if (importsOtherBundleTemplate(action.title, importer)) {
      continue;
    }
    const title = isCommand(action) ? action.title : rewriteImportText(action.title, importer, isBundle);
    if (title === action.title) {
      rewritten.push(isCommand(action) ? action : rewriteCodeAction(action, title, isBundle));
      continue;
    }
    // drop a fix that duplicates one already offered, such as a default import TypeScript writes from c/
    if (offered.has(title)) {
      continue;
    }
    offered.add(title);
    rewritten.push(rewriteCodeAction(action as CodeAction, title, isBundle));
  }
  return rewritten;
}

function rewriteCodeAction(action: CodeAction, title: string, isBundle: BundleCheck): CodeAction {
  return { ...action, title, ...(action.edit && { edit: rewriteWorkspaceEdit(action.edit, isBundle) }) };
}

function rewriteWorkspaceEdit(edit: WorkspaceEdit, isBundle: BundleCheck): WorkspaceEdit {
  const changes =
    edit.changes &&
    Object.fromEntries(
      Object.entries(edit.changes).map(([uri, edits]) => {
        const file = toFilePath(uri);
        return [uri, file === undefined ? edits : edits.map((e) => rewriteTextEdit(e, file, isBundle))];
      }),
    );
  const documentChanges = edit.documentChanges?.map((change) => {
    if (!("textDocument" in change) || !("edits" in change)) {
      return change;
    }
    const file = toFilePath(change.textDocument.uri);
    return file === undefined ? change : { ...change, edits: change.edits.map((e) => rewriteTextEdit(e as TextEdit, file, isBundle)) };
  });
  return { ...edit, ...(changes && { changes }), ...(documentChanges && { documentChanges }) };
}

function rewriteTextEdit<E extends TextEdit>(edit: E, importer: string, isBundle: BundleCheck): E {
  const newText = rewriteImportText(edit.newText, importer, isBundle);
  return newText === edit.newText ? edit : { ...edit, newText };
}

function toFilePath(uri: string): string | undefined {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}
