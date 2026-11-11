# Lightning Bolts

### bolting your LWC components together better

This extension surfaces Apex, Custom Object, Custom Labels, and many more Metadata types as importable modules for your LWC components with improved compatibility and context. Enhancing support for things like auto-complete and making Go To Definition land in the correct files makes it easier than ever to build well-integrated components with Salesforce and quickly inspect where those imported pieces are defined.

We also bolt your individual components together more deeply. If one LWC references another then VS Code will have auto-completion for exported content and IntelliSense for those imported pieces. Similarly LWC template `.html` files are transformed and checked against the JavaScript files to help ensure correctness.

This extension is only aware of components you have on your computer. We do not inspect your org for additional Metadata.

## TypeScript 7

With the [TypeScript 7](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview) extension, this extension provides the [`@lwc-bolts/typescript-content-mapper`](https://www.npmjs.com/package/@lwc-bolts/typescript-content-mapper). The extension needs TypeScript 7.1 or better: without it, core features aren't available. We'll offer to set each project up for you, just follow the prompts.

(not ready for TypeScript 7 and Content Mappers? Revert to v0.0.6 of this extension)

### Setting up a project

The [setup guide](https://github.com/aheber/lwc-bolts/blob/main/packages/vscode-extension/docs/setup.md) walks through each step and why it's needed. Every setup message has a **Learn More** button that opens it in VS Code's Markdown preview, at the section about that step.

**Lightning Bolts: Set Up Project** turns on the TypeScript 7 workspace settings, writes the project config that registers the mapper, and offers to install the packages the project needs.

### When the mapper isn't running

If every `@salesforce/...` import reports `Cannot find module`, the mapper isn't running. Run the command **Lightning Bolts: Check Content Mapper Setup**, the extension looks for the usual causes and offers a fix for each:

- An SFDX project that isn't set up (it offers **Set Up Project**).
- A workspace that isn't trusted: content mappers only run in trusted workspaces. The extension runs in Restricted Mode so it can say so.
- The workspace settings for TypeScript 7 off or unset (`js/ts.experimental.useTsgo`, `js/ts.contentMappers.enabled`).
- A TypeScript version older than 7.1, which can't run content mappers.
- A project whose config registers the mapper without having it installed.
- No `node` on your `PATH`, or one older than Node.js 22.18. Projects with a config run the mapper with it, and an extension can't change that. Install Node.js or fix your `PATH`, then restart VS Code.

At startup your configuration is checked, and warnings surface as needed. You can always run **Check Content Mapper Setup** on your own to see any discovered problems and get help fixing them.

Metadata files outside any project config are mapped with options from these settings:

| Setting | Default | Description |
| --- | --- | --- |
| `lwcBolts.contentMapper.apexNamespace` | `"Apex"` | The namespace Apex classes are declared in, or `null` to declare them globally |
| `lwcBolts.contentMapper.inaccessibleApexProperties` | `"include as deprecated"` | Declare Apex fields LWC can't read as `@deprecated` (`"include as deprecated"`), like other fields (`"include"`), or leave them out (`"exclude"`) |
| `lwcBolts.contentMapper.disabledMetadataTypes` | `[]` | Metadata types whose `@salesforce/...` modules aren't declared |
| `lwcBolts.contentMapper.respectForceIgnore` | `true` | Leave out files the project's `.forceignore` denies, or map them like any other file when off |
| `lwcBolts.contentMapper.suppressDiagnosticsExtensions` | `[".cls", ".xml", ".html"]` | File extensions whose files don't show TypeScript's errors (case-insensitive); by default, every extension the mapper handles. Set `[]` to show every error |
| `lwcBolts.contentMapper.useVSCodeNode` | `true` | Run the mapper with VS Code's built-in Node.js rather than the `node` on your `PATH` |

Projects with a `jsconfig.json` or `tsconfig.json` use the `options` of its `contentMappers` entry instead. To use your settings there too, run **Lightning Bolts: Apply Content Mapper Settings to Project Config**. It writes them into the `options` of the project config's `contentMappers` entry, for the active file's SFDX project (or the one you pick), and removes the option of any setting that's unset, so the mapper applies its default. The exception is `suppressDiagnosticsExtensions`: outside a config it suppresses every handled extension by default, but the mapper's own default suppresses none, so set it to copy that suppression into a project config. It keeps the other options, such as `lwcConfigFile`, and the file's comments and formatting. `useVSCodeNode` isn't an option: projects with a config always run the `node` on your `PATH`. It's a one-time copy: run it again after changing a setting.
