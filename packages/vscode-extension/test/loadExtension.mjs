// Loads the compiled extension (dist) for a test, with `vscode` and some of the extension's own modules
// replaced by stubs. It uses module.registerHooks (Node.js 22.15+), which VS Code's extension host also uses
// to give ES module extensions their `vscode` (microsoft/vscode#285297), and which runs the hooks on the
// thread that imports, so they can see the test's stubs.
//
// ES modules have no cache to clear, so each load is a module graph of its own: its modules' URLs carry the
// load's number (`?load=3`), which the hooks pass on to each module the extension imports from dist, and
// each specifier the load replaces resolves to a module made from its stub. Other modules, such as
// @lwc-bolts/project-setup, are shared between loads.
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = pathToFileURL(path.join(import.meta.dirname, "../dist") + path.sep).href;
const STUB_SCHEME = "lwc-bolts-stub:";
/** Each load's stubs, by specifier; stub modules read theirs from here when they're evaluated. */
const STUBS = Symbol.for("lwc-bolts-vscode.test-stubs");
/** @type {Map<string, Record<string, object>>} */
const loads = (globalThis[STUBS] = new Map());
let count = 0;

/** The load a module belongs to, from its URL, if it's one of a load's. */
function loadOf(url) {
  if (url?.startsWith(dist) || url?.startsWith(STUB_SCHEME)) {
    return new URL(url).searchParams.get("load") ?? undefined;
  }
  return undefined;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const load = loadOf(context.parentURL);
    if (load === undefined) {
      return nextResolve(specifier, context);
    }
    if (Object.hasOwn(loads.get(load), specifier)) {
      return { url: `${STUB_SCHEME}${encodeURIComponent(specifier)}?load=${load}`, format: "module", shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    // the extension's own modules: this load's copies
    return resolved.url.startsWith(dist) ? { ...resolved, url: `${resolved.url.split("?")[0]}?load=${load}` } : resolved;
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(STUB_SCHEME)) {
      return nextLoad(url, context);
    }
    const { pathname, searchParams } = new URL(url);
    const specifier = decodeURIComponent(pathname);
    const load = searchParams.get("load");
    const names = Object.keys(loads.get(load)[specifier]);
    const source =
      `const stub = globalThis[Symbol.for(${JSON.stringify(STUBS.description)})].get(${JSON.stringify(load)})[${JSON.stringify(specifier)}];\n` +
      `export default stub;\n` +
      (names.length > 0 ? `export const { ${names.join(", ")} } = stub;\n` : "");
    return { format: "module", source, shortCircuit: true };
  },
});

/**
 * Imports a new copy of dist/extension.js, in which importing each specifier of `stubs` (such as `vscode`
 * or `./nodeOnPath.js`, as the extension's modules write them) gives that stub's properties as its exports.
 */
export async function loadExtension(stubs) {
  const load = String(++count);
  loads.set(load, stubs);
  return import(`${dist}extension.js?load=${load}`);
}
