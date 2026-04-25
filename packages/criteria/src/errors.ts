import type { ZodIssue } from "zod";

export class CriteriaValidationError extends Error {
  readonly issues: ZodIssue[];

  constructor(message: string, issues: ZodIssue[]) {
    super(message);
    this.name = "CriteriaValidationError";
    this.issues = issues;
  }

  formatIssues(): string {
    return this.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `  - ${path}: ${issue.message}`;
      })
      .join("\n");
  }
}

export class CriteriaSchemaVersionError extends Error {
  readonly foundVersion: string;
  readonly supportedVersion: string;

  constructor(foundVersion: string, supportedVersion: string) {
    super(
      `Criteria schema_version "${foundVersion}" is not supported (expected major ${supportedVersion.split(".")[0]}).`
    );
    this.name = "CriteriaSchemaVersionError";
    this.foundVersion = foundVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class CriteriaYamlParseError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "CriteriaYamlParseError";
    this.cause = cause;
  }
}

export class CriteriaFileNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Criteria file not found at: ${path}`);
    this.name = "CriteriaFileNotFoundError";
    this.path = path;
  }
}
