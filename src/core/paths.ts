import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_FILE, DIR, FILE, STATE_DIR } from "./constants.js";
import { featureIdSchema, taskIdSchema } from "./input.js";

/**
 * Every `.visp/` path in one place. Nothing else builds state paths by hand.
 */
export class ProjectPaths {
  readonly root: string;

  constructor(root: string) {
    this.root = canonicalProjectRoot(root);
  }

  get config(): string {
    return join(this.root, CONFIG_FILE);
  }

  get state(): string {
    return join(this.root, STATE_DIR);
  }

  stateFile(name: string): string {
    return confinedRelative(this.state, name, "state path");
  }

  get project(): string {
    return this.stateFile(FILE.project);
  }

  get status(): string {
    return this.stateFile(FILE.status);
  }

  get policy(): string {
    return this.stateFile(FILE.policy);
  }

  get overrides(): string {
    return this.stateFile(FILE.overrides);
  }

  get telemetry(): string {
    return this.stateFile(FILE.telemetry);
  }

  get graphDir(): string {
    return join(this.state, DIR.graph);
  }

  get graphStore(): string {
    return join(this.graphDir, FILE.graphStore);
  }

  get featuresDir(): string {
    return join(this.state, DIR.features);
  }

  featureDir(featureId: string): string {
    return join(this.featuresDir, artifactId(featureId, featureIdSchema, "feature"));
  }

  featureFile(featureId: string, name: string): string {
    return join(this.featureDir(featureId), leaf(name, "artifact name"));
  }

  /**
   * Where a task's evidence lives. Parallel tasks each write their own record,
   * so closing two tasks on two branches no longer collides on one file.
   * Without a task the record is feature-wide and keeps the flat path.
   */
  evidenceFile(featureId: string, taskId: string | undefined, name: string): string {
    return taskId === undefined
      ? this.featureFile(featureId, name)
      : join(
          this.featureDir(featureId),
          DIR.evidence,
          artifactId(taskId, taskIdSchema, "task"),
          leaf(name, "evidence name"),
        );
  }

  evidenceDir(featureId: string): string {
    return join(this.featureDir(featureId), DIR.evidence);
  }

  /** Append-only receipts behind an evidence file's current projection. */
  evidenceAttemptsDir(featureId: string, taskId: string | undefined, name: string): string {
    const safeName = leaf(name, "evidence name");
    const stem = safeName.endsWith(".json") ? safeName.slice(0, -".json".length) : safeName;
    return join(
      taskId === undefined
        ? this.featureDir(featureId)
        : join(this.featureDir(featureId), DIR.evidence, artifactId(taskId, taskIdSchema, "task")),
      `${stem}-attempts`,
    );
  }

  evidenceAttemptFile(
    featureId: string,
    taskId: string | undefined,
    name: string,
    attemptId: string,
  ): string {
    return join(
      this.evidenceAttemptsDir(featureId, taskId, name),
      `${leaf(attemptId, "attempt id")}.json`,
    );
  }

  /** Copied evidence attached to one advisory observation receipt. */
  observationAttachmentsDir(featureId: string, taskId: string, observationId: string): string {
    return join(
      this.featureDir(featureId),
      DIR.evidence,
      artifactId(taskId, taskIdSchema, "task"),
      "observations",
      leaf(observationId, "observation id"),
      "attachments",
    );
  }

  /** Content-addressed attachment storage shared by observation receipts. */
  observationAttachmentsStoreDir(featureId: string): string {
    return join(this.evidenceDir(featureId), "observation-attachments");
  }

  observationAttachmentBlob(featureId: string, digest: string, extension = ""): string {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError(`Invalid attachment digest: ${digest}`);
    }
    if (extension !== "" && !/^\.[a-z0-9]+$/.test(extension)) {
      throw new TypeError(`Invalid attachment extension: ${extension}`);
    }
    return join(this.observationAttachmentsStoreDir(featureId), `${digest}${extension}`);
  }

  evidenceQuarantineDir(operationId: string): string {
    return join(
      this.state,
      DIR.state,
      "evidence-quarantine",
      leaf(operationId, "quarantine operation id"),
    );
  }

  evidenceQuarantineFile(operationId: string, originalPath: string): string {
    return confinedRelative(
      this.evidenceQuarantineDir(operationId),
      originalPath,
      "quarantined evidence path",
    );
  }

  /** Per-task context pack, under the owning feature. */
  contextFile(featureId: string, taskId: string): string {
    return join(
      this.featureDir(featureId),
      "context",
      `${artifactId(taskId, taskIdSchema, "task")}.json`,
    );
  }

  contextManifest(featureId: string, taskId: string): string {
    return join(
      this.featureDir(featureId),
      "context",
      `${artifactId(taskId, taskIdSchema, "task")}.manifest.json`,
    );
  }

  get sessionDir(): string {
    return join(this.state, DIR.session);
  }

  get session(): string {
    return join(this.sessionDir, FILE.session);
  }

  get hooksDir(): string {
    return join(this.state, DIR.hooks);
  }

  /** Directory of per-task implement authorizations. */
  get implementMarkersDir(): string {
    return join(this.state, DIR.state, "implement-allowed");
  }

  /** Fingerprints of the harness assets visp wrote, so doctor can spot drift. */
  get assetManifest(): string {
    return join(this.state, DIR.state, FILE.assetManifest);
  }

  /** Last explicitly requested install surfaces; machine-local, never a tracked contract. */
  get installState(): string {
    return join(this.state, DIR.state, FILE.installState);
  }

  implementMarker(taskId: string): string {
    return join(this.implementMarkersDir, `${artifactId(taskId, taskIdSchema, "task")}.json`);
  }

  /** Absolute path for a repository-relative path. */
  absolute(relativePath: string): string {
    if (isPortableAbsolute(relativePath)) {
      throw new TypeError(`Repository path must be relative: ${relativePath}`);
    }
    if (hasParentSegment(relativePath)) {
      throw new TypeError(`Repository path contains parent traversal: ${relativePath}`);
    }
    return confinedRelative(this.root, relativePath, "repository path");
  }

  /** Repository-relative POSIX path, or undefined when outside the project. */
  relative(absolutePath: string): string | undefined {
    const rel = relative(this.root, resolve(absolutePath));
    if (rel === "") return ".";
    if (isParentTraversal(rel) || isAbsolute(rel)) return undefined;
    return toPosix(rel);
  }
}

/** Resolves a real project root once while still permitting init against a missing root. */
export function canonicalProjectRoot(root: string): string {
  const absolute = resolve(root);
  const missing: string[] = [];
  let candidate = absolute;

  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missing.reverse());
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** True when `child` is inside `parent` (or is `parent`). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!isParentTraversal(rel) && !isAbsolute(rel));
}

function artifactId(
  value: string,
  schema: { safeParse(input: unknown): { success: boolean } },
  label: string,
): string {
  if (!schema.safeParse(value).success) throw new TypeError(`Invalid ${label} id: ${value}`);
  return value;
}

function leaf(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
  return value;
}

function confinedRelative(parent: string, value: string, label: string): string {
  if (isPortableAbsolute(value)) throw new TypeError(`${label} must be relative: ${value}`);
  if (hasParentSegment(value)) throw new TypeError(`${label} contains parent traversal: ${value}`);
  const target = resolve(parent, value);
  if (!isInside(parent, target))
    throw new TypeError(`${label} points outside the project: ${value}`);
  return target;
}

function isParentTraversal(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`);
}

export function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

export function isPortableAbsolute(path: string): boolean {
  return isAbsolute(path) || /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}/.test(path);
}
