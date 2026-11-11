import {
  cacheManagedMetadata,
  CacheError,
  DEFAULT_OUTPUT_DIR,
  orgNamespaces,
  type CachedType,
  type NamespaceReport,
} from "@lwc-bolts/project-setup/managed";
import { Org, SfError } from "@salesforce/core";
import { Flags, SfCommand } from "@salesforce/sf-plugins-core";
import { projectDirFlag, relative, resolveRoot, SETUP_COMMAND } from "../../../../project.ts";

export interface ManagedRetrieveResult {
  readonly org: string;
  /** The org's own namespaces, whose metadata isn't cached. */
  readonly orgNamespaces: string[];
  /** The cache folder, relative to the project. */
  readonly outputDir: string;
  readonly namespaces: NamespaceReport[];
  /** The cached `lwc` folders' configs, which reference the project config. */
  readonly lwcConfigs: string[];
  /** Whether the cache was added to the project config's `include`. */
  readonly included: boolean;
  readonly warnings: string[];
}

/** The columns of the summary table: cached types, by the name the table shows. */
const COLUMNS: Readonly<Record<string, CachedType>> = {
  "Apex classes": "ApexClass",
  Components: "LightningComponentBundle",
  Objects: "CustomObject",
  Fields: "CustomField",
  Labels: "CustomLabels",
  Resources: "StaticResource",
  Assets: "ContentAsset",
  Channels: "LightningMessageChannel",
  Permissions: "CustomPermission",
};

/** What the command uses from @lwc-bolts/project-setup/managed to query the org and write the cache. */
export interface ManagedCache {
  readonly orgNamespaces: typeof orgNamespaces;
  readonly cacheManagedMetadata: typeof cacheManagedMetadata;
}

export default class ProjectManagedRetrieve extends SfCommand<ManagedRetrieveResult> {
  /** Queries the org and writes the cache; tests replace it. */
  public static managed: ManagedCache = { orgNamespaces, cacheManagedMetadata };
  public static readonly summary = "Cache installed packages' metadata from an org in the project, for the content mapper.";
  public static readonly description =
    "Caches the metadata of every namespace other than the org's own that the content mapper reads, except the types the project's " +
    "disabledMetadataTypes option turns off, in a folder for each namespace in the cache folder, which is added to the project config's include. " +
    "Each run replaces the namespaces' folders. " +
    "It queries the org's setup objects rather than retrieving metadata, and writes the metadata files the mapper reads from what they describe. " +
    "The org hides most managed source: Apex classes are hidden unless they're global, so only global ones are cached, as the declarations of their global members. " +
    "Components are hidden too, so exposed components are cached as stubs with only their name, targets and the properties their target configs name. " +
    "Components that aren't exposed and protected labels can't be used outside their package, so they aren't cached. " +
    "Each cached lwc folder gets a config that references the project config, so its components open in the project.";
  public static readonly examples = [
    "Cache the installed packages of the default org:\n<%= config.bin %> <%= command.id %>",
    "Cache only the dlrs package from another org, into another folder:\n<%= config.bin %> <%= command.id %> --target-org my-org --namespace dlrs --output-dir managed-cache",
  ];
  public static readonly flags = {
    "target-org": Flags.requiredOrg(),
    "api-version": Flags.orgApiVersion(),
    "project-dir": projectDirFlag,
    "output-dir": Flags.string({
      char: "r",
      summary: "The cache folder, relative to the project. It must be outside the package directories, so deploys leave it alone.",
      default: DEFAULT_OUTPUT_DIR,
    }),
    namespace: Flags.string({
      char: "n",
      summary: "Only cache this namespace; pass it once for each namespace. Other namespaces' folders are left as they are.",
      multiple: true,
    }),
  };

  public async run(): Promise<ManagedRetrieveResult> {
    const { flags } = await this.parse(ProjectManagedRetrieve);
    const { orgNamespaces, cacheManagedMetadata } = ProjectManagedRetrieve.managed;
    const root = resolveRoot(flags["project-dir"]);
    const org = flags["target-org"];
    const conn = org.getConnection(flags["api-version"]);
    const username = org.getUsername() ?? org.getOrgId();

    this.spinner.start(`Querying the installed packages' metadata in ${username}`);
    let result;
    let own;
    try {
      own = await orgNamespaces(conn, org.getField<string | undefined>(Org.Fields.NAMESPACE_PREFIX));
      result = await cacheManagedMetadata(root, conn, {
        outputDir: flags["output-dir"],
        ...(flags.namespace && { namespaces: flags.namespace }),
        orgNamespaces: own,
        onProgress: (what) => (this.spinner.status = what),
      });
    } catch (error) {
      if (error instanceof CacheError) {
        throw new SfError(error.message, error.code, error.code === "NotSetUp" ? [`Run "${SETUP_COMMAND}".`] : undefined);
      }
      throw error;
    } finally {
      this.spinner.stop();
    }

    const outputDir = relative(root, result.outputDir);
    const warnings = result.failures.map(({ what, message }) => `Unable to query the installed packages' ${what}: ${message}`);
    const stale = result.staleNamespaces;
    if (stale.length > 0) {
      warnings.push(
        `${username} has no metadata the content mapper reads in ${stale.join(", ")}, which ${outputDir} still caches. Remove ${stale.length === 1 ? "its folder" : "their folders"} if ${stale.length === 1 ? "the package is" : "the packages are"} uninstalled.`,
      );
    }

    const reports = result.namespaces;
    this.log(
      `Cached ${reports.length === 0 ? "no namespaces" : reports.map((report) => report.namespace).join(", ")} from ${username}` +
        `${own.size > 0 ? ` (its own namespace, ${[...own].join(", ")}, isn't cached)` : ""} in ${outputDir}.`,
    );
    if (reports.length > 0) {
      this.table({
        data: reports.map((report) => ({
          namespace: report.namespace,
          ...Object.fromEntries(Object.entries(COLUMNS).map(([column, type]) => [column, report.cached[type] ?? 0])),
        })),
      });
    }
    const left = reports.flatMap((report) => report.leftOut.map(({ what, count }) => `${report.namespace}: ${count} ${what}`));
    if (left.length > 0) {
      this.info(`Left out what LWC outside a package can't use:\n  ${left.join("\n  ")}`);
    }
    const stubs = reports.flatMap((report) => report.componentStubs);
    if (stubs.length > 0) {
      this.info(
        `Cached exposed components as stubs, as their source is hidden: only their names, targets and the properties their target configs name are known (${stubs.join(", ")}).`,
      );
    }
    if (result.included) {
      this.logSuccess(`Added ${outputDir} to ${relative(root, result.projectConfig)}'s include.`);
    }
    for (const warning of warnings) {
      this.warn(warning);
    }
    return {
      org: username,
      orgNamespaces: [...own],
      outputDir,
      namespaces: reports,
      lwcConfigs: result.lwcConfigs.map((file) => relative(root, file)),
      included: result.included,
      warnings,
    };
  }
}
