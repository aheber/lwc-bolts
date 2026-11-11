// The content mapper's options in a project config's `contentMappers` entry, as the options commands change them.
import { writeFileSync } from "node:fs";
import { OPTION_DEFAULTS, OPTION_NAMES, parseOptions, type OptionName } from "@lwc-bolts/typescript-content-mapper/options";
import { applySetup, contentMapperOptions, lwcConfigFile, planSetup, setContentMapperOptions } from "@lwc-bolts/project-setup";
import { SfError } from "@salesforce/core";
import { describeSetup, relative, requireProjectConfig, type SetupSummary } from "./project.ts";

export interface OptionValue {
  readonly name: OptionName;
  readonly value: unknown;
  /** Whether the project config sets it; otherwise the mapper uses the default. */
  readonly set: boolean;
}

export interface OptionsResult {
  /** The project config, relative to the project. */
  readonly projectConfig: string;
  readonly options: OptionValue[];
}

/** The mapper's options for the project at `root`: each one the project config sets, or its default. */
export function readOptions(root: string): OptionsResult {
  const project = requireProjectConfig(root);
  const options = contentMapperOptions(project.text) ?? {};
  return {
    projectConfig: relative(root, project.path),
    options: OPTION_NAMES.map((name) =>
      Object.hasOwn(options, name) ? { name, value: options[name], set: true } : { name, value: OPTION_DEFAULTS[name], set: false },
    ),
  };
}

/**
 * Reads `name=value` arguments as option changes. A value is read as JSON when it is JSON (`true`, `null`,
 * `["CustomLabel"]`, `"quoted"`), and otherwise as text: a comma-separated list for an option whose
 * default is a list (`CustomLabel,CustomPermission`, or nothing for none), or a string for the others.
 * The changes are validated as the mapper validates its options, and any problem is thrown.
 */
export function parseAssignments(args: readonly string[]): Partial<Record<OptionName, unknown>> {
  const changes: Record<string, unknown> = {};
  for (const arg of args) {
    const equals = arg.indexOf("=");
    if (equals <= 0) {
      throw new SfError(`Expected name=value, but got '${arg}'.`, "InvalidArgumentFormat");
    }
    const name = arg.slice(0, equals);
    if (Object.hasOwn(changes, name)) {
      throw new SfError(`'${name}' is set more than once.`, "DuplicateArgument");
    }
    changes[name] = parseValue(name, arg.slice(equals + 1));
  }
  const problems = parseOptions(changes).diagnostics.map(({ messageText }) => messageText);
  if (problems.length > 0) {
    throw new SfError(problems.join("\n"), "InvalidOptions", [`Options: ${OPTION_NAMES.join(", ")}.`]);
  }
  return changes as Partial<Record<OptionName, unknown>>;
}

function parseValue(name: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const isList = Array.isArray(OPTION_DEFAULTS[name as OptionName]);
    return isList
      ? text
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
      : text;
  }
}

export interface ChangeResult extends OptionsResult {
  /** The project config the options were written to, relative to the project, unless it had them already. */
  readonly updated?: string;
  /** When lwcConfigFile changed, setting the project up again with the other file. */
  readonly setup?: SetupSummary;
}

/**
 * Sets the mapper's options in the project config: each value of `changes` is written, and an `undefined`
 * one is removed, so the mapper uses its default. When `lwcConfigFile` changes, the project is set up
 * again, which moves the project config to that file and writes it in the other `lwc` folders.
 */
export function changeOptions(root: string, changes: Partial<Record<OptionName, unknown>>): ChangeResult {
  const project = requireProjectConfig(root);
  const text = setContentMapperOptions(project.text, changes);
  if (text === undefined) {
    throw new SfError(`${relative(root, project.path)} isn't valid JSON, so it wasn't changed.`, "InvalidProjectConfig");
  }
  if (text === project.text) {
    return readOptions(root);
  }
  writeFileSync(project.path, text);
  const updated = relative(root, project.path);
  if (lwcConfigFile(text) === project.file) {
    return { ...readOptions(root), updated };
  }
  const plan = planSetup(root);
  if ("error" in plan) {
    throw new SfError(`Set lwcConfigFile, but unable to set the project up with it: ${plan.error}`, "SetupFailed");
  }
  const setup = describeSetup(plan, applySetup(plan));
  return { ...readOptions(root), updated, setup };
}
