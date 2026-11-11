# Setting up a project for Lightning Bolts

The Lightning Bolts (LWC-Bolts) VS Code extension helps set your project up for our content mapper, making your components type-safe and improving your editor's auto-completion. It works for Apex classes, custom labels, objects, fields, static resources and more, making them available as modules your Lightning Web Components can import from `@salesforce/...`. It does that with a TypeScript **content mapper**, [`@lwc-bolts/typescript-content-mapper`](https://www.npmjs.com/package/@lwc-bolts/typescript-content-mapper): a program TypeScript runs alongside its language server, which turns metadata files into type declarations.

Lightning Bolts changes your `jsconfig.json` or `tsconfig.json` files. This is necessary to register the content mapper and to make your files and the provided types work together.

The **Lightning Bolts: Set Up Project** command gets you there. Each message it shows has a **Learn More** button that opens the section of this page about that step.

- [How setup runs](#how-setup-runs)
- [TypeScript 7 extension](#typescript-7-extension)
- [TypeScript version](#typescript-version)
- [Editor TypeScript](#editor-typescript)
- [Project config](#project-config-jsconfigjson)
- [Other lwc folders](#other-lwc-folders)
- [Config file name](#config-file-name)
- [Workspace settings](#workspace-settings)
- [Packages](#packages)
- [Node.js on your PATH](#nodejs-on-your-path)
- [Keeping configs in step](#keeping-configs-in-step)
- [Troubleshooting](#troubleshooting)
- [Messages](#messages)

## How setup runs

The extension works when you have a `sfdx-project.json` file. When a project hasn't been set up for LWC-Bolts it offers the **Set Up Project** button. When you click that button, setup:

1. Checks for the [TypeScript 7 extension](#typescript-7-extension), and asks you to install it if it's missing.
2. Checks that [TypeScript 7.1](#typescript-version) is available to the project.
3. Asks to turn on the [workspace settings](#workspace-settings), which starts TypeScript 7's language server, and checks which version of [TypeScript the editor runs](#editor-typescript).
4. Makes sure you have [Node.js on your PATH](#nodejs-on-your-path).
5. Writes the [project config](#project-config-jsconfigjson), the [configs in the other `lwc` folders](#other-lwc-folders) and the Lightning types file.
6. Shows a summary of what it did, and offers what's left: installing [packages](#packages), using the project's TypeScript, and restarting TypeScript.

## TypeScript 7 extension

The [TypeScript 7 extension](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview) (`TypeScriptTeam.native-preview`) runs TypeScript's native language server, which is what runs content mappers. VS Code's built-in TypeScript still runs TypeScript 6, so without the TypeScript 7 extension, Lightning Bolts' content mapper has nothing to plug into.

When it's missing, setup's first step asks you to install it, with **Show Extension** to open it in the Extensions view. Once it's installed setup will move to the next step.

When it's installed but fails to start, setup lets you know. **Show Error** shows what went wrong in the Lightning Bolts output channel. **Reload Window** restarts VS Code to try again. When it starts without the API the mapper needs, it's too old: **Show Extension** lets you update it.

## TypeScript version

Content mappers need TypeScript 7.1 or later. Setup looks for one in this order, and stops, changing nothing, when the first one it finds is older:

1. The one your `js/ts.tsdk.path` setting names, when it's set and the workspace is trusted.
2. The one installed in the project's `node_modules`.
3. Finally, the global `node_modules`.

The error names the TypeScript path it checked. Unless the setting names a TypeScript outside the project, it offers **Install Packages**, which installs `typescript@7.1.0-beta` with the mapper (see [Packages](#packages)) and carries on with setup.

## Editor TypeScript

VS Code's language server runs the TypeScript that `js/ts.tsdk.path` names, and when that's unset, the one bundled with the TypeScript 7 extension, which may be older than 7.1. Setup checks that the editor runs a new enough version, and offers to install one when it doesn't.

Turning on the setting `js/ts.experimental.useTsgo` starts the TS7 language server, which says which TypeScript version it runs. When that version can't run content mappers we prompt:

- **Use Project TypeScript**, when the project has its own: sets `js/ts.tsdk.path` to the TypeScript installed at `node_modules/typescript` for the workspace, restarts TypeScript, and carries on.
- **Select Version** opens the TypeScript 7 extension's version picker. Pick 7.1 or later, then run setup again.

When a set-up project doesn't have TypeScript 7.1 installed (and `js/ts.tsdk.path` doesn't name another), it offers **Install Packages** with `typescript@7.1.0-beta` instead of **Select Version**, since there'd be nothing to select.

## Project config (jsconfig.json)

The mapper only acts on files inside the project, so the whole SFDX project needs one config file that pulls them together. Setup puts it in the `lwc` folder of the default package directory: the one `sfdx-project.json` marks `"default": true`, or the first listed. When that package has no `lwc` folder, it goes in the first package directory that has one.

The project config:

- **includes** every `packageDirectories` path from `sfdx-project.json`, relative to its folder, so metadata from every package is mapped. It also includes the typings for modules the mapper doesn't declare, and the generated SObject definitions.
- **registers the mapper** in `contentMappers` for `.cls`, `.xml` and `.html` files. Registering `.xml` rather than each `-meta.xml` suffix is deliberate: TypeScript 7.1 can't match suffixes with uppercase letters, such as `.customPermission-meta.xml`, on case-insensitive file systems. `.html` lets TypeScript check templates against their components.

An existing project config, the `lwc` folder config that already registers the mapper wherever it is, keeps its other settings. Setup checks it against the project config's policy (see [Keeping configs in step](#keeping-configs-in-step)) and changes only what doesn't conform.

Setup also writes `.sfdx/typings/lwc/lightning.d.ts`, which imports `@salesforce/lightning-types` (see [Packages](#packages)), and includes it in the project config.

## Other lwc folders

Every other `lwc` folder gets a config with no files of its own that only references the default project's config. TypeScript then opens every component in the project config's program, so all packages share one program, and their types are resolved once together rather than isolated per package folder.

- `files` and `include` become empty. A `tsconfig.json` only gets an empty `include` when it has one, or `extends` a config that might.
- `baseUrl`, `paths` and `experimentalDecorators` are removed: they break the mapper's types (see [Project config](#project-config-jsconfigjson)).
- A reference to the project config is added.

The rest of the file stays. A file that isn't valid JSON results in a warning.

## Config file name

The mapper's `lwcConfigFile` option, in the project config, picks the file: `jsconfig.json` (the default) or `tsconfig.json`. When it names the other file, setup moves the project config there, and writes the other folders' configs in that file too.

- **`jsconfig.json`** is the file the Salesforce extensions write in each `lwc` folder. The project config replaces theirs in its folder. A `tsconfig.json` in the same folder would take precedence, so setup removes one it wrote, and points out any other.
- **`tsconfig.json`** sits next to the Salesforce extensions' `jsconfig.json`, which TypeScript then ignores. The Salesforce extensions leave a folder with a `tsconfig.json` alone. A `tsconfig.json` doesn't imply what a `jsconfig.json` does, so the project config gets `allowJs`, `skipLibCheck` and `noEmit` unless it sets them.

## Workspace settings

TypeScript 7 needs two workspace settings to run the mapper:

- `js/ts.experimental.useTsgo` runs TypeScript 7's native language server instead of VS Code's built-in one.
- `js/ts.contentMappers.enabled` lets it run content mappers, which run code from the project's `node_modules`.

When either is off, setup asks before turning them on, naming the ones it changes. **Turn On Settings** sets those options for you. **Learn More** opens this section and asks again. They're workspace settings, so they only affect this workspace.

## Packages

| Package                                |                                              | Why                                      |
| -------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| `@lwc-bolts/typescript-content-mapper` | required                                     | The mapper the project config registers. |
| `typescript@7.1.0-beta`                | required when no TypeScript 7.1 is available | Runs content mappers.                    |
| `@salesforce/lightning-types`          | recommended                                  | Types the `lightning/*` and improved `lwc` modules.         |

**Install Packages** opens one menu with the packages the project needs and the ones recommended for it. The checked ones are installed together, with `npm install --save-dev`. When the install succeeds, setup restarts TypeScript. If it fails, the terminal's output shows why.

### Updates

When installed packages are older than the versions the extension knows of, the startup check and **Check Content Mapper Setup** say so, naming each package with its installed and newer version. **Update Packages** opens the same menu.

A package newer than the one the extension knows of is left alone.

## Node.js on your PATH

For projects with a config, TypeScript runs the mapper as the mapper's own `package.json` says, with the `node` on your `PATH`, which must be Node.js 22.18 or later. An extension can't change that, so setup and the startup check make sure it's there. Install Node.js, or fix your `PATH`, then restart VS Code so it sees the change.

Metadata files that aren't in any project config are mapped too. For those, the extension runs the mapper with the Node.js built into VS Code, so they work without Node.js installed. It falls back to the `node` on your `PATH` when VS Code's Node.js is older than the mapper supports, or when `lwcBolts.contentMapper.useVSCodeNode` is off.

## Keeping configs in step

Two things can undo setup after it runs. The extension watches for both.

**Changes to the configs.** When they start, the Salesforce extensions merge their template into each `lwc` folder's `jsconfig.json`. In the project config, they add `"**/*"` and all of `.sfdx/typings/lwc` to `include`, plus `baseUrl`, `paths` and `experimentalDecorators`, which break its types. In the other folders, their `include` takes the folder's components out of the project config's program. Other tools, or people, can do the same to a `jsconfig.json` or a `tsconfig.json`.

**Changes to `sfdx-project.json`.** A package directory added or removed changes what the project config's `include` needs.

Each config has a policy: a **block list** of properties that must not be there, and an **enforce list** of properties that must. Values that depend on the project, such as an `include` entry for each of `sfdx-project.json`'s `packageDirectories`, are merged into the enforce list.

| Config | Blocked | Enforced |
| --- | --- | --- |
| Project config | `compilerOptions.baseUrl`, `paths` and `experimentalDecorators`; the `include` entries `"**/*"` and `.sfdx/typings/lwc/**/*.d.ts`; `include` entries for folders that no longer exist and aren't package directories | an `include` entry for each package directory, then the typings, then the SObject definitions; the mapper registered for `.cls`, `.xml` and `.html`; in a `tsconfig.json`, `allowJs`, `skipLibCheck` and `noEmit` set to `true` |
| Other `lwc` folders | `compilerOptions.baseUrl`, `paths` and `experimentalDecorators` | `files` empty; `include` empty (in a `tsconfig.json`, only when it has one or `extends` a config); a reference to the project config |

At startup, whenever one of the configs is created, changed or deleted, and whenever `sfdx-project.json` changes, the extension checks each config against its policy. If a config doesn't conform, it removes what's blocked and adds or corrects what's enforced. Nothing else changes, so the project's own settings, entries such as globs or existing folders, and comments are kept. A new package directory's `lwc` folder gets a config. If something rewrites a file more than five times in a minute, the extension stops restoring it and warns you, rather than fight over the file. Run setup again once whatever was rewriting it has stopped.

### Leaving the configs alone

Turn `lwcBolts.maintainLwcConfigs` off, and the extension never changes a `jsconfig.json` or `tsconfig.json`, for any reason:

- When a config doesn't conform to its policy, including after `sfdx-project.json`'s package directories change, it says which configs need updating, once a session. **Turn On** turns the setting on and updates them.
- **Set Up Project** asks before changing a config. **Turn On and Continue** turns the setting on and sets the project up as usual. Otherwise, setup does everything else, such as the workspace settings, and its summary lists the configs it left alone.
- **Apply Content Mapper Settings to Project Config** asks too, with **Turn On and Apply**.

## Troubleshooting

If every `@salesforce/...` import reports `Cannot find module`, the mapper isn't running. **Lightning Bolts: Check Content Mapper Setup** looks for the usual causes, and offers a fix for each.

### Workspace trust

VS Code only runs content mappers in trusted workspaces, because a mapper is a program the project's config names. **Manage Workspace Trust** opens the trust settings.

### Workspace settings off

A set-up project needs `js/ts.experimental.useTsgo` and `js/ts.contentMappers.enabled` on, and either one is off or unset. **Turn On Settings** turns them on for the workspace.

### Mapper not installed

The project config registers `@lwc-bolts/typescript-content-mapper`, but the project's `node_modules` doesn't have it, usually after a fresh clone. **Install Packages** installs it (see [Packages](#packages)).

### Comments in jsconfig.json

The project config is a `jsconfig.json` with comments or trailing commas. TypeScript reads them fine, but the Salesforce extensions read the file as plain JSON when they start, and stop setting up the project when they can't.

The other causes have sections of their own: an [old TypeScript in the editor](#editor-typescript), and a missing or old [Node.js](#nodejs-on-your-path).

## Messages

The extension only shows messages in a workspace with an `sfdx-project.json`. At startup, one problem is shown with its fix. Several are one message, whose **Show Details** lists each with its fix. Each is shown once a session.
