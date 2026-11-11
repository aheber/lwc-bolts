# @lwc-bolts/sf-plugin

A Salesforce CLI plugin that sets an SFDX project's `jsconfig.json` or `tsconfig.json` files up for the [content mapper](../typescript-content-mapper) (TypeScript 7), keeps them set up, and changes the mapper's options. It does what the [VS Code extension](../vscode-extension) does, with the same code ([`@lwc-bolts/project-setup`](../project-setup)), for other editors and for scripts.

```sh
sf plugins install @lwc-bolts/sf-plugin
```

Every command works on the SFDX project the current folder is in (the nearest folder with an `sfdx-project.json`), or the one `--project-dir` is in. Each takes `--json` except `watch`.

## `sf lwc-bolts project setup`

Writes the configuration the mapper's README describes:

- The project config, the one TypeScript project for the whole SFDX project, in the `lwc` folder of the default package directory. Its `include` lists each of `sfdx-project.json`'s `packageDirectories`, and it registers the mapper in `contentMappers`. An existing project config is checked against the same policy as `watch` uses, and keeps its other settings: only what the policy blocks is removed and what it enforces added, and it's moved to the file its `lwcConfigFile` option names.
- A config in every other `lwc` folder with no files of its own that references the project config. An existing one, `jsconfig.json` (such as the Salesforce extensions') or `tsconfig.json`, only changes in the parts that make the folder a project of its own, and loses the compiler options known to break the mapper (`baseUrl`, `paths` and `experimentalDecorators`).
- `.sfdx/typings/lwc/lightning.d.ts`, which imports `@salesforce/lightning-types` and is in the project config's `include`, once that package is installed. Until it is, setup recommends `npm install --save-dev @salesforce/lightning-types`, after which you run it again.

It fails without changing anything unless TypeScript 7.1 or later is available, naming the path it tested and the package to install (`typescript@7.1.0-beta`). It tests the TypeScript installed in the project or, only when it has none, the global `tsc`. It reports what it still needs, such as `@lwc-bolts/typescript-content-mapper` installed in the project. It's safe to run again: it only changes what's out of date. Unlike the VS Code extension, it doesn't change editor settings.

## `sf lwc-bolts project watch`

Checks the project's configs now, and whenever `sfdx-project.json` or an `lwc` folder's config changes, until you press Ctrl+C:

- Each config is checked against a policy: a block list of what breaks the mapper (`baseUrl`, `paths` and `experimentalDecorators`, the `include` entries the Salesforce extensions' template adds, and entries for package directories that are gone) and an enforce list of what it needs (an `include` entry for each of `packageDirectories`, the typings, the mapper's `contentMappers` entry; in the other `lwc` folders, empty `files` and `include` and a reference to the project config). A config that doesn't conform gets just those changes, logged, and keeps the rest. That undoes what the Salesforce extensions merge into each `lwc` folder's `jsconfig.json` when they start, and keeps `include` in step when `packageDirectories` change.
- It writes the config for a new package directory's `lwc` folder.
- It writes `.sfdx/typings/lwc/lightning.d.ts`, which imports `@salesforce/lightning-types`, when the package is installed and the file is missing.

If something rewrites a file more than five times in a minute, it stops restoring that file and warns, rather than fight over it. A project that isn't set up is reported, and picked up once it is. The VS Code extension does the same while it runs, so there's no need for both.

## `sf lwc-bolts project options`

The mapper's options are the `options` of its `contentMappers` entry in the project config. These commands keep the rest of the file, including comments and formatting.

- `display` shows each option, and whether the project config sets it or the mapper uses its default.
- `set name=value ...` writes the options you pass, and leaves the others. The names are the mapper's [options](../typescript-content-mapper/README.md#options). A value is read as JSON when it is JSON (`true`, `null`, `["CustomLabel"]`, `"quoted"`), and otherwise as text: a comma-separated list for a list option such as `disabledMetadataTypes` (it replaces the list; leave it empty for none), or a string for the others. The options are validated as the mapper validates them, and nothing is written if any is invalid.
- `unset --option <name>` removes options, so the mapper uses their defaults.

Changing `lwcConfigFile` sets the project up again with that file: the project config moves there, and the other `lwc` folders get one that references it.

```sh
sf lwc-bolts project options set apexNamespace=Acme.Apex inaccessibleApexProperties=exclude
sf lwc-bolts project options set disabledMetadataTypes=CustomLabel,CustomPermission suppressDiagnosticsExtensions=.cls
sf lwc-bolts project options unset --option apexNamespace
```

## `sf lwc-bolts project managed retrieve`

Caches installed packages' metadata from an org in the project, so the content mapper declares it: `@salesforce/schema/dlrs__Log__c.dlrs__Error__c`, `@salesforce/resourceUrl/dlrs__logo`, `dlrs/manageRollups` and so on. The org is `--target-org`, or the CLI's default. Every namespace other than the org's own (from its Organization record, or the CLI's record of it) is cached, or only the ones `--namespace` names.

