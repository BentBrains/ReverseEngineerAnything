import { writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  path: "",
  blockNew: true,
  blocked: new Set<FileHandle>(),
  handles: [] as FileHandle[],
  onClose: undefined as (() => void) | undefined,
  readFailure: undefined as { cause: unknown } | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...arguments_: Parameters<typeof original.open>) => {
      const handle = await original.open(...arguments_);
      if (String(arguments_[0]) !== fault.path) return handle;
      const close = handle.close.bind(handle);
      fault.handles.push(handle);
      if (fault.blockNew) fault.blocked.add(handle);
      if (fault.readFailure !== undefined) {
        const failure = fault.readFailure;
        handle.stat = async () => {
          throw failure.cause;
        };
      }
      handle.close = async () => {
        fault.onClose?.();
        if (fault.blocked.has(handle))
          throw new Error("controlled Rust descriptor close failure");
        await close();
      };
      return handle;
    },
  };
});

import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { RustBinaryService } from "../../src/application/rust/RustBinaryService.js";
import { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisResourceConstraintError,
} from "../../src/domain/analysisErrorCore.js";
import {
  ArtifactFileCleanupFailure,
  withArtifactRegularFile,
} from "../../src/artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { GoBinaryProvider } from "../../src/go/GoBinaryProvider.js";
import { PeResourcesProvider } from "../../src/native/pe/PeResourcesProvider.js";
import { Il2cppMetadataProvider } from "../../src/il2cpp/Il2cppMetadataProvider.js";
import { inspectPeResourcesInputSchema } from "../../src/domain/native/peResources.js";
import { peResourceFixture } from "../../src/native/pe/PeResources.fixture.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { createRustImage } from "../fixtures/rust/image.js";
import { createIl2cppMetadataFixture } from "../fixtures/il2cpp/metadata.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { mcpTest } from "../support/mcp/mcpFixture.js";

beforeEach(() => {
  fault.path = "";
  fault.blockNew = true;
  fault.blocked.clear();
  fault.handles = [];
  fault.onClose = undefined;
  fault.readFailure = undefined;
});

const staticProviders = [
  ["Rust", () => new RustBinaryProvider()],
  ["Go", () => new GoBinaryProvider()],
  ["PE", () => new PeResourcesProvider()],
  ["IL2CPP metadata", () => new Il2cppMetadataProvider()],
] as const;

