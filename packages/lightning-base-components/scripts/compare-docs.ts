// Crawls the Lightning Component Reference and compares what it documents with our base component
// definitions (src/components.generated.ts): what one has that the other doesn't, and where they disagree.
// Use it to find what to add to lightning/overrides.jsonc, or what's out of date there.
//
//   npm run compare-docs
//   npm run compare-docs -- --json comparison.json   # also write the comparison as JSON
//   npm run compare-docs -- --cache .reference-cache # keep the fetched pages, and reuse them
//   npm run compare-docs -- --delay 1000             # wait longer between requests (ms)
//   npm run compare-docs -- lightning-input lightning-combobox   # only these components
//
// It reads the reference's index page for the components, then each one's Markdown page (description and
// custom events) and specification (attributes, methods and slots). See scripts/lightning/reference.ts.
//
// The site rate-limits bursts of requests (answering 403), so it fetches one page at a time with a pause
// between them, and backs off when it's refused. With --cache, a run that's interrupted resumes where
// it stopped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIGHTNING_COMPONENTS } from "../src/components.generated.ts";
import {
  compareReference,
  type Documented,
  formatComparison,
  INDEX_PATH,
  indexTags,
  pagePath,
  parsePage,
  parseSpecification,
  REFERENCE_SITE,
  specificationPath,
} from "./lightning/reference.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
};
const jsonOutput = option("--json");
const cache = option("--cache");
const delay = Number(option("--delay") ?? 300);
const only = args.filter((arg) => arg.startsWith("lightning-"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits after refusals (403, 429) before trying again, in milliseconds. */
const BACK_OFF = [15_000, 45_000, 90_000];

/** Fetches a path from the reference, from the cache when there is one, backing off when refused. */
async function fetchText(pathname: string): Promise<string> {
  const cached = cache && path.join(cache, pathname.replace(/[^\w.-]+/g, "_"));
  if (cached && existsSync(cached)) {
    return readFileSync(cached, "utf8");
  }
  for (let attempt = 0; ; attempt++) {
    await sleep(delay);
    let failure: string | undefined;
    try {
      const response = await fetch(REFERENCE_SITE + pathname);
      if (response.ok) {
        const text = await response.text();
        if (cached) {
          mkdirSync(path.dirname(cached), { recursive: true });
          writeFileSync(cached, text);
        }
        return text;
      }
      failure = `${response.status} ${response.statusText}`;
      if (response.status !== 403 && response.status !== 429 && response.status < 500) {
        throw new Error(failure); // such as 404: retrying won't help
      }
    } catch (error) {
      if (failure === undefined) failure = (error as Error).message;
      else throw error;
    }
    const wait = BACK_OFF[attempt];
    if (wait === undefined) throw new Error(`${pathname}: ${failure}`);
    console.warn(`${pathname}: ${failure}; trying again in ${wait / 1000}s`);
    await sleep(wait);
  }
}

const tags = only.length > 0 ? only : indexTags(await fetchText(INDEX_PATH));
const reference: Record<string, Documented> = {};
const failures: string[] = [];
for (const tag of tags) {
  try {
    const page = parsePage(await fetchText(pagePath(tag)));
    const specification = parseSpecification(JSON.parse(await fetchText(specificationPath(tag))));
    reference[tag] = { page, specification };
  } catch (error) {
    failures.push(`${tag}: ${(error as Error).message}`);
  }
}

const ours =
  only.length > 0
    ? Object.fromEntries(only.flatMap((tag) => (LIGHTNING_COMPONENTS[tag] ? [[tag, LIGHTNING_COMPONENTS[tag]] as const] : [])))
    : LIGHTNING_COMPONENTS;
const comparison = compareReference(reference, ours);
process.stdout.write(`Compared ${Object.keys(reference).length} documented components with ${Object.keys(ours).length} defined ones.\n\n`);
process.stdout.write(formatComparison(comparison));
for (const failure of failures) {
  console.warn(`warning: couldn't read ${failure}`);
}
if (jsonOutput) {
  writeFileSync(jsonOutput, JSON.stringify({ reference, comparison }, null, 2) + "\n");
  console.log(`Wrote ${jsonOutput}`);
}
