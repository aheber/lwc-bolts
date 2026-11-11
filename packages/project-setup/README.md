# @lwc-bolts/project-setup

Sets up an SFDX project's TypeScript configuration for the [content mapper](../typescript-content-mapper) (TypeScript 7.1+), and keeps it in step with `sfdx-project.json`:

- `projectConfigFolder` picks the `lwc` folder for the project config, the one TypeScript project for the whole SFDX project: the default package directory's (from `readDefaultPackageDirectory`), or the first with one. `createProjectConfig(folder, root, packageDirectories, lwcConfigFile?)` writes it, registering the mapper, and `findProjectConfig` finds an existing one, the `lwc` folder config that registers the mapper (in sfdx-project.json's package directories, unless given others).
- `projectConfigPolicy(folder, root, file, packageDirectories)` and `lwcFolderPolicy(lwcFolder, configPath, existing?)` are the policies the configs are kept to: a `block` list of what breaks the mapper (`baseUrl`, `paths`, `experimentalDecorators`, the Salesforce extensions' `include` entries, entries for package directories that are gone) and an `enforce` list of what it needs, with the project's package directories and the reference to the project config merged in. `checkConfig(text, policy)` lists where a config doesn't conform, and `conformConfig(text, policy)` applies just those changes, keeping comments, formatting and everything else. `asJsconfig` moves a project config to a `jsconfig.json`, and `isStrictJson` checks a `jsconfig.json` is one the Salesforce extensions can read.
- `addContentMapper` registers or updates the mapper configuration.
- `lwcConfigFile` reads which file each `lwc` folder references it from, the mapper's `lwcConfigFile` option: `jsconfig.json` (the default) or `tsconfig.json`.
- `lwcFolderConfig` writes the solution-style config that references the project config, in the file `lwcConfigFile` names, or brings an existing `jsconfig.json` or `tsconfig.json` into line with `lwcFolderPolicy`.

It also plans whole changes from the files, without writing any, so a caller can ask first:

- `planSetup` investigates a project and reports the changes it needs, or why it can't be set up.
- `applySetup` commits those changes.
- `planMaintenance` checks a set-up project's configs against their policies, which includes keeping `include` in step with `packageDirectories`. It plans just the changes for each config that doesn't conform (each write's `changes` says what), a config for a new package directory's `lwc` folder, and the import of `@salesforce/lightning-types` once it's installed. `writeFiles` writes these.
- `contentMapperOptions` reads the mapper's `options`, and `setContentMapperOptions` sets or removes them, keeping the rest of the file. `addInclude` adds a folder of the project's own, such as a cache of installed packages' metadata, to `include`.

The VS Code extension and the sf plugin share these too:

- `missingPackages` lists what the project still needs installed (`npm install` names): the mapper, and `TYPESCRIPT_PACKAGE` (if updated version is needed). `recommendedPackages` lists what it's better off with but doesn't need: `LIGHTNING_TYPES_PACKAGE`.
- `installedVersion` reads an installed package's version, resolved from the project.
- `RewriteLimiter` stops restoring a config once something keeps rewriting it (`MAX_REWRITES` times within `REWRITE_WINDOW`), so a caller restoring what `planMaintenance` plans doesn't fight over it.

How a config registers the mapper, `CONTENT_MAPPER_PACKAGE` and `CONTENT_MAPPER_EXTENSIONS`, and the files the `lwcConfigFile` option can name, `LWC_CONFIG_FILES` and `DEFAULT_LWC_CONFIG_FILE`, are this package's: it writes them. It doesn't depend on the mapper, so it keeps its own copy of the config file names, which the tests check against the mapper's options (`@lwc-bolts/typescript-content-mapper/options`), along with the mapper's package name and the metadata types the managed cache has.

## Installed packages' metadata

`@lwc-bolts/project-setup/managed` caches installed packages' metadata from an org in the project, so the content mapper can make it part of the type checking. `cacheManagedMetadata(root, connection, options)` does it all:

- It queries the org's setup objects (`ApexClass`, the Tooling API's `CustomObject`, `CustomField`, `FieldDefinition` and so on) for every namespace but the org's own (`orgNamespaces`), or only `options.namespaces`. A query that fails is reported in `failures`, and the others' metadata is still cached.
- It writes them as the metadata files the mapper reads, with the Metadata API's names, in a folder for each namespace in the cache folder (`options.outputDir`, `managed-apps` by default). Each namespace's folder is replaced.
- Each cached `lwc` folder gets a config that references the project config, and the cache is added to the overall project config's `include` (`addInclude`).

It returns what it cached and left out for each namespace, for the caller to report. The connection is anything with the data and Tooling APIs' `query`, such as the Salesforce CLI's (`Org.getConnection()`). It throws a `CacheError` when the project isn't set up or the cache folder can't be used: it must be in the project, outside its package directories. The query and item functions it's made of (`managedClasses`, `managedSchema`, `writeItems` and so on) are exported too.

It has no editor dependency: the [VS Code extension](../vscode-extension)'s commands and the [sf plugin](../sf-plugin) use it.