it.each(staticProviders)(
  "preserves the exact late-close cancellation cause through %s inspection",
  async (_name, makeProvider) => {
    const path = await selectedImage();
    const provider = makeProvider();
    if (provider instanceof PeResourcesProvider)
      await writeFile(path, peResourceFixture().bytes);
    if (provider instanceof Il2cppMetadataProvider)
      await writeFile(path, createIl2cppMetadataFixture().bytes);
    const controller = new AbortController();
    const reason = new Error("cancel during confirmed descriptor close");
    fault.blockNew = false;
    fault.onClose = () => controller.abort(reason);
    try {
      const result =
        provider instanceof PeResourcesProvider
          ? await provider.inspect(
              inspectPeResourcesInputSchema.parse({ path }),
              { signal: controller.signal },
            )
          : await provider.inspect({ path }, { signal: controller.signal });
      if (result.ok) throw new Error("Expected late cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
      expect(fault.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      fault.blocked.clear();
      await provider.close();
    }
  },
);

it.each(
  staticProviders.flatMap(([name, makeProvider]) => [
    [
      name,
      makeProvider,
      new ArtifactReaderFailure("integrity", "source replacement"),
      AnalysisArtifactChangedError,
    ] as const,
    [
      name,
      makeProvider,
      Object.assign(new Error("read denied"), { code: "EACCES" }),
      AnalysisAccessDeniedError,
    ] as const,
    [
      name,
      makeProvider,
      new ArtifactReaderFailure("limit", "read limit"),
      AnalysisResourceConstraintError,
    ] as const,
  ]),
)(
  "preserves %s read failure after successful close observes cancellation",
  async (_name, makeProvider, primary, expected) => {
    const path = await selectedImage();
    const provider = makeProvider();
    fault.blockNew = false;
    fault.readFailure = { cause: primary };
    const controller = new AbortController();
    fault.onClose = () => controller.abort(new Error("later cancellation"));
    try {
      const result =
        provider instanceof PeResourcesProvider
          ? await provider.inspect(
              inspectPeResourcesInputSchema.parse({ path }),
              { signal: controller.signal },
            )
          : await provider.inspect({ path }, { signal: controller.signal });
      if (result.ok) throw new Error("Expected primary read failure");
      expect(result.error).toBeInstanceOf(expected);
      expect(result.error.cause).toBe(primary);
      expect(fault.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      await provider.close();
    }
  },
);

it.each(staticProviders)(
  "keeps the primary %s read failure when cancellation arrives during failed close",
  async (_name, makeProvider) => {
    const path = await selectedImage();
    const provider = makeProvider();
    const primary = new ArtifactReaderFailure(
      "integrity",
      "controlled source replacement",
    );
    fault.readFailure = { cause: primary };
    const controller = new AbortController();
    fault.onClose = () => controller.abort(new Error("later cancellation"));
    try {
      const result =
        provider instanceof PeResourcesProvider
          ? await provider.inspect(
              inspectPeResourcesInputSchema.parse({ path }),
              { signal: controller.signal },
            )
          : await provider.inspect({ path }, { signal: controller.signal });
      if (result.ok)
        throw new Error("Expected primary failure and retained descriptor");
      expect(result.error.cleanupIncomplete).toBe(true);
      const aggregate = result.error.cause;
      if (!(aggregate instanceof AggregateError))
        throw new Error("Missing primary/cleanup aggregate");
      const [original] = aggregate.errors;
      expect(original).toBeInstanceOf(AnalysisArtifactChangedError);
      expect((original as AnalysisArtifactChangedError).cause).toBe(primary);
      fault.blocked.clear();
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      fault.blocked.clear();
      await provider.close();
    }
  },
);
afterEach(async () => {
  fault.blockNew = false;
  fault.blocked.clear();
  fault.onClose = undefined;
  for (const handle of fault.handles) if (handle.fd >= 0) await handle.close();
});

const selectedImage = async () => {
  const root = await createTestTempDirectory("rea-rust-artifact-owner-");
  const path = join(root, "image.elf");
  await writeFile(path, createRustImage({ format: "elf" }));
  fault.path = path;
  return path;
};

mcpTest(
  "retains Rust descriptor cleanup and recovers in the same MCP connection",
  async ({ mcp }) => {
    const path = await selectedImage();
    const service = new RustBinaryService(new RustBinaryProvider());
    const failures: AnalysisError[] = [];
    const inspect = service.inspect.bind(service);
    vi.spyOn(service, "inspect").mockImplementation(async (...arguments_) => {
      const result = await inspect(...arguments_);
      if (!result.ok) failures.push(result.error);
      return result;
    });
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected native provider");
    });
    const server = createServer(
      { kind: "session", session },
      { rustBinary: service },
    );
    const client = await mcp.connect(server);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.callTool({
          name: "inspect_rust_binary",
          arguments: { path },
        });
        expect(response.isError).toBe(true);
        expect(parseMcpToolError(response).error).toMatchObject({
          code: "cleanup_incomplete",
          details: { resources: [path] },
        });
      }
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      expect(failures.map((error) => error.cleanupIncomplete)).toEqual([
        true,
        true,
      ]);
      fault.blockNew = false;
      fault.blocked.clear();
      const recovered = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(recovered.isError).not.toBe(true);
      expect(failures.map((error) => error.cleanupIncomplete)).toEqual([
        false,
        false,
      ]);
      expect(fault.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      await session.close();
    }
  },
);

