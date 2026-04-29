import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CandidateCriteria } from "./schema.js";
import {
  CriteriaFileNotFoundError,
  CriteriaYamlParseError
} from "./errors.js";
import { validateCriteria } from "./validate.js";

const DEFAULT_RELATIVE_PATH = ".networkpipeline/criteria.yaml";

export function resolveCriteriaPath(overridePath?: string): string {
  if (overridePath && overridePath.length > 0) {
    return resolve(overridePath);
  }
  const envPath = process.env.NETWORKPIPELINE_CRITERIA_PATH;
  if (envPath && envPath.length > 0) {
    return resolve(envPath);
  }
  const home = process.env.NETWORKPIPELINE_HOME ?? homedir();
  return resolve(join(home, DEFAULT_RELATIVE_PATH));
}

function parseCriteriaYaml(yamlText: string): unknown {
  try {
    return parseYaml(yamlText);
  } catch (err) {
    throw new CriteriaYamlParseError(
      `Failed to parse criteria YAML: ${(err as Error).message}`,
      err
    );
  }
}

export function parseCriteriaFromYaml(yamlText: string): CandidateCriteria {
  const raw = parseCriteriaYaml(yamlText);
  return validateCriteria(raw);
}

export async function loadCriteriaFromFile(
  overridePath?: string
): Promise<{ path: string; criteria: CandidateCriteria; yamlText: string }> {
  const path = resolveCriteriaPath(overridePath);
  if (!existsSync(path)) {
    throw new CriteriaFileNotFoundError(path);
  }
  const yamlText = await readFile(path, "utf-8");
  const criteria = parseCriteriaFromYaml(yamlText);
  return { path, criteria, yamlText };
}
