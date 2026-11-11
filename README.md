# Lightning Bolts (lwc-bolts)

This is a tooling mono-repo focussed around improving Salesforce development.

Right now the projects main goals are to smooth out LWC dev. Things like improving type definitions associated with metadata & modules, and component awareness. Path mapping `c/compName` to their physical files on disk so the editor can be more aware what is available. Greatly improving awareness of importable modules such as static resources, custom permissions, custom labels, Apex `AuraEnabled` methods, and many others.

The project includes

- sf2ts - a transformation layer that reads Salesforce Metadata and turns it into Typescript
- typescript-content-mapper - a TypeScript 7 [content mapper](https://github.com/microsoft/typescript-go/pull/4712) that exposes the same metadata, and checks LWC templates, without a language service plugin.
- vscode-extension - a VS Code extension to provide the language service plugin and the content mapper automatically without configuration.
- sf-plugin - a Salesforce CLI plugin that sets an SFDX project up for the content mapper, keeps it set up, and changes the mapper's options, for other editors and scripts.
- lightning-base-components - definitions of the `lightning-*` base components' properties, methods and events.
- sfdx-project - an SFDX project's package directories, components, metadata types and SObject definitions.
- project-setup - sets up and syncs an SFDX project's TypeScript configuration for the content mapper, and checks the packages it needs installed.
