import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { Il2cppMetadataProvider } from "../../../src/il2cpp/Il2cppMetadataProvider.js";
import { createIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Version 29 file whose methods all share one long name. */
const sharedNameMetadata = (
  nameBytes: number,
  methods: number,
  fill = 0x41,
) => {
  const name = Buffer.alloc(nameBytes + 1, fill);
  name[nameBytes] = 0;
  const records = Buffer.alloc(methods * 32);
  for (let index = 0; index < methods; index += 1)
    records.writeInt32LE(-1, index * 32 + 4);
  const header = Buffer.alloc(256);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(29, 4);
  let cursor = 256;
  for (let section = 0; section < 31; section += 1) {
    // strings is section 2 and methods is section 5.
    const content = section === 2 ? name : section === 5 ? records : undefined;
    header.writeInt32LE(cursor, 8 + section * 8);
    header.writeInt32LE(content?.length ?? 0, 12 + section * 8);
    cursor += content?.length ?? 0;
  }
  return Buffer.concat([header, name, records]);
};

it("refuses an oversized report from its row lower bound before serializing it", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-budget-");
  const path = join(root, "global-metadata.dat");
  // About 2 KiB of input expands to more than 64 MiB of method names.
  await writeFile(path, sharedNameMetadata(65_536, 1_100));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider();
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          typeof value === "object" && value !== null && "methods" in value,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("counts escaped name characters toward the budget without escaping the name", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-escape-");
  const path = join(root, "global-metadata.dat");
  // 4 KiB of U+0001 is 4 KiB raw but 24 KiB once escaped as .
  await writeFile(path, sharedNameMetadata(4096, 1, 0x01));
  const stringify = vi.spyOn(JSON, "stringify");
  const provider = new Il2cppMetadataProvider(8192);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(
      stringify.mock.calls.some(
        ([value]) => typeof value === "string" && value.length >= 4096,
      ),
    ).toBe(false);
  } finally {
    await provider.close();
  }
});

it("admits a report whose escaped names fit the budget exactly", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-fit-");
  const path = join(root, "global-metadata.dat");
  await writeFile(path, sharedNameMetadata(4096, 1, 0x01));
  const unbounded = new Il2cppMetadataProvider();
  let bytes: number;
  try {
    const result = await unbounded.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.methods[0]?.name).toBe("".repeat(4096));
    bytes = Buffer.byteLength(JSON.stringify(result.value));
  } finally {
    await unbounded.close();
  }
  const exact = new Il2cppMetadataProvider(bytes);
  try {
    expect((await exact.inspect({ path })).ok).toBe(true);
  } finally {
    await exact.close();
  }
});

it("refuses from row counts before decoding any row", async () => {
  const root = await createTestTempDirectory("rea-il2cpp-provider-counts-");
  const path = join(root, "global-metadata.dat");
  // A broken method name would fail as invalid-string if rows were decoded.
  const fixture = createIl2cppMetadataFixture();
  const bytes = Buffer.from(fixture.bytes);
  bytes.writeInt32LE(0x7fff, fixture.record("methods", 0));
  await writeFile(path, bytes);
  const provider = new Il2cppMetadataProvider(256);
  try {
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  } finally {
    await provider.close();
  }
});
