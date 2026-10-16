import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parse } from "yaml";
import { z } from "zod";

const WORKFLOW = join(".github", "workflows", "ci.yml");

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z
        .array(
          z.object({
            run: z.string().optional(),
            with: z.object({ name: z.string().optional() }).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

const explicitPaths = async (
  lane: "windows" | "focused",
): Promise<string[]> => {
  const workflow = workflowSchema.parse(
    parse(await readFile(WORKFLOW, "utf8")),
  );
  const runs =
    lane === "windows"
      ? (workflow.jobs["windows-curated"]?.steps
          ?.map((step) => step.run)
          .filter((value) => value?.includes("npx vitest run")) ?? [])
      : Object.values(workflow.jobs)
          .flatMap((job) => job.steps ?? [])
          .map((step) => step.run)
          .filter((value) =>
            value?.trim().startsWith("npm run test:focused -- "),
          );
  expect(
    runs.length,
    `expected explicit ${lane} CI test invocations`,
  ).toBeGreaterThan(0);
  return [
    ...new Set(
      runs.flatMap(
        (run) =>
          run?.split(/\s+/).filter((token) => token.endsWith(".test.ts")) ?? [],
      ),
    ),
  ].sort();
};

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("curated Windows test lane", () => {
  it("references only test files that exist", async () => {
    const paths = await explicitPaths("windows");
    expect(paths.length).toBeGreaterThan(0);
    const missing = await Promise.all(
      paths.map(async (path) => ((await exists(path)) ? undefined : path)),
    );
    expect(missing.filter((path) => path !== undefined)).toEqual([]);
  }, 10_000);

  it("keeps the native multi-megabyte output regression in the lane", async () => {
    expect(await explicitPaths("windows")).toContain(
      "tests/boundary/process/windowsOutputCapture.test.ts",
    );
  });

  it("keeps the adjacent npm fallback regression in the lane", async () => {
    expect(await explicitPaths("windows")).toContain(
      "tests/boundary/process/packageNpmInvocation.test.ts",
    );
  });

  it("keeps Windows runner cancellation coverage in the lane", async () => {
    expect(await explicitPaths("windows")).toEqual(
      expect.arrayContaining([
        "tests/process-global/runnerCancellation.test.ts",
        "tests/process-global/windowsOwnedCommand.test.ts",
      ]),
    );
  });

  it("installs and verifies native command ownership before the source build", async () => {
    const workflow = workflowSchema.parse(
      parse(await readFile(WORKFLOW, "utf8")),
    );
    const steps = workflow.jobs["windows-curated"]?.steps ?? [];
    const download = steps.findIndex(
      (step) => step.with?.name === "windows-native-controls",
    );
    const verify = steps.findIndex(
      (step) => step.run === "npm run verify:windows-native:artifact",
    );
    const build = steps.findIndex(
      (step) => step.run === "npm run build:cached",
    );
    expect(download).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(download);
    expect(build).toBeGreaterThan(verify);
  });
  it("runs the host-bound Ghidra publication and cancellation regressions", async () => {
    expect(await explicitPaths("windows")).toEqual(
      expect.arrayContaining([
        "tests/boundary/providers/ghidra/ghidraClient.test.ts",
        "tests/boundary/mcp/ghidraStartupCancellationMcp.test.ts",
        "tests/boundary/mcp/ghidraInventoryMcp.test.ts",
        "tests/boundary/providers/startupCloseWaiters.test.ts",
      ]),
    );
  });
});

it("keeps every explicit focused CI test path executable after file moves", async () => {
  const paths = await explicitPaths("focused");
  expect(paths.length).toBeGreaterThan(0);
  const missing = await Promise.all(
    paths.map(async (path) => ((await exists(path)) ? undefined : path)),
  );
  expect(missing.filter((path) => path !== undefined)).toEqual([]);
}, 10_000);
