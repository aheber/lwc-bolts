# Lightning Bolts (lwc-bolts)

This is a tooling mono-repo focussed around improving Salesforce development.

Right now the projects main goals are to smooth out LWC dev. Things like improving type definitions associated with metadata, modules, and component awareness. Path mapping `c/compName` to their physical files on disk so the editor can be more aware what is available. Greatly improving awareness of importable modules such as static resources, custom permissions, custom labels, Apex `AuraEnabled` methods.

The current project includes

- sf2ts - a transformation layer that reads Salesforce metadata and turns it into Typescript definitions (`d.ts`)
- typescript-plugin - a Typescript [Language Service Plugin](https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin) that pre-registeres on-device metadata as importable modules and manipulates the file content so Typescript see the declaration content instead of the actual content.
- vscode-extension - a VSCode extension to provide the language service plugin automatically without configuration.
