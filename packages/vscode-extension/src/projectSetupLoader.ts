import type { ProjectSetup } from "./setup.ts";

/**
 * Loads @lwc-bolts/project-setup when the extension activates. import() rather than a static import, so
 * a broken installation fails only the setup commands (see registerSetupUnavailable), not activation:
 * the content mapper is still registered. A module of its own, so tests can replace it.
 */
export function loadProjectSetup(): Promise<ProjectSetup> {
  return import("@lwc-bolts/project-setup");
}
