import { readFileSync } from "node:fs";
import path from "node:path";
import { isSupportedType, parseOptions, type MapperOptions } from "./options.ts";
import {
  bundleApiVersion,
  defaultExportName,
  MetadataType,
  type Component,
  type LightningComponentBundleComponent,
} from "@lwc-bolts/sf2ts";
import { findSfdxRoot, SfdxProject } from "@lwc-bolts/sfdx-project";
import { emptyResult, ignoreDiagnostics, transformComponent, type Convert } from "./transform.ts";
import type {
  CloseProjectParams,
  InitializeParams,
  InitializeResult,
  OpenProjectParams,
  OpenProjectResult,
  PositionEncoding,
  TransformParams,
  TransformResult,
} from "./protocol.ts";

export const DIAGNOSTIC_SOURCE = "lwc-bolts";

/** Signals a JSON-RPC error with a specific code. */
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const RpcErrorCode = {
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

interface ProjectState {
  /** The validated `options` of the project's `contentMappers` entry. */
  options: MapperOptions;
  /** The SFDX project containing the tsconfig, if any. */
  sfdx: SfdxProject | undefined;
  /** For inferred projects (no tsconfig), SFDX projects discovered from transformed files' locations. */
  inferred: Map<string, Promise<SfdxProject | undefined>> | undefined;
}

/** Protocol state and request handling, independent of the transport. */
export class ContentMapper {
  #encoding: PositionEncoding | undefined;
  readonly #projects = new Map<string, ProjectState>();
  readonly #convert: Convert | undefined;

  /** @param convert converts the components, sf2ts's `convert` by default */
  constructor({ convert }: { convert?: Convert } = {}) {
    this.#convert = convert;
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params as InitializeParams);
      case "openProject":
        return this.openProject(params as OpenProjectParams);
      case "transform":
        return this.transform(params as TransformParams);
      case "closeProject":
        return this.closeProject(params as CloseProjectParams);
      default:
        throw new RpcError(RpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  initialize(params: InitializeParams): InitializeResult {
    const encodings = params?.positionEncodings ?? [];
    // sf2ts positions are JavaScript string offsets, so UTF-16 avoids any conversion.
    if (encodings.includes("utf-16")) {
      this.#encoding = "utf-16";
    } else if (encodings.includes("utf-8")) {
      this.#encoding = "utf-8";
    } else {
      throw new RpcError(RpcErrorCode.InvalidParams, "The host supports neither UTF-16 nor UTF-8 positions");
    }
    return {
      ...(params.protocolVersion !== undefined && { protocolVersion: params.protocolVersion }),
      positionEncoding: this.#encoding,
      diagnosticSource: DIAGNOSTIC_SOURCE,
    };
  }

  async openProject(params: OpenProjectParams): Promise<OpenProjectResult> {
    if (typeof params?.projectHandle !== "string" || typeof params.configFileName !== "string") {
      throw new RpcError(RpcErrorCode.InvalidParams, "openProject requires string configFileName and projectHandle");
    }
    // TypeScript includes `options` in the mapper's transform identity, so they needn't be in configIdentity.
    const { options, diagnostics } = parseOptions(params.options);
    const optionDiagnostics = diagnostics.length > 0 ? { optionDiagnostics: diagnostics } : {};
    if (params.configFileName === "") {
      this.#projects.set(params.projectHandle, { options, sfdx: undefined, inferred: new Map() });
      // Inferred projects discover SFDX projects per file, so there is no single configuration to watch.
      return { configIdentity: "inferred", ...optionDiagnostics };
    }
    const root = findSfdxRoot(path.dirname(params.configFileName));
    const sfdx = root === undefined ? undefined : await SfdxProject.load(root, { respectForceIgnore: options.respectForceIgnore });
    this.#projects.set(params.projectHandle, { options, sfdx, inferred: undefined });
    if (sfdx === undefined) {
      return { configIdentity: "no-sfdx-project", ...optionDiagnostics };
    }
    return { configIdentity: sfdx.identity, watchedFiles: sfdx.watchedFiles, ...optionDiagnostics };
  }

  async transform(params: TransformParams): Promise<TransformResult> {
    if (typeof params?.fileName !== "string" || typeof params.content !== "string" || typeof params.projectHandle !== "string") {
      throw new RpcError(RpcErrorCode.InvalidParams, "transform requires string fileName, content, and projectHandle");
    }
    if (this.#encoding === undefined) {
      throw new RpcError(RpcErrorCode.InternalError, "The mapper has not been initialized");
    }
    const project = this.#projects.get(params.projectHandle);
    if (project === undefined) {
      throw new RpcError(RpcErrorCode.InvalidParams, `Project has not been opened: ${params.projectHandle}`);
    }
    const sfdx = project.inferred ? await inferSfdxProject(project.inferred, params.fileName, project.options) : project.sfdx;
    const resolved = sfdx === undefined ? undefined : resolveComponent(sfdx, params.fileName, params.content);
    if (resolved === undefined || project.options.disabledMetadataTypes.has(resolved.component.type)) {
      return emptyResult();
    }
    const options = {
      apexNamespace: project.options.apexNamespace,
      inaccessibleApexProperties: project.options.inaccessibleApexProperties,
      ...(sfdx!.namespace !== undefined && { projectNamespace: sfdx!.namespace }),
    };
    const result = await transformComponent(await withProjectFacts(sfdx!, resolved), this.#encoding, options, this.#convert);
    const fileName = params.fileName.toLowerCase();
    const suppressed = project.options.suppressDiagnosticsExtensions.some((extension) => fileName.endsWith(extension));
    return suppressed ? ignoreDiagnostics(result, params.content, this.#encoding) : result;
  }

  closeProject(params: CloseProjectParams): null {
    this.#projects.delete(params?.projectHandle);
    return null;
  }
}

/** A file sf2ts converts, and for a template, its bundle's folder, as SDR resolves it. */
interface ResolvedComponent {
  component: Component;
  bundle?: string;
}

/**
 * A component with what sf2ts needs to know from the project's other files, which it doesn't read itself:
 * an SObject definition's polymorphic relationships, and a bundle file's facts about its bundle.
 */
async function withProjectFacts(sfdx: SfdxProject, { component, bundle }: ResolvedComponent): Promise<Component> {
  if (component.type === MetadataType.ApexClass && component.isSobject) {
    return { ...component, ...sfdx.polymorphicRelationships(component.path) };
  }
  if (component.type === MetadataType.LightningComponentBundle) {
    return withBundleFacts(sfdx, component, bundle);
  }
  return component;
}

/**
 * Inspect and resolve a metadata file to it's type, category, and relevant related data
 */
function resolveComponent(sfdx: SfdxProject, fileName: string, content: string): ResolvedComponent | undefined {
  if (/\.html$/i.test(fileName)) {
    const bundle = sfdx.componentBundle(fileName);
    if (bundle === undefined) {
      return undefined;
    }
    const component: LightningComponentBundleComponent = {
      path: fileName,
      type: MetadataType.LightningComponentBundle,
      content,
      bundleName: path.basename(bundle),
      componentModule: templateComponentModule(fileName, bundle),
    };
    return { component, bundle };
  }
  if (sfdx.isSObjectDefinition(fileName)) {
    return { component: { path: fileName, type: MetadataType.ApexClass, content, isSobject: true } };
  }
  const type = sfdx.resolveType(fileName, isSupportedType) as MetadataType | undefined;
  return type === undefined ? undefined : { component: { path: fileName, type, content } };
}

/**
 * The module specifier a template imports its component through: the bundle's `<bundle>.js`
 */
export function templateComponentModule(fileName: string, bundleDir: string): string {
  const component = path.join(bundleDir, `${path.basename(bundleDir)}.js`);
  const relative = path.relative(path.dirname(fileName), component).split(path.sep).join("/");
  return relative.startsWith("../") ? relative : `./${relative}`;
}

/**
 * Enriched with what sf2ts needs to know about the rest of a component's bundle
 */
export async function withBundleFacts(
  sfdx: SfdxProject,
  component: LightningComponentBundleComponent,
  bundle = path.dirname(component.path),
): Promise<LightningComponentBundleComponent> {
  if (/\.html$/i.test(component.path)) {
    const metadata = readText(path.join(bundle, `${path.basename(bundle)}.js-meta.xml`));
    const apiVersion = metadata === undefined ? undefined : await bundleApiVersion(metadata);
    const templates = sfdx.componentTemplates(bundle);
    return {
      ...component,
      ...(apiVersion !== undefined && { apiVersion }),
      ...(templates !== undefined && { alternateTemplates: templates.length > 1 }),
    };
  }
  if (/\.js-meta\.xml$/i.test(component.path)) {
    const module = sfdx.findComponentModule(path.basename(bundle), path.dirname(bundle));
    const source = module === undefined ? undefined : readText(module);
    const exported = source === undefined ? undefined : await defaultExportName(source);
    return { ...component, ...(exported !== undefined && { defaultExportName: exported }) };
  }
  return component;
}

/** A file's text, or undefined when it can't be read (such as one that's been deleted). */
function readText(fileName: string): string | undefined {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}

function inferSfdxProject(
  cache: Map<string, Promise<SfdxProject | undefined>>,
  fileName: string,
  options: MapperOptions,
): Promise<SfdxProject | undefined> {
  const root = findSfdxRoot(path.dirname(fileName));
  if (root === undefined) {
    return Promise.resolve(undefined);
  }
  let project = cache.get(root);
  if (project === undefined) {
    project = SfdxProject.load(root, { respectForceIgnore: options.respectForceIgnore });
    cache.set(root, project);
  }
  return project;
}
