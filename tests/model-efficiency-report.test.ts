import { describe, expect, test } from "bun:test";
import {
  canonicalReportProject,
  inclusiveCalendarDayCount,
} from "../scripts/model-efficiency-report.ts";

describe("inclusiveCalendarDayCount", () => {
  test("counts both endpoints of the report date range", () => {
    expect(inclusiveCalendarDayCount("2025-03-03", "2026-08-03")).toBe(519);
  });
});

describe("canonicalReportProject", () => {
  test("groups workspaces without a repository by project name", () => {
    const first = canonicalReportProject({
      workspace: "workspace:first",
      project_name: "Accounting",
    });
    const second = canonicalReportProject({
      workspace: "workspace:second",
      project_name: "Accounting",
    });

    expect(first).toEqual({ key: "name:Accounting", label: "Accounting" });
    expect(second).toEqual(first);
  });

  test("keeps repositories with the same display name separate", () => {
    const first = canonicalReportProject({
      workspace: "workspace:first",
      project_name: "tree-view",
      project_repository_identity: "git@example.test:alice/tree-view.git",
    });
    const second = canonicalReportProject({
      workspace: "workspace:second",
      project_name: "tree-view",
      project_repository_identity: "git@example.test:bob/tree-view.git",
    });

    expect(first.key).not.toBe(second.key);
  });
});
