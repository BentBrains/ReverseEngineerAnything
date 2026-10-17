import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
  artifactFileCancellationCause,
} from "../artifacts/ArtifactFileOperation.js";
import { readStableArtifactRanges } from "../artifacts/readStableArtifact.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { UnrealPakPort } from "../application/unreal/UnrealPakPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  unrealPakSchema,
  type UnrealPak,
  type UnrealPakProviderInput,
} from "../domain/unreal/unrealPak.js";
import { jsonStringLength } from "../domain/jsonStringLength.js";
import {
  readUnrealPak,
  UnrealPakFormatFailure,
  type UnrealPakDecoded,
} from "./UnrealPakFile.js";

/** Bundled format reader identity; the pak version is a separate observed fact. */
export const UNREAL_PAK_PROVIDER_IDENTITY = {
  id: "unreal-pak",
  name: "REA Unreal Engine pak index reader",
  version: "1",
} as const;
const OPERATION = "inspect_unreal_pak";
const REGION_BYTES = 256 * 1024 * 1024;
const ENTRIES = 1_000_000;
const OUTPUT_BYTES = 64 * 1024 * 1024;

/** The smallest JSON one entry row can take: null path, one-digit numbers. */
const ENTRY_ROW = JSON.stringify({
  path: null,
  path_hash: null,
  offset: 0,
  size: 0,
  uncompressed_size: 0,
  compression_method: 0,
  compression_name: null,
  compression_blocks: 0,
  compression_block_size: 0,
  encrypted: false,
  deleted: false,
  sha1: null,
  record: "full",
}).length;

/**
 * A lower bound on the serialized mount point and entry rows. Escaping can make
 * a string six times longer than the index bytes it came from, so this refuses
 * from escaped lengths before JSON.stringify builds a string the budget would
 * reject, and returns as soon as the bound passes `limit`.
 */
const serializedLowerBound = (decoded: UnrealPakDecoded, limit: number) => {
  let total =
    decoded.index.state === "decoded"
      ? jsonStringLength(decoded.index.mount_point, limit)
      : 0;
  for (const entry of decoded.entries) {
    if (total > limit) return total;
    // ENTRY_ROW already counts a null path as four characters.
    total +=
      ENTRY_ROW +
      (entry.path === null
        ? 0
        : jsonStringLength(entry.path, limit - total) - "null".length);
  }
  return total;
};

const LIMITATIONS = [
  "Only the footer and index of pak versions 1 to 12 are decoded; entry paths, offsets, sizes and compression names are observed index content. File data is not read, decompressed or extracted.",
  "Encrypted indexes are reported as encrypted with their footer facts only; no key is accepted and nothing is decrypted. Version 9 frozen indexes are unsupported.",
  "Compression names come from the footer table (version 8+) or legacy flag values (Zlib, Gzip, Custom); they name methods, not verified codecs. The pak version is not attributed to an engine release.",
];

const failureForPrimary = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof UnrealPakFormatFailure) {
    if (cause.kind === "unsupported")
      return new AnalysisUnsupportedTargetError(
        OPERATION,
        path,
        cause.message,
        { cause },
      );
    if (cause.kind === "resource")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        { maximum_region_bytes: REGION_BYTES, maximum_entries: ENTRIES },
        { cause },
      );
    return new AnalysisInputError(OPERATION, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected artifact ${path} is corrupt: ${cause.message}`,
      },
    ]);
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      cause.message,
      { maximum_input_bytes: Number.MAX_SAFE_INTEGER },
      { cause },
    );
  if (cause instanceof ArtifactReaderFailure && cause.reason === "path")
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: "invalid_format", message: cause.message },
    ]);
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  // A decoder interrupted by cancellation can fail in any way; report the cancellation.
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });
  return new ProviderAdapterError(UNREAL_PAK_PROVIDER_IDENTITY.id, OPERATION, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  const primary =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "failed"
      ? failureForPrimary(cause.fileCleanupFailure.outcome.cause, path, signal)
      : cause instanceof ArtifactFileCleanupFailure && signal?.aborted
        ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
        : failureForPrimary(cause, path, signal);
  if (!(cause instanceof ArtifactReaderFailure) || cause.cleanup === undefined)
    return primary;
  const cleanup = new ProviderCleanupError(
    UNREAL_PAK_PROVIDER_IDENTITY.id,
    cause.cleanup.resources,
    { reason: cause.cleanup.reason },
    { operation: OPERATION, cause },
  );
  const error = analysisErrorWithCleanupFailure(primary, cleanup, OPERATION);
  bindArtifactFileCleanup(cause, error);
  return error;
};

const outputLimit = (path: string, maximumBytes: number) =>
  new AnalysisResourceConstraintError(
    OPERATION,
    "transport",
    `Complete pak index for ${path} exceeds the inline output budget; no partial success is returned.`,
    { maximum_output_bytes: maximumBytes },
  );

/** Stable in-process index decoding without extraction, decompression or decryption. */
export class UnrealPakProvider implements UnrealPakPort {
  readonly identity = UNREAL_PAK_PROVIDER_IDENTITY;
  readonly #resources = new ArtifactResourceScope();

  /** `outputBytes` exists so tests can reach the guard with small files. */
  constructor(private readonly outputBytes: number = OUTPUT_BYTES) {}

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        cause.cleanup === undefined
      )
        throw cause;
      const error = new ProviderCleanupError(
        UNREAL_PAK_PROVIDER_IDENTITY.id,
        cause.cleanup.resources,
        { reason: cause.cleanup.reason },
        { cause, operation: OPERATION },
      );
      bindArtifactFileCleanup(cause, error);
      throw error;
    }
  }

  /** Read the footer and index of one stable file snapshot and hash the whole file. */
  async inspect(
    input: UnrealPakProviderInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnrealPak, AnalysisError>> {
    try {
      const limit = this.outputBytes;
      const {
        result: decoded,
        sha256,
        bytes,
      } = await this.#resources.run(() =>
        readStableArtifactRanges(
          input.path,
          (source) =>
            readUnrealPak(source, {
              regionBytes: REGION_BYTES,
              entries: ENTRIES,
              pathChars: limit,
              beforeEntries: (count) => {
                if (count * ENTRY_ROW > limit)
                  throw outputLimit(input.path, limit);
              },
            }),
          options?.signal,
          this.#resources,
        ),
      );
      options?.signal?.throwIfAborted();
      if (serializedLowerBound(decoded, limit) > limit)
        throw outputLimit(input.path, limit);
      const report = {
        ...decoded,
        artifact: { path: input.path, sha256, bytes },
        limitations: LIMITATIONS,
      };
      let serialized: string;
      try {
        serialized = JSON.stringify(report);
      } catch (cause: unknown) {
        // Escaped text can pass the character budget and still exceed V8's string limit.
        if (cause instanceof RangeError) throw outputLimit(input.path, limit);
        throw cause;
      }
      if (Buffer.byteLength(serialized, "utf8") > limit)
        throw outputLimit(input.path, limit);
      const parsed = unrealPakSchema.safeParse(report);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Unreal pak reader produced invalid footer, index or entry values.",
          { cause: parsed.error },
        );
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}
