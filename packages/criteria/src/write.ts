import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveCriteriaPath } from "./load.js";
import type { CandidateCriteria } from "./schema.js";
import { serializeCriteriaToYaml } from "./serialize.js";

export type WriteCriteriaOptions = {
  /**
   * Override the destination path. When omitted, falls back to the
   * same resolution chain used by loadCriteriaFromFile (override →
   * NETWORKPIPELINE_CRITERIA_PATH env → default home directory).
   */
  path?: string;
};

/**
 * Atomically write a CandidateCriteria to disk as YAML.
 *
 * Uses the temp-file + rename pattern so a partially-written file
 * cannot be observed by readers (criteria.yaml is the source of truth
 * for the active-learning loop and a torn write would corrupt the
 * version chain). The temp file lives next to the destination so the
 * rename is on the same filesystem (POSIX-atomic) and avoids EXDEV
 * on Linux.
 *
 * Validates input via serializeCriteriaToYaml before writing — invalid
 * criteria never reach the filesystem.
 */
export function writeCriteriaToFile(
  criteria: CandidateCriteria,
  options: WriteCriteriaOptions = {}
): { path: string; bytesWritten: number } {
  const path = resolve(resolveCriteriaPath(options.path));
  const yamlText = serializeCriteriaToYaml(criteria);

  ensureDirFor(path);

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, yamlText, "utf-8");
  // POSIX rename is atomic; on Windows it overwrites if the target
  // exists, which is exactly what we want for an in-place update.
  renameSync(tmpPath, path);

  return { path, bytesWritten: Buffer.byteLength(yamlText, "utf-8") };
}

function ensureDirFor(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