- Each namespace gets a folder in the cache folder, `managed-apps` by default (`--output-dir`), named as the Metadata API names managed metadata (`dlrs/classes/dlrs__RollupService.cls`, `dlrs/lwc/dlrs__manageRollups`). Each run replaces the folders of the namespaces it caches, and points out folders of namespaces the org no longer has. The cache folder must be outside the package directories, so deploys leave it alone.
- The cache folder is added to the project config's `include`, and each cached `lwc` folder gets a config that references the project config, so a cached component opens in the project.
- It caches the types the content mapper reads, except the ones the project's `disabledMetadataTypes` option turns off. It doesn't retrieve metadata: it queries the org's setup objects, which cover every namespace at once, and writes the metadata files the mapper reads, with only the elements it reads.

The org hides most of a package's source, so what's cached is what LWC outside the package can use:

| Type | Queried from | Notes |
| --- | --- | --- |
| Apex classes | `ApexClass` | A global class's body is the declarations of its global members, which the mapper declares (`Apex.dlrs.RollupService`). Other classes' bodies are `(hidden)`, and they're left out; LWC can't import them anyway. `@salesforce/apex/ns.Class.method` imports need a method that's global and `@AuraEnabled`. |
| Components | Tooling `LightningComponentBundle` | Every file of a managed component is hidden, its `.js-meta.xml` too. Only exposed components can be used outside their package, so those are cached as stubs: their `.js-meta.xml` (label, description, targets) and a module whose `@api` properties are the ones their target configs name. Their other properties, methods, events and slots are unknown. |
| Objects | Tooling `CustomObject` and `EntityDefinition` | Their label, description and sharing model. |
| Fields | Tooling `CustomField` and `FieldDefinition` | The package's fields, on its objects and on others (such as `Account`): label, type, description, help text, rollup operation and reference. A lookup's child relationship name is only in its metadata, which the Tooling API returns one field at a time. |
| Labels | Tooling `ExternalString` | A package's protected labels can't be used outside it, and aren't cached. |
| Custom permissions | `CustomPermission` | |
| Message channels | Tooling `LightningMessageChannel` and `LightningMessageField` | |
| Static resources | `StaticResource` | With an empty content file, as the mapper only reads the `-meta.xml`; their content can be large, or JavaScript that TypeScript would check. |
| Content assets | `ContentAsset` | With an empty content file. |

These setup objects describe every object and field, whatever the running user can access, unlike describes and "SFDX: Refresh SObject Definitions". Standard fields (`Name`) and relationship paths come from the SObject definitions, as for the project's own objects, so they're only there for objects the user can access.

It reports what it cached for each namespace, and what it left out. The work is `cacheManagedMetadata` in [`@lwc-bolts/project-setup/managed`](../project-setup), which an editor command can use too.

```sh
sf lwc-bolts project managed retrieve --target-org my-org
sf lwc-bolts project managed retrieve --namespace dlrs --output-dir managed-cache
```

## Development

`npm run build -w @lwc-bolts/sf-plugin` builds it, with the packages it uses. `node packages/sf-plugin/bin/run.js lwc-bolts project setup` runs a command without the Salesforce CLI, and `sf plugins link packages/sf-plugin --no-install` runs it in the CLI. `npm test -w @lwc-bolts/sf-plugin` runs the tests, which check that its option defaults match the mapper's.

`@lwc-bolts/project-setup` and `@lwc-bolts/sfdx-project` are private for now, so the plugin can't be published until they are.
