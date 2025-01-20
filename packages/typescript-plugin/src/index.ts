import type ts from "typescript/lib/tsserverlibrary.js";
import {
  ComponentSet,
  MetadataResolver,
} from "@salesforce/source-deploy-retrieve";
import type { SourceComponent } from "@salesforce/source-deploy-retrieve";
import { getApexParser } from "web-tree-sitter-sfapex";
import type Parser from "web-tree-sitter";
import { convert, MetadataType } from "@lwc-bolts/sf2ts";

/* TODO:
// go to definition working on all virtual metadata
// should store and depend on mapping data
// should store "snapshot" of metadata files
// should figure out how to watch files for saves and refresh (should be able to lean on tsserver)
 */

let prsr: Parser;

let moduleRegistryCache: Map<string, string[]> = new Map();
let lwcRegistryCache: Map<string, string[]> = new Map();

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  // const modTs = modules.typescript;

  // let the TS server know about all of our "external" modules which are actually Apex
  // we generate typescript definition files from
  function getExternalFiles(
    project: ts.server.Project,
    updateLevel: ts.ProgramUpdateLevel
  ) {
    const sfdxProjectRoot = findSfdxRoot(project);
    if (!sfdxProjectRoot) {
      project.projectService.logger.info(
        "Can't find SFDX project root, not loading support module"
      );
      return [];
    }
    let registryCache = moduleRegistryCache.get(sfdxProjectRoot);
    if (!registryCache) {
      buildRegistryCache(project, sfdxProjectRoot);
      registryCache = moduleRegistryCache.get(sfdxProjectRoot);
    }
    return registryCache ?? [];
  }

  function buildRegistryCache(
    project: ts.server.Project,
    sfdxProjectRoot: string
  ) {
    const sfdxProjectContent = JSON.parse(
      project.readFile(sfdxProjectRoot + "/sfdx-project.json") ?? "{}"
    );
    let registryCache = moduleRegistryCache.get(sfdxProjectRoot);
    if (!registryCache) {
      registryCache = [];
      moduleRegistryCache.set(sfdxProjectRoot, registryCache);
      for (let packagePathObj of sfdxProjectContent.packageDirectories) {
        // use the SDR library to find all of the componenents of our target MDT types
        // TODO: need to provide a tree instead of it using the NodeFSTree
        const compSet = ComponentSet.fromSource(
          sfdxProjectRoot + "/" + packagePathObj.path
        ).filter(({ type }) => {
          return [
            MetadataType.ApexClass,
            MetadataType.CustomObject,
            MetadataType.CustomLabels,
            MetadataType.CustomPermission,
            MetadataType.StaticResource,
            MetadataType.ContentAsset,
            "LightningComponentBundle", // not transformed, only used here in this file
          ].includes(type.name);
        });

        // add to the external module cache
        registryCache.push(
          ...compSet
            .filter(({ type }) => type.name === MetadataType.ApexClass)
            .toArray()
            .map((c) => {
              return (c as unknown as SourceComponent).content ?? "";
            })
        );

        // add to the external module cache
        registryCache.push(
          ...compSet
            .filter(({ type }) =>
              [
                MetadataType.StaticResource,
                MetadataType.CustomPermission,
                MetadataType.CustomLabels,
                MetadataType.CustomObject,
                MetadataType.ContentAsset,
                // @ts-expect-error search for string in array of strings...
              ].includes(type.name)
            )
            .toArray()
            .map((c) => {
              return (c as unknown as SourceComponent).xml ?? "";
            })
        );

        const rslvr = new MetadataResolver();
        // add to the external module cache
        compSet
          .filter(({ type }) => ["CustomObject"].includes(type.name))
          .toArray()
          .forEach((c) => {
            if (registryCache) {
              // find CustomField xml and push into registry cache
              try {
                const fields = rslvr
                  .getComponentsFromPath(
                    `${(c as any).xml.split("/").slice(0, -1).join("/")}/fields/`
                  )
                  .map((c) => c.xml ?? "");
                registryCache.push(...fields);
              } catch (err) {
                console.error(err);
              }
            }
          });

        let lwcCache = lwcRegistryCache.get(sfdxProjectRoot);
        if (!lwcCache) {
          lwcCache = [];
          lwcRegistryCache.set(sfdxProjectRoot, lwcCache);
        }

        lwcCache.push(
          ...compSet
            .filter(({ type }) => type.name === "LightningComponentBundle")
            .toArray()
            .map((c: any) => `${c.content}/${c.name}.js`)
        );
      }
    }
  }

  function create(info: ts.server.PluginCreateInfo) {
    debugger;
    const sfdxProjectRoot = findSfdxRoot(info.project);
    info.project.projectService.logger.info(
      "Found SFDX Project Root at " + sfdxProjectRoot
    );
    if (!sfdxProjectRoot) {
      info.project.projectService.logger.info(
        "Can't find SFDX project root, not loading support module"
      );
      return info.languageService;
    }

    // setup component aliases
    addComponentPaths(info.project, sfdxProjectRoot);

    // start loading the Apex parser WASM library, must be an async action
    getApexParser().then((newParser) => {
      info.project.projectService.logger.info("Apex parser ready");
      prsr = newParser;
    });

    // Diagnostic logging
    info.project.projectService.logger.info(
      "I'm getting set up now! Check the log for this message."
    );

    const readFile = info.project.projectService.host.readFile;
    info.project.projectService.host.readFile = (
      path: string,
      encoding?: string | undefined
    ) => {
      let mdtType: string = "";
      if (path.endsWith(".cls")) {
        mdtType = "ApexClass";
      } else if (path.endsWith(".customPermission-meta.xml")) {
        mdtType = "CustomPermission";
      } else if (path.endsWith(".resource-meta.xml")) {
        mdtType = "StaticResource";
      } else if (path.endsWith(".labels-meta.xml")) {
        mdtType = "CustomLabels";
      } else if (path.endsWith(".object-meta.xml")) {
        mdtType = "CustomObject";
      } else if (path.endsWith(".field-meta.xml")) {
        mdtType = "CustomField";
      } else if (path.endsWith(".asset-meta.xml")) {
        mdtType = "ContentAsset";
      }
      if (mdtType.length > 0) {
        const text = readFile(path);
        if (text != undefined) {
          try {
            const cnvtdComp = convert([
              { path, type: mdtType as any, content: text },
            ]);
            return cnvtdComp[0].declarationContent;
          } catch (error) {
            // a failure to parse the file because we're waiting for async tasks to finish
            // the error includes a promise handle that we can attach to
            if ((error as any).waitFor) {
              (error as any).waitFor.then(() => {
                const pathInfo =
                  info.project.projectService.getScriptInfo(path);
                pathInfo?.reloadFromFile();
              });
            }
          }
        }
      }

      return readFile(path, encoding);
    };

    // Set up decorator object
    const proxy: ts.LanguageService = Object.create(null);
    for (let k of Object.keys(info.languageService) as Array<
      keyof ts.LanguageService
    >) {
      const x = info.languageService[k]!;
      // @ts-expect-error - JS runtime trickery which is tricky to type tersely
      proxy[k] = (...args: Array<{}>) => x.apply(info.languageService, args);
    }
    const toLineColumnOffset = info.languageService.toLineColumnOffset;
    if (toLineColumnOffset) {
      proxy.toLineColumnOffset = (fileName, position) => {
        // see if
        if (moduleRegistryCache.get(sfdxProjectRoot)?.includes(fileName)) {
          const text = readFile(fileName);
          if (text !== undefined) {
            const partialText = text.substring(0, position);
            const lines = partialText.split("\n");
            const output: ts.LineAndCharacter = {
              line: lines.length - 1,
              character: lines[lines.length - 1].length,
            };
            return output;
          }
        }
        return toLineColumnOffset(fileName, position);
      };
    }

    proxy.getDefinitionAtPosition = (
      fileName: string,
      position: number
    ): readonly ts.DefinitionInfo[] | undefined => {
      const output = info.languageService.getDefinitionAtPosition(
        fileName,
        position
      );
      info.project.projectService.logger.info(
        "getDefinitionAtPosition" + JSON.stringify(output)
      );

      return output;
    };

    proxy.getDefinitionAndBoundSpan = (
      fileName: string,
      position: number
    ): ts.DefinitionInfoAndBoundSpan | undefined => {
      const output = info.languageService.getDefinitionAndBoundSpan(
        fileName,
        position
      );

      // TODO: handle more data types like Custom Labels, Custom Permissions, etc...

      // find any
      output?.definitions
        ?.filter((def) =>
          moduleRegistryCache.get(sfdxProjectRoot)?.includes(def.fileName)
        )
        .forEach((def) => {
          let targetMethodName = def.name;
          if (def.kind === "module") {
            targetMethodName = def.name.replaceAll('"', "").split(".")[1];
          }
          const text = readFile(def.fileName);
          if (!text) {
            return;
          }
          const tree = prsr.parse(text);
          // build query to find all top-level method names
          const qry = prsr
            .getLanguage()
            .query(
              `(parser_output (class_declaration (class_body (method_declaration name: (identifier) @method_name))))`
            );
          // search the parsed file using the above query
          const captures = qry.captures(tree.rootNode);
          // for each found element, see if the method name matches our target
          const targetMethodCap = captures.find((cap) => {
            if (cap.node.text !== targetMethodName) {
              return false;
            }
            if (!cap.node.parent) {
              return false;
            }
            // ensure this method is AuraEnabled
            const modifiersNode = cap.node.parent.namedChildren.find(
              (c) => c.type === "modifiers"
            );
            if (!modifiersNode) {
              return false;
            }
            return modifiersNode.namedChildren.some(
              (c) =>
                c.childForFieldName("name")?.text.toLowerCase() ===
                "auraenabled"
            );
          });
          const node = targetMethodCap?.node;
          if (node) {
            def.textSpan.start = node.startIndex ?? 0;
            def.textSpan.length = (node.endIndex ?? 0) - (node.startIndex ?? 0);
            const parentNode = node.parent;
            if (parentNode) {
              if (!def.contextSpan) {
                def.contextSpan = {
                  start: 0,
                  length: 0,
                };
              }
              def.contextSpan.start = parentNode.startIndex ?? 0;
              def.contextSpan.length =
                (parentNode.endIndex ?? 0) - (parentNode.startIndex ?? 0);
            }
          }
        });

      return output;
    };

    // decorate with stuff when we need it
    return proxy;
  }
  function findSfdxRoot(project: ts.server.Project) {
    const normalizedDir = project.getCurrentDirectory();
    const parts = normalizedDir.split("/"); // TODO: do better
    while (parts.length > 0) {
      const newPath = parts.join("/") + "/sfdx-project.json"; // TODO: do better
      if (project.projectService.host.fileExists(newPath)) {
        return parts.join("/");
      }
      parts.pop();
    }
    return undefined;
  }

  function addComponentPaths(
    project: ts.server.Project,
    sfdxProjectRoot: string
  ) {
    const config = project.getCompilerOptions();
    if (!config.paths) {
      config.paths = {};
    }

    if (lwcRegistryCache.get(sfdxProjectRoot) === undefined) {
      buildRegistryCache(project, sfdxProjectRoot);
    }

    // find all the LWC components and add "paths" aliases so the lang server understands what `c/component` patterns refer to
    for (let comp of lwcRegistryCache.get(sfdxProjectRoot) ?? []) {
      // extract the component name from the javascript file name
      // if we can't find it or if it is already setup then move on
      const compName = comp.split("/").pop()?.split(".")[0];
      // limit to only root JS files

      if (
        !compName ||
        !!config.paths[compName] ||
        !comp.includes(`/${compName}/${compName}.js`)
      ) {
        continue;
      }
      // use the configs "paths" property to build an alias for the component file
      config.paths[`c/${compName}`] = [comp];
    }
  }

  return { create, getExternalFiles };
}

export = init;
