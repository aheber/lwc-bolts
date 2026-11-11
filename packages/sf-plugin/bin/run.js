#!/usr/bin/env node
// Runs the plugin's commands from dist without installing it in the Salesforce CLI, for development:
// `npm run build -w @lwc-bolts/sf-plugin && node packages/sf-plugin/bin/run.js lwc-bolts project setup`.
import { execute } from "@oclif/core";

await execute({ dir: import.meta.url });
