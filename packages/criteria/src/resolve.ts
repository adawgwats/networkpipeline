import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * Reference identifiers in `extends`/`overlays` come in three shapes:
 *
 * 1. Relative paths     — `./templates/foo.yaml`, `../shared/bar.yaml`.
 *                          Resolved relative to the directory of the
 *                          referring file.
 *
 * 2. Absolute paths     — `/abs/path/to/template.yaml`. Used verbatim.
 *
 * 3. Template IDs       — `@networkpipeline/templates/<name>` and
 *                          `@networkpipeline/overlays/<name>`. Resolved
 *                          from the local cache directory:
 *                          `$NETWORKPIPELINE_HOME/cache/templates/...`
 *                          (or the corresponding overlays/ subdir).
 *                          The cache is populated by the
 *                          criteria-templates repo (#26) — V1 of #7
 *                          only handles resolution, not fetching.
 */

export type ReferenceKind = "extends" | "overlay";

const TEMPLATE_ID_PREFIX = "@networkpipeline/templates/";
const OVERLAY_ID_PREFIX = "@networkpipeline/overlays/";

/**
 * Resolve a reference string from `extends` or `overlays` to an
 * absolute file path. Does NOT check that the file exists — caller
 * does that to surface the error closer to the user.
 *
 * `referrerPath` should be the absolute path of the YAML file
 * containing the reference, so relative paths resolve correctly.
 */
export function resolveReferencePath(
  reference: string,
  kind: ReferenceKind,
  referrerPath: string
): string {
  if (reference.length === 0) {
    throw new Error("reference cannot be empty");
  }

  if (reference.startsWith(TEMPLATE_ID_PREFIX)) {
    const name = sanitizeName(reference.slice(TEMPLATE_ID_PREFIX.length));
    return join(cacheRoot(), "templates", `${name}.yaml`);
  }
  if (reference.startsWith(OVERLAY_ID_PREFIX)) {
    const name = sanitizeName(reference.slice(OVERLAY_ID_PREFIX.length));
    return join(cacheRoot(), "overlays", `${name}.yaml`);
  }

  // Bare `@networkpipeline/...` with neither templates/ nor overlays/
  // segment is ambiguous; reject rather than guess.
  if (reference.startsWith("@networkpipeline/")) {
    throw new Error(
      `Reference "${reference}" must include "templates/" or "overlays/" segment.`
    );
  }

  // Path reference: absolute or relative to the referring file.
  if (isAbsolute(reference)) return resolvePath(reference);
  return resolvePath(dirname(referrerPath), reference);
  // Use `kind` only for documentation; resolution is identical for
  // local paths regardless of whether they're extends or overlays.
  // (Reference kept on signature so the cache-id branches above can
  // route to the right subdirectory.)
}

/**
 * `cache_root = $NETWORKPIPELINE_HOME/cache` or
 * `~/.networkpipeline/cache` if the env var is unset. Mirrors
 * the path-resolution conventions in load.ts and connection.ts.
 */
function cacheRoot(): string {
  const home = process.env.NETWORKPIPELINE_HOME ?? homedir();
  return join(home, ".networkpipeline", "cache");
}

/**
 * Reject path traversal in template/overlay names. `..` segments and
 * absolute path fragments must not be hidden inside template ids.
 */
function sanitizeName(name: string): string {
  if (name.length === 0) {
    throw new Error("template/overlay name must be non-empty");
  }
  if (name.includes("..") || name.includes("\0") || isAbsolute(name)) {
    throw new Error(`template/overlay name "${name}" is not allowed`);
  }
  return name;
}
