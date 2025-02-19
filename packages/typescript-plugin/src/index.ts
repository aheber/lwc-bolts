import type ts from "typescript/lib/tsserverlibrary.js";
import {
  ComponentSet,
  MetadataResolver,
  RegistryAccess,
} from "@salesforce/source-deploy-retrieve";
import type { SourceComponent } from "@salesforce/source-deploy-retrieve";
import { convert, MapPair, MetadataType } from "@lwc-bolts/sf2ts";

/* TODO:
// should figure out how to watch files for saves and refresh (should be able to lean on tsserver)
 */

let moduleRegistryCache = new Map<string, string[]>();
let lwcRegistryCache = new Map<string, string[]>();
let mdtFileCache = new Map<string, ReturnType<typeof convert>>();
let rslvrCache = new Map<string, MetadataResolver>();
let regAccessCache = new Map<string, RegistryAccess>();

function init(modules: { typescript: typeof ts }): ts.server.PluginModule {
  // let the TS server know about all of our "external" modules that can be imported from Metadata
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

  function getRegistryAccess(sfdxProjectRoot: string) {
    let registryAccess = regAccessCache.get(sfdxProjectRoot);
    if (!registryAccess) {
      registryAccess = new RegistryAccess(undefined, sfdxProjectRoot);
      regAccessCache.set(sfdxProjectRoot, registryAccess);
    }
    return registryAccess;
  }

  function getMetadataResolvr(sfdxProjectRoot: string) {
    const registryAccess = getRegistryAccess(sfdxProjectRoot);
    let rslvr = rslvrCache.get(sfdxProjectRoot);
    if (!rslvr) {
      rslvr = new MetadataResolver(registryAccess);
      rslvrCache.set(sfdxProjectRoot, rslvr);
    }
    return rslvr;
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
      let registryAccess = getRegistryAccess(sfdxProjectRoot);

      const compSet = ComponentSet.fromSource({
        fsPaths: sfdxProjectContent.packageDirectories.map(
          (d: { path: string; default?: boolean }) =>
            `${sfdxProjectRoot}/${d.path}`
        ),
        registry: registryAccess,
      }).filter(({ type }) =>
        [
          ...Object.keys(MetadataType),
          "LightningComponentBundle", // not transformed but we still need to grab component types to pre-register them
        ].includes(type.name)
      );

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
          .filter(({ type }) => MetadataType.hasOwnProperty(type.name))
          .toArray()
          .map((c) => {
            return (c as unknown as SourceComponent).xml ?? "";
          })
      );

      const rslvr = getMetadataResolvr(sfdxProjectRoot);
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

    // Diagnostic logging
    info.project.projectService.logger.info(
      "I'm getting set up now! Check the log for this message."
    );

    const rslvr = getMetadataResolvr(sfdxProjectRoot);

    const readFile = info.project.projectService.host.readFile;
    info.project.projectService.host.readFile = (
      path: string,
      encoding?: string | undefined
    ) => {
      let mdtType: string = "";
      if (path.startsWith(sfdxProjectRoot)) {
        try {
          const comps = rslvr.getComponentsFromPath(path);
          for (let comp of comps) {
            if (MetadataType.hasOwnProperty(comp.type.name)) {
              mdtType = comps[0].type.name;
            }
          }
        } catch (error) {
          // TODO: log error
          console.error(error);
        }
      }
      if (mdtType.length > 0) {
        const text = readFile(path);
        if (text != undefined) {
          try {
            const cnvtdComp = convert([
              { path, type: mdtType as any, content: text },
            ]);
            mdtFileCache.set(path, cnvtdComp);
            return cnvtdComp[0].declarationContent;
          } catch (error) {
            // a failure to parse the file because we're waiting for async tasks to finish
            // the error includes a promise handle that we can attach to
            if ((error as any).waitFor) {
              (error as any).waitFor.then(() => {
                const pathInfo =
                  info.project.projectService.getScriptInfo(path);
                pathInfo?.reloadFromFile();
                info.project.refreshDiagnostics();
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
        ?.filter((def) => mdtFileCache.has(def.fileName))
        .forEach((def) => {
          const cmpntList = mdtFileCache.get(def.fileName);
          if (!cmpntList || cmpntList.length == 0) {
            return;
          }
          const cmpnt = cmpntList[0];

          const index = cmpnt.mapData.findIndex(
            (m: MapPair) => m.destPos == def.textSpan.start
          );
          if (cmpnt.mapData.length > index) {
            const start = cmpnt.mapData[index];
            const end = cmpnt.mapData[index + 1];
            def.textSpan.start = start.sourcePos;
            def.textSpan.length = end.sourcePos - start.sourcePos;
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
