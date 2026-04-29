import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CriteriaFileNotFoundError,
  loadCriteriaFromFile,
  resolveCriteriaPath
} from "../index.js";
import { validMinimalCriteriaYaml } from "./fixtures.js";

describe("resolveCriteriaPath", () => {
  it("prefers explicit override path when provided", () => {
    const resolved = resolveCriteriaPath("./custom/criteria.yaml");
    assert.ok(resolved.endsWith(join("custom", "criteria.yaml")));
  });

  it("uses NETWORKPIPELINE_CRITERIA_PATH when set and no override", () => {
    const prev = process.env.NETWORKPIPELINE_CRITERIA_PATH;
    process.env.NETWORKPIPELINE_CRITERIA_PATH = "/tmp/np-test-crit.yaml";
    try {
      const resolved = resolveCriteriaPath();
      assert.ok(resolved.endsWith("np-test-crit.yaml"));
    } finally {
      if (prev === undefined) delete process.env.NETWORKPIPELINE_CRITERIA_PATH;
      else process.env.NETWORKPIPELINE_CRITERIA_PATH = prev;
    }
  });

  it("falls back to ~/.networkpipeline/criteria.yaml by default", () => {
    const prev = process.env.NETWORKPIPELINE_CRITERIA_PATH;
    delete process.env.NETWORKPIPELINE_CRITERIA_PATH;
    try {
      const resolved = resolveCriteriaPath();
      assert.ok(
        resolved.includes(join(".networkpipeline", "criteria.yaml")),
        `resolved path should include .networkpipeline/criteria.yaml, got: ${resolved}`
      );
    } finally {
      if (prev !== undefined) process.env.NETWORKPIPELINE_CRITERIA_PATH = prev;
    }
  });
});

describe("loadCriteriaFromFile", () => {
  const workdir = mkdtempSync(join(tmpdir(), "np-crit-"));
  const yamlPath = join(workdir, "criteria.yaml");
  writeFileSync(yamlPath, validMinimalCriteriaYaml, "utf-8");

  after(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("loads and validates a real YAML file", async () => {
    const { path, criteria, yamlText } = await loadCriteriaFromFile(yamlPath);
    assert.equal(path, yamlPath);
    assert.equal(criteria.version, 1);
    assert.equal(criteria.profile.display_name, "Andrew Watson");
    assert.ok(yamlText.includes("Andrew Watson"));
    assert.ok(yamlText.length > 0);
  });

  it("throws CriteriaFileNotFoundError for missing file", async () => {
    await assert.rejects(
      () => loadCriteriaFromFile(join(workdir, "does-not-exist.yaml")),
      CriteriaFileNotFoundError
    );
  });
});
