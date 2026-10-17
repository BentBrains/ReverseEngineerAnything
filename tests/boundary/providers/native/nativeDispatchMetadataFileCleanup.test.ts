import { open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { artifactFilePrimaryFailure } from "../../../../src/artifacts/ArtifactFileOperation.js";
import { AnalysisOutputError } from "../../../../src/domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../../../src/domain/evidenceErrors.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { inspectAppleDispatchMetadata } from "../../../../src/native/AppleDispatchMetadata.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

/** Create a minimal valid 64-bit Mach-O binary buffer for dispatch tests. */
const minimalMacho = (): Buffer => {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  bytes.writeUInt32LE(1, 16); // ncmds = 1
  bytes.writeUInt32LE(72, 20); // sizeofcmds
  bytes.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
  bytes.writeUInt32LE(72, 36); // cmdsize
  bytes.write("__TEXT", 40);
  return bytes;
};

/** Open a real target and make only its admitted descriptor's close reject until released. */
const fixture = async (bindActualDigest: boolean) => {
  const root = await createTestTempDirectory("rea-native-dispatch-close-");
  const path = join(root, "fixture.macho");
  await writeFile(path, minimalMacho());
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const target = bindActualDigest
    ? await nativeMachoTargetForFile(path)
    : nativeMachoTarget(path);
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner({}),
    "darwin",
  ).createClient(target);
  const state = { failing: true, attempts: 0 };
  let release: (() => Promise<void>) | undefined;
  const original = prototype.stat;
  const stat = vi
    .spyOn(prototype, "stat")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["stat"]>
    ) {
      release = this.close.bind(this);
      this.close = async () => {
        state.attempts += 1;
        if (state.failing) throw new Error("dispatch target close failed");
        await release!();
      };
      return Reflect.apply(original, this, args);
    });
  onTestFinished(async () => {
    stat.mockRestore();
    state.failing = false;
    await client.close();
  });
  return { client, path, target, state };
};

it("keeps the integrity failure primary and retains the target descriptor when close rejects", async () => {
  const { client, path, state } = await fixture(false);

  const result = await client.execute("inspect_native_dispatch_metadata", {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected integrity and close failures");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([path]);
  expect(result.error.cleanupPrimary?._tag).toBe("EvidenceIntegrityError");
  expect(state.attempts).toBe(1);

  // Client close retries the exact retained descriptor without reopening it.
  const held = await client.close();
  expect(held.ok).toBe(false);
  expect(state.attempts).toBe(2);
  expect(result.error.cleanupIncomplete).toBe(true);

  state.failing = false;
  expect((await client.close()).ok).toBe(true);
  expect(state.attempts).toBe(3);
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("reports a completed read whose close rejects as retained cleanup", async () => {
  const { client, path, state } = await fixture(true);

  const result = await client.execute("inspect_native_dispatch_metadata", {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected the close failure");
  expect(result.error).toBeInstanceOf(ProviderCleanupError);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([path]);
  expect(result.error.cleanupPrimary).toBeUndefined();

  state.failing = false;
  expect((await client.close()).ok).toBe(true);
  expect(state.attempts).toBe(2);
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("preserves backward compatibility when inspectAppleDispatchMetadata is called without resources", async () => {
  const root = await createTestTempDirectory("rea-native-dispatch-compat-");
  const path = join(root, "fixture.macho");
  await writeFile(path, minimalMacho());
  const target = await nativeMachoTargetForFile(path);

  // Direct call with 2 arguments (matching scripts/verify/apple/dispatch.mjs:57)
  const result = await inspectAppleDispatchMetadata(target, 5000);
  expect(result.target_sha256).toBe(target.sha256);
  expect(result.result).toBeDefined();

  // Direct call with 3 arguments (target, maxRecords, signal)
  const controller = new AbortController();
  const resultWithSignal = await inspectAppleDispatchMetadata(
    target,
    5000,
    controller.signal,
  );
  expect(resultWithSignal.target_sha256).toBe(target.sha256);
});

/** Create a Mach-O buffer with a misaligned __swift5_types section to trigger a decode error. */
const misalignedSwiftMacho = (): Buffer => {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  bytes.writeUInt32LE(1, 16); // ncmds = 1
  bytes.writeUInt32LE(152, 20); // sizeofcmds (72 + 80)
  bytes.writeUInt32LE(0x19, 32); // LC_SEGMENT_64
  bytes.writeUInt32LE(152, 36); // cmdsize
  bytes.write("__TEXT", 40);
  bytes.writeUInt32LE(1, 32 + 64); // nsects = 1
  // Section 0 at 32 + 72 = 104
  bytes.write("__swift5_types", 104);
  bytes.write("__TEXT", 120);
  bytes.writeBigUInt64LE(0x1000n, 136); // addr
  bytes.writeBigUInt64LE(3n, 144); // size = 3 (misaligned: not divisible by 4)
  bytes.writeUInt32LE(512, 152); // offset
  return bytes;
};

it("reports a decoding failure as an AnalysisOutputError rather than a file error", async () => {
  const root = await createTestTempDirectory("rea-native-dispatch-decode-");
  const path = join(root, "fixture.macho");
  await writeFile(path, misalignedSwiftMacho());
  const target = await nativeMachoTargetForFile(path);
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner({}),
    "darwin",
  ).createClient(target);

  const result = await client.execute("inspect_native_dispatch_metadata", {});
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected decoding failure");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
  expect(result.error._tag).toBe("AnalysisOutputError");
  expect(result.error.message).toContain(
    "Apple dispatch metadata decoding failed",
  );
  await client.close();
});

it("preserves primary error when direct fallback scope close also fails", async () => {
  const root = await createTestTempDirectory(
    "rea-native-dispatch-fallback-close-",
  );
  const path = join(root, "fixture.macho");
  await writeFile(path, minimalMacho());
  const target = nativeMachoTarget(path);

  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();

  let release: (() => Promise<void>) | undefined;
  const original = prototype.stat;
  const stat = vi
    .spyOn(prototype, "stat")
    .mockImplementationOnce(async function (
      this: FileHandle,
      ...args: Parameters<FileHandle["stat"]>
    ) {
      release = this.close.bind(this);
      this.close = async () => {
        throw new Error("fallback descriptor close rejected");
      };
      return Reflect.apply(original, this, args);
    });

  onTestFinished(async () => {
    stat.mockRestore();
    if (release) await release();
  });

  await expect(inspectAppleDispatchMetadata(target, 5000)).rejects.toSatisfy(
    (err: unknown) => {
      expect(err).toBeInstanceOf(AggregateError);
      const agg = err as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(agg.cause).toBe(agg.errors[0]);
      expect(agg.errors[1]).toBeDefined();
      expect(agg.errors[1]).not.toBe(agg.errors[0]);
      expect(artifactFilePrimaryFailure(agg.errors[0])).toBeInstanceOf(
        EvidenceIntegrityError,
      );
      return true;
    },
  );
});