it("keeps mixed descriptor cleanup and its aggregate bound to the exact unresolved owners", async () => {
  const path = await selectedImage();
  const service = new RustBinaryService(new RustBinaryProvider());
  try {
    const inspections = await Promise.all([
      service.inspect({ path }),
      service.inspect({ path }),
    ]);
    expect(fault.handles).toHaveLength(2);
    const errors = inspections.map((result) => {
      if (result.ok) throw new Error("Expected retained cleanup");
      return result.error;
    });
    const firstClose = await service.close().catch((cause: unknown) => cause);
    if (!(firstClose instanceof AnalysisError))
      throw new Error("Missing typed shutdown failure");
    expect(firstClose.cleanupIncomplete).toBe(true);
    const handlesByError = errors.map((error) => {
      const aggregate = error.cause;
      if (!(aggregate instanceof AggregateError))
        throw new Error("Missing cleanup aggregate");
      const cleanup = aggregate.errors[1];
      if (
        !(cleanup instanceof AnalysisError) ||
        !(cleanup.cause instanceof ArtifactFileCleanupFailure)
      )
        throw new Error("Missing exact descriptor owner");
      return cleanup.cause.fileCleanupFailure.owner.handle;
    });
    expect(new Set(handlesByError)).toEqual(new Set(fault.handles));
    const [first, second] = handlesByError;
    if (first === undefined || second === undefined)
      throw new Error("Missing distinct descriptors");
    fault.blocked.delete(first);
    const mixedClose = await service.close().catch((cause: unknown) => cause);
    if (!(mixedClose instanceof AnalysisError))
      throw new Error("Missing mixed shutdown failure");
    expect(first.fd).toBe(-1);
    expect(second.fd).toBeGreaterThanOrEqual(0);
    expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
      false,
      true,
    ]);
    expect(firstClose.cleanupIncomplete).toBe(true);
    expect(mixedClose.cleanupIncomplete).toBe(true);
    fault.blocked.clear();
    await service.close();
    expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
      false,
      false,
    ]);
    expect(firstClose.cleanupIncomplete).toBe(false);
    expect(mixedClose.cleanupIncomplete).toBe(false);
  } finally {
    fault.blockNew = false;
    fault.blocked.clear();
    await service.close();
  }
});

mcpTest(
  "server shutdown releases Rust descriptors retained by a failed tool call",
  async ({ mcp }) => {
    const path = await selectedImage();
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected native provider");
    });
    const server = createServer({ kind: "session", session });
    const client = await mcp.connect(server);
    try {
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(parseMcpToolError(response).error.code).toBe("cleanup_incomplete");
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      expect(fault.handles[0]?.fd).toBe(-1);
    } finally {
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      await session.close();
    }
  },
);

it("preserves the caller's cancellation cause when descriptor close also fails", async () => {
  const path = await selectedImage();
  const provider = new RustBinaryProvider();
  const controller = new AbortController();
  const reason = new Error("cancel during Rust descriptor close");
  fault.onClose = () => controller.abort(reason);
  try {
    const result = await provider.inspect(
      { path },
      { signal: controller.signal },
    );
    if (result.ok)
      throw new Error("Expected cancellation with retained cleanup");
    expect(result.error.cleanupIncomplete).toBe(true);
    const aggregate = result.error.cause;
    if (!(aggregate instanceof AggregateError))
      throw new Error("Missing primary/cleanup aggregate");
    const [primary] = aggregate.errors;
    expect(primary).toBeInstanceOf(AnalysisCancelledError);
    expect((primary as AnalysisCancelledError).cause).toBe(reason);
    fault.blockNew = false;
    fault.blocked.clear();
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    fault.blockNew = false;
    fault.blocked.clear();
    await provider.close();
    fault.onClose = undefined;
  }
});

it("preserves upstream resource-bound facts through an unconfirmed descriptor close", async () => {
  const path = await selectedImage();
  const scope = new ArtifactResourceScope();
  const primary = new ArtifactReaderFailure(
    "limit",
    "Controlled input budget refusal",
    { boundary: "file-size" },
  );
  try {
    const failure = await scope
      .run(() =>
        withArtifactRegularFile(path, scope, undefined, async () => {
          throw primary;
        }),
      )
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    expect(failure).toMatchObject({ reason: "limit", boundary: "file-size" });
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Expected exact descriptor cleanup failure");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "failed",
      cause: primary,
    });
  } finally {
    fault.blocked.clear();
    await scope.close();
  }
});
