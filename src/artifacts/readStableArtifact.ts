import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import {
  withArtifactFileHandle,
  assertArtifactReadActive,
} from "./ArtifactFileOperation.js";

/** Exact physical read completed before descriptor finalization. */
export interface StableArtifactSnapshot {
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** Positioned reads over the admitted descriptor of one stable file. */
export interface StableArtifactRangeSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** Filesystem boundary for stable reads, including deterministic replacement probes. */
export interface StableArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
}

const FILE_SYSTEM: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};

const afterValidation = async <T>(
  path: string,
  stage: string,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed ${stage}: ${path}`,
        { cause },
      );
    throw cause;
  }
};

/** Admit one regular file without following a symlink and open it read-only. */
const openRegularFile = async (
  path: string,
  fileSystem: StableArtifactFileSystem,
  admit: (before: BigIntStats) => void,
) => {
  const before = await fileSystem.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ArtifactReaderFailure(
      "path",
      `Expected a regular file without a symlink: ${path}`,
    );
  admit(before);
  const file = await afterValidation(path, "before open", () =>
    fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  );
  return { before, file };
};

/** Reject a descriptor whose file no longer matches the path admitted before open. */
const assertOpenedAdmitted = async (
  path: string,
  file: FileHandle,
  before: BigIntStats,
) => {
  const initial = await file.stat({ bigint: true });
  if (
    !initial.isFile() ||
    initial.dev !== before.dev ||
    initial.ino !== before.ino
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact changed before open: ${path}`,
    );
  return initial;
};

/** Reject replacement or in-place change after `count` bytes were streamed. */
const assertUnchangedAfterRead = async (
  path: string,
  file: FileHandle,
  fileSystem: StableArtifactFileSystem,
  initial: BigIntStats,
  count: number,
) => {
  const after = await file.stat({ bigint: true });
  const current = await afterValidation(path, "during read", () =>
    fileSystem.lstat(path),
  );
  if (
    [after, current].some(
      (stat) =>
        !stat.isFile() ||
        stat.dev !== initial.dev ||
        stat.ino !== initial.ino ||
        stat.size !== initial.size ||
        stat.mtimeNs !== initial.mtimeNs ||
        stat.ctimeNs !== initial.ctimeNs,
    ) ||
    BigInt(count) !== initial.size
  )
    throw new ArtifactReaderFailure(
      "integrity",
      `Artifact changed during read: ${path}`,
    );
};

/** Read one bounded regular file and reject replacement or in-place changes. */
export const readStableArtifact = async (
  path: string,
  maximumBytes: number,
  signal?: AbortSignal,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
  resourceScope?: ArtifactResourceScope,
): Promise<StableArtifactSnapshot> => {
  assertArtifactReadActive(signal);
  const { before, file } = await openRegularFile(path, fileSystem, (stat) => {
    if (stat.size > BigInt(maximumBytes))
      throw new ArtifactReaderFailure(
        "limit",
        `Selected artifact exceeds ${String(maximumBytes)} bytes: ${path}`,
        { boundary: "file-size" },
      );
  });
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await assertOpenedAdmitted(path, file, before);
      const chunks: Buffer[] = [];
      let count = 0;
      for await (const chunk of file.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
      })) {
        assertArtifactReadActive(signal);
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value))
          throw new ArtifactReaderFailure(
            "format",
            `Artifact stream did not return bytes: ${path}`,
          );
        const bytes = value;
        count += bytes.length;
        if (count > maximumBytes)
          throw new ArtifactReaderFailure(
            "limit",
            `Selected artifact grew beyond its byte limit: ${path}`,
            { boundary: "file-size" },
          );
        chunks.push(bytes);
      }
      await assertUnchangedAfterRead(path, file, fileSystem, initial, count);
      assertArtifactReadActive(signal);
      const bytes = Buffer.concat(chunks, count);
      return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  );
};

/**
 * Decode selected ranges of one regular file without loading it, then hash the
 * whole file through the same descriptor. The admission, ownership and change
 * checks are the ones readStableArtifact uses, so the SHA-256 identifies exactly
 * the bytes the ranges came from.
 */
export const readStableArtifactRanges = async <T>(
  path: string,
  decode: (source: StableArtifactRangeSource) => Promise<T>,
  signal?: AbortSignal,
  resourceScope?: ArtifactResourceScope,
  fileSystem: StableArtifactFileSystem = FILE_SYSTEM,
): Promise<{
  readonly result: T;
  readonly sha256: string;
  readonly bytes: number;
}> => {
  assertArtifactReadActive(signal);
  const { before, file } = await openRegularFile(path, fileSystem, (stat) => {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ArtifactReaderFailure(
        "limit",
        `Selected artifact is too large to address: ${path}`,
        { boundary: "file-size" },
      );
  });
  return withArtifactFileHandle(
    path,
    file,
    resourceScope,
    signal,
    async (file) => {
      const initial = await assertOpenedAdmitted(path, file, before);
      const size = Number(initial.size);
      const result = await decode({
        size,
        read: async (offset, length) => {
          assertArtifactReadActive(signal);
          if (offset < 0 || length < 0 || offset + length > size)
            throw new RangeError(
              `Read of ${length} bytes at ${offset} is outside ${size} bytes`,
            );
          const buffer = Buffer.alloc(length);
          let done = 0;
          while (done < length) {
            const { bytesRead } = await file.read(
              buffer,
              done,
              length - done,
              offset + done,
            );
            if (bytesRead === 0)
              throw new ArtifactReaderFailure(
                "integrity",
                `Artifact shrank during read: ${path}`,
              );
            done += bytesRead;
          }
          return buffer;
        },
      });
      assertArtifactReadActive(signal);
      const hash = createHash("sha256");
      let count = 0;
      for await (const chunk of file.createReadStream({
        autoClose: false,
        start: 0,
        highWaterMark: 65536,
      })) {
        assertArtifactReadActive(signal);
        const value: unknown = chunk;
        if (!Buffer.isBuffer(value))
          throw new ArtifactReaderFailure(
            "format",
            `Artifact stream did not return bytes: ${path}`,
          );
        count += value.length;
        // Stop at the first byte past the admitted size instead of following growth.
        if (count > size)
          throw new ArtifactReaderFailure(
            "integrity",
            `Artifact grew during read: ${path}`,
          );
        hash.update(value);
      }
      await assertUnchangedAfterRead(path, file, fileSystem, initial, count);
      assertArtifactReadActive(signal);
      return { result, sha256: hash.digest("hex"), bytes: size };
    },
  );
};
