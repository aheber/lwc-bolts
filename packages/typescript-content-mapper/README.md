# @lwc-bolts/typescript-content-mapper

A [TypeScript content mapper](https://github.com/microsoft/typescript-go/pull/4712) (TypeScript 7.1+) that can be used to proxy Salesforce Metadata files and represent them as TypeScript to be used in Lightning Web Components.

Depends on
* [`@lwc-bolts/sf2ts`](https://www.npmjs.com/package/@lwc-bolts/sf2ts) converts each metadata file into ambient `declare module "@salesforce/..."` declarations.
* [`@salesforce/source-deploy-retrieve`](https://www.npmjs.com/package/@salesforce/source-deploy-retrieve) works out each file's metadata type when TS7 asks us to map it.

| Metadata | File | Module |
| --- | --- | --- |
| Apex `@AuraEnabled` methods | `*.cls` | `@salesforce/apex/Class.method`, `@salesforce/apexContinuation/Class.method` |
| Custom labels | `*.labels-meta.xml`, `*.label-meta.xml` (decomposed) | `@salesforce/label/c.Name` |
| Custom objects | `*.object-meta.xml` | `@salesforce/schema/Object__c`, and the `Apex.Object__c` record type (see [SObjects](#sobjects)) |
| Custom fields | `*.field-meta.xml` | `@salesforce/schema/Object__c.Field__c`, and the field on `Apex.Object__c` |
| Static resources | `*.resource-meta.xml` | `@salesforce/resourceUrl/name` |
| Content assets | `*.asset-meta.xml` | `@salesforce/contentAssetUrl/name` |
| Custom permissions | `*.customPermission-meta.xml` | `@salesforce/customPermission/Name` |
| Lightning message channels | `*.messageChannel-meta.xml` | `@salesforce/messageChannel/Name__c`, `@salesforce/messageChannel/c__Name__c` |
| Lightning web components | `*.js-meta.xml` | `c/name` path alias |
| LWC templates | `.html` files in an LWC bundle, including its subfolders | checks its bindings against the component (see [Templates](#templates)) |
| SObject definitions (generated) | `.sfdx/tools/sobjects/**/*.cls` | `Apex.<SObject>` types, no modules (see [SObjects](#sobjects)) |

## Usage

```sh
npm install --save-dev @lwc-bolts/typescript-content-mapper
```

Register the mapper in a `tsconfig.json` or `jsconfig.json` for `.cls`, `.xml`, and `.html` files in your project. Its `include` must cover your LWC components and the supporting metadata folders. The generated modules are ambient, so nothing imports the metadata files directly, and they only reach the program through `include`.

```jsonc
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true
  },
  "include": [
    "force-app/main/default/lwc",
    "force-app/main/default/classes",
    "force-app/main/default/labels",
    "force-app/main/default/objects",
    "force-app/main/default/staticresources",
    "force-app/main/default/contentassets",
    "force-app/main/default/customPermissions",
    "force-app/main/default/messageChannels"
  ],
  "contentMappers": [
    {
      "package": "@lwc-bolts/typescript-content-mapper",
      "extensions": [".cls", ".xml", ".html"]
    }
  ]
}
```

## Using TypeScript with a Content Mapper

### CLI
```sh
npx tsc --runExternalCode
```

### VS Code
In VS Code (TypeScript 7+), content mappers run only in trusted workspaces with content mappers enabled (`js/ts.contentMappers.enabled`).

## Project Context

The mapper finds the SFDX project by walking up from the tsconfig's directory to `sfdx-project.json`. Files outside that project are left empty. `sfdx-project.json` affects how files map to metadata types (for example `"sourceBehaviorOptions": ["decomposeCustomLabelsBeta2"]`), Files denied by the project's `.forceignore` also produce empty output, as they do for SDR's deploys and retrieves. Set [`respectForceIgnore`](#options) to `false` to include them like any other file.

The mapper declares `dynamicConfig` to the Typescript Language Server and reports a hash of `sfdx-project.json`, `.forceignore`, and of the SObject definitions' `typeNames.json` (see [SObjects](#sobjects)), as its `configIdentity`. It also asks TypeScript to watch them, including files that don't exist yet, which keeps the editor, `--watch`, `--build`, and `--incremental` up to date when they change. Only the project root's `.forceignore` is watched: SDR also applies one in a parent directory, but editing that one needs a TypeScript restart.

Like the plugin, the mapper only transforms a component's primary file: the `.cls` for Apex, and the `-meta.xml` for everything else. Companion files such as `.cls-meta.xml`, `.asset`, or static resource bodies produce empty output. So does any metadata type `sf2ts` doesn't support.

## SObjects

To improve your typings for an Org's SObject information, use the Salesforce VS Code extension's command **SFDX: Refresh SObject Definitions** which writes SObjects as an Apex class under `.sfdx/tools/sobjects/standardObjects` and `.sfdx/tools/sobjects/customObjects`. Add that folder to `include` and the mapper declares each one as an Apex type, so `List<Account>` in a `.cls` file resolves, and components see the fields of the SObjects that Apex returns:

```jsonc
"include": [
  "force-app",
  ".sfdx/tools/sobjects"
]
```

The definitions describe the org, not the project. A custom object or field that hasn't been deployed yet isn't in them until you deploy it and refresh the definitions; until then, the object and field metadata declare it. The extensions delete and rewrite the folder on each refresh, and TypeScript picks the changes up as it would any other file under `include`. A typical org has around 1,500 definitions, they add about half a second to `tsc`.

## Options

Set options in the mapper's `contentMappers` entry:

```jsonc
{
  "package": "@lwc-bolts/typescript-content-mapper",
  "extensions": [".cls", ".xml", ".html"],
  "options": {
    "apexNamespace": "Acme.Apex",
    "inaccessibleApexProperties": "exclude",
    "disabledMetadataTypes": ["CustomPermission", "ContentAsset"],
    "respectForceIgnore": false
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apexNamespace` | `"Apex"` | The namespace Apex classes are declared in, such as `Apex.File1`. It can be dotted (`"Acme.Apex"`). Set it to `null` to declare classes globally, as `File1`. A global class merges with any global type of the same name: an Apex class named `Response` merges with the DOM's `Response`, for example. |
| `inaccessibleApexProperties` | `"include as deprecated"` | What becomes of an Apex class's fields that LWC can't read (not `@AuraEnabled`, not `public` or `global`, or `static`). With `"include as deprecated"` they're declared, marked `@deprecated` with what they'd need, so editors flag code that reads them. Set it to `"include"` to declare them like any other field, or to `"exclude"` to leave them out, which makes reading one an error. SObject definitions' fields are always declared. |
| `disabledMetadataTypes` | `[]` | Salesforce metadata type names whose files produce empty output, so their `@salesforce/...` modules aren't declared. Supported types are `ApexClass`, `ContentAsset`, `CustomField`, `CustomLabel`, `CustomLabels`, `CustomObject`, `CustomPermission`, `LightningComponentBundle`, `LightningMessageChannel`, and `StaticResource`. Labels in a `CustomLabels` file and decomposed `CustomLabel` files are separate types, and so are `CustomObject` and `CustomField`. Disable both of a pair to turn off labels or schema imports entirely. |
| `respectForceIgnore` | `true` | Whether files the SFDX project's `.forceignore` denies are left out, as the Salesforce CLI leaves them out of deploys: they produce empty output, so a denied child's templates don't declare its slots, and content passed to it isn't checked. Set it to `false` to map them like any other file. Without it, SDR's default ignores (such as dot files) don't apply either. |
| `suppressDiagnosticsExtensions` | `[]` | File extensions, such as `[".cls"]`, whose files don't show TypeScript's errors, such as an Apex field's type the project doesn't declare. They're matched case-insensitively against the end of the file name, so compound extensions such as `".labels-meta.xml"` work too. The mapper returns an `Ignore` diagnostic directive covering a matching file's whole output. The mapper's own errors, such as `lwc-bolts1001`, still show. When it's empty, every error shows. |
| `lwcConfigFile` | `"jsconfig.json"` | The config file the `lwc` folders use, for the project config and the configs that reference it: `"jsconfig.json"` or `"tsconfig.json"` (see [Working with the Salesforce extensions](#working-with-the-salesforce-extensions)). The mapper only validates it: the [Lightning Bolts extension](../vscode-extension) reads it to know which file to write and keep, and moves the project config when it names the other file. |

TypeScript reports invalid options as `lwc-bolts` errors on the offending value in the tsconfig. An invalid value falls back to its default, so the rest of the project still type-checks.

| Code | Reported for |
| --- | --- |
| `lwc-bolts1101` | `options` isn't an object |
| `lwc-bolts1102` | an unknown option (reported on its value) |
| `lwc-bolts1103` | an `apexNamespace` that isn't a string or `null`, is empty, or isn't a dotted path of identifiers (reserved words such as `class` aren't allowed) |
| `lwc-bolts1104` | a `disabledMetadataTypes` that isn't an array, or an entry that isn't a string |
| `lwc-bolts1105` | a `disabledMetadataTypes` entry that isn't a supported type. Names are case-sensitive, and a name in the wrong case gets a suggestion |
| `lwc-bolts1106` | an `inaccessibleApexProperties` that isn't `"include"`, `"exclude"` or `"include as deprecated"` |
| `lwc-bolts1107` | a `respectForceIgnore` that isn't `true` or `false` |
| `lwc-bolts1108` | an `lwcConfigFile` that isn't `"jsconfig.json"` or `"tsconfig.json"` |
| `lwc-bolts1109` | a `suppressDiagnosticsExtensions` that isn't an array, or an entry that isn't a string starting with a dot |

TypeScript includes `options` in the mapper's cache identity, so changing them re-transforms the affected files in `--watch`, `--build`, and `--incremental`.

`@lwc-bolts/typescript-content-mapper/options` exports the options for tools that write them, such as the [sf plugin](../sf-plugin) and the [VS Code extension](../vscode-extension): their names and defaults (`OPTION_NAMES`, `OPTION_DEFAULTS`), the metadata types `disabledMetadataTypes` takes (`METADATA_TYPES`), and `parseOptions`, which validates an `options` object as the mapper does and returns the diagnostics above. It imports nothing at runtime, so loading it doesn't load the converters.

## How it works

- The mapper uses **UTF-16 positions** when the host offers them, because `sf2ts` offsets are JavaScript string indexes. Otherwise it falls back to UTF-8.
- **Output** is a `.ts` global script with no imports or exports, so its `declare module` blocks are ambient. It is never emitted.
- **Span mappings** come from the `sf2ts` `MapPair`s, read as consecutive start/end pairs. A mapping is `Verbatim` when the virtual and original text match. It is an `Alias` when the original is an API name that the virtual text is built from: `lblAustralia` and `"@salesforce/label/c.Australia"` from the label `Australia`, `Apex.Widget` from `Widget`, `string` from `String`. Anything else, such as a name mapped to a label or description (`hasTestPerm` from "Can do cool stuff!") or a type expression (`Apex.Account[]` from `List<Account>`), is an `Atom`. TypeScript treats `Alias` like `Atom`, except that it shows the original text in a diagnostic message when the diagnostic covers the whole span and quotes its virtual text.
- **Conversion failures** become a mapper diagnostic (`lwc-bolts1001`) on the file, and the file stays empty. An Apex file that declares no type, such as one with only comments, gets empty output and isn't treated as an error.
- **Debugging:** set `TS_CONTENT_MAPPER_DEBUG=1` to see the JSON-RPC traffic and the mapper's stderr.

## Known issues

- **Mixed-case extensions need the `.xml` registration** (see [Usage](#usage)) until TypeScript fixes `.customPermission-meta.xml` on case-insensitive file systems.
- **SObjects and other types `sf2ts` can't see are reported in the `.cls` files.** Apex types are declared in the global `Apex` namespace (see [`apexNamespace`](#options)), merged across files, so classes can reference each other. `sf2ts` converts one file at a time, though. A reference such as `List<Account>` becomes `Apex.Account[]`, and unless the project declares it, `tsc` reports `Namespace 'Apex' has no exported member 'Account'` on `List<Account>` in the `.cls` file.
- **`"module": "nodenext"` needs `"moduleDetection": "auto"`.** Under `nodenext`, TypeScript 7 treats the mapper's `.ts` output as module files, so each `declare module "..."` becomes an invalid augmentation (TS2664 "Invalid module name in augmentation"). Set `"moduleDetection": "auto"` in `compilerOptions`. The content mapper protocol doesn't allow `.d.ts` output, which TypeScript never treats as a module file this way.

### Working with the Salesforce extensions

The Salesforce Apex and LWC extensions write a `jsconfig.json` into each package's `lwc` folder, and rewrite it when they start. TypeScript 7 can't use what they write:

- `baseUrl` was removed (TS5102), and the `"paths": { "c/*": ["*"] }` they add is rejected without it (TS5090). The mapper declares the `c/` modules anyway (see [Component modules](#component-modules)).
- They replace the config with one for their package's `lwc` folder alone, so it would only see its own components and not the rest of the project's metadata.
- They include all of `.sfdx/typings/lwc`. That repeats the mapper's `@salesforce/...` modules with weaker (`any`) types.
- They include a generated `engine.d.ts` file. Its legacy decorators break `@api` and `@wire`, and its `WireAdapterConstructor` isn't generic. Salesforce provides significantly better types in the `@salesforce/lightning-types` npm package.

If you used the lwc-bolts VS Code extension or sf plugin then they can watch the config files and keep them correct.

## Development

This package is an npm workspace in the lwc-bolts monorepo. It's the content mapper protocol and the glue between the packages that do the work:

- [`@lwc-bolts/sf2ts`](../sf2ts) converts metadata files to declarations, and templates to TypeScript that checks them, using the base component definitions in [`@lwc-bolts/lightning-base-components`](../lightning-base-components).
- [`@lwc-bolts/sfdx-project`](../sfdx-project) finds the SFDX project, resolves files' metadata types through source-deploy-retrieve, finds components, and reads the SObject definitions.

```sh
npm install                                 # at the repo root; links the workspace's sf2ts
npm test -w @lwc-bolts/typescript-content-mapper       # runs unit, protocol and e2e tests, from source
```

The workspace link means the tests run against the `sf2ts` source in `packages/sf2ts`.

The e2e tests drive the TypeScript 7.1 API (`typescript/sync` from `typescript@7.1.0-beta`) against copies of the fixture SFDX projects in [`tests/fixtures`](../../tests/fixtures). The fixtures come from the `typescript-plugin` package. Each test starts `new API({ runExternalCode: true })` and opens the project's `tsconfig.json` in a snapshot, because content mappers are configured there rather than in compiler options. It then checks the program's diagnostics, and the `originalText` and `spanMap` of the content-mapped source files. The tests use `using` declarations, so they need Node 24 or later. The mapper itself runs on Node 22.18 and later.
