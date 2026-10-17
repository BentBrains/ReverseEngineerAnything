import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { UnrealPakService } from "../../../src/application/unreal/UnrealPakService.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { UnrealPakProvider } from "../../../src/unreal/UnrealPakProvider.js";
import { createPakFixture } from "../../fixtures/unreal/pak.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const writePak = async (name: string, bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-unreal-provider-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return { root, path };
};

it("refuses a report above the output budget from the entry count, before entries exist", async () => {
  const { path } = await writePak(
    "big.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const provider = new UnrealPakProvider(100);
  const result = await provider.inspect({ path });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      message: expect.stringContaining("exceeds the inline output budget"),
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("counts the escaped mount point toward the budget without escaping it", async () => {
  // 4 KiB of U+0001 is 4 KiB in the index but 24 KiB once escaped as .
  const { path } = await writePak(
    "mount.pak",
    createPakFixture({
      layout: "v11",
      files: [],
      mountPoint: "".repeat(4096),
    }).bytes,
  );
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new UnrealPakProvider(8192);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) => typeof value === "object" && value !== null,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("admits a report whose escaped mount point fits the budget exactly", async () => {
  const { path } = await writePak(
    "fit.pak",
    createPakFixture({
      layout: "v11",
      mountPoint: "".repeat(4096),
    }).bytes,
  );
  const unbounded = new UnrealPakProvider();
  let bytes: number;
  try {
    const result = await unbounded.inspect({ path });
    if (!result.ok) throw result.error;
    bytes = Buffer.byteLength(JSON.stringify(result.value));
  } finally {
    await unbounded.close();
  }
  const exact = new UnrealPakProvider(bytes);
  try {
    expect((await exact.inspect({ path })).ok).toBe(true);
  } finally {
    await exact.close();
  }
});

it("rejects a symlink instead of following it", async () => {
  const { root, path } = await writePak(
    "real.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const link = join(root, "link.pak");
  await symlink(path, link);
  const provider = new UnrealPakProvider();
  const result = await provider.inspect({ path: link });
  await provider.close();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toMatch(/symlink|invalid/iu);
});

it("refuses relative paths and unretained summaries before reading", async () => {
  const service = new UnrealPakService(new UnrealPakProvider());
  const relative = await service.inspect({ path: "Game.pak" });
  expect(relative.ok).toBe(false);
  const { path } = await writePak(
    "ok.pak",
    createPakFixture({ layout: "v11" }).bytes,
  );
  const summary = await service.inspect({ path, detail: "summary" });
  expect(summary.ok).toBe(false);
  const complete = await service.inspect({ path });
  expect(complete.ok && complete.value.operation).toBe("inspect_unreal_pak");
  await service.close();
});
