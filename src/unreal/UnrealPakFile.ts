import { createHash } from "node:crypto";
import {
  UNREAL_PAK_FOOTER_LAYOUTS,
  type UnrealPak,
  type UnrealPakEntry,
  type UnrealPakFooter,
} from "../domain/unreal/unrealPak.js";

export const UNREAL_PAK_MAGIC = 0x5a6f12e1;

/** Stable machine-readable reason for each rejected input. */
export const UNREAL_PAK_FAILURE_REASONS = {
  unsupported: ["unrecognized-footer", "frozen-index"],
  corrupt: [
    "region-out-of-bounds",
    "truncated-record",
    "invalid-string",
    "invalid-flag",
    "index-trailing-bytes",
    "entry-reference-out-of-range",
    "duplicate-path",
    "entry-count-mismatch",
    "unknown-compression-slot",
    "region-hash-mismatch",
    "entry-out-of-bounds",
  ],
  resource: ["region-too-large", "too-many-entries", "paths-too-large"],
} as const;
export type UnrealPakFailureKind = keyof typeof UNREAL_PAK_FAILURE_REASONS;
export type UnrealPakFailureReason =
  (typeof UNREAL_PAK_FAILURE_REASONS)[UnrealPakFailureKind][number];

/** Distinguish inputs outside decoder coverage, damaged indexes and limits. */
export class UnrealPakFormatFailure extends Error {
  readonly kind: UnrealPakFailureKind;
  constructor(
    readonly reason: UnrealPakFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${reason}: ${message}`, options);
    this.name = "UnrealPakFormatFailure";
    this.kind = (
      Object.keys(UNREAL_PAK_FAILURE_REASONS) as UnrealPakFailureKind[]
    ).find((kind) =>
      (UNREAL_PAK_FAILURE_REASONS[kind] as readonly string[]).includes(reason),
    )!;
  }
}

/** Positioned reads over one stable file snapshot. */
export interface UnrealPakSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** Bounds that keep a hostile index from allocating without limit. */
export interface UnrealPakLimits {
  /** Largest index, path hash index or directory index region read. */
  readonly regionBytes: number;
  /** Largest number of entries decoded. */
  readonly entries: number;
  /** Largest total of path characters (UTF-16 units) built from directory and file names. */
  readonly pathChars: number;
  /** Called with each declared entry count before its entries are built; may throw. */
  readonly beforeEntries?: (count: number) => void;
}

export type UnrealPakDecoded = Omit<UnrealPak, "artifact" | "limitations">;

type Layout = (typeof UNREAL_PAK_FOOTER_LAYOUTS)[number];

interface LayoutShape {
  readonly version: number;
  readonly keyGuid: boolean;
  readonly encryptedFlag: boolean;
  readonly frozenFlag: boolean;
  readonly compressionSlots: 0 | 4 | 5;
}

const shape = (layout: Layout): LayoutShape => {
  const version =
    layout === "v8a" || layout === "v8b" ? 8 : Number(layout.slice(1));
  return {
    version,
    keyGuid: version >= 7,
    encryptedFlag: version >= 4,
    frozenFlag: version === 9,
    compressionSlots: version < 8 ? 0 : layout === "v8a" ? 4 : 5,
  };
};

const footerBytes = (layout: LayoutShape) =>
  (layout.keyGuid ? 16 : 0) +
  (layout.encryptedFlag ? 1 : 0) +
  4 +
  4 +
  8 +
  8 +
  20 +
  (layout.frozenFlag ? 1 : 0) +
  layout.compressionSlots * 32;

/** Legacy ECompressionFlags values used before named compression slots. */
const LEGACY_COMPRESSION = new Map([
  [1, "Zlib"],
  [2, "Gzip"],
  [4, "Custom"],
]);

/** Bounds-checked little-endian reads over one in-memory region. */
class Cursor {
  position = 0;
  constructor(
    readonly bytes: Buffer,
    readonly label: string,
  ) {}

  private take(length: number): number {
    const at = this.position;
    if (length < 0 || at + length > this.bytes.length)
      throw new UnrealPakFormatFailure(
        "truncated-record",
        `${this.label} ends inside a record at byte ${at}`,
      );
    this.position += length;
    return at;
  }
  u8 = () => this.bytes.readUInt8(this.take(1));
  u32 = () => this.bytes.readUInt32LE(this.take(4));
  i32 = () => this.bytes.readInt32LE(this.take(4));
  u64 = (): number => {
    const value = this.bytes.readBigUInt64LE(this.take(8));
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new UnrealPakFormatFailure(
        "region-out-of-bounds",
        `${this.label} holds a 64-bit value beyond the safe integer range`,
      );
    return Number(value);
  };
  hex = (length: number) =>
    this.bytes.subarray(this.take(length), this.position).toString("hex");
  /** A u64 written as 16 hex digits, the way the value itself reads. */
  u64Hex = () =>
    this.bytes.readBigUInt64LE(this.take(8)).toString(16).padStart(16, "0");
  /** A u32 that must be 0 or 1, as the version 10+ index region flags are. */
  bool32 = (what: string) => {
    const value = this.u32();
    if (value > 1)
      throw new UnrealPakFormatFailure(
        "invalid-flag",
        `${this.label} ${what} is ${value}, not 0 or 1`,
      );
    return value === 1;
  };
  bool = (what: string) => {
    const value = this.u8();
    if (value > 1)
      throw new UnrealPakFormatFailure(
        "invalid-flag",
        `${this.label} ${what} is ${value}, not 0 or 1`,
      );
    return value === 1;
  };
  /**
   * Version 12 directory-index file names: a byte count of UTF-8 with no NUL,
   * as UE 5.8 writes them (directory names keep the FString form).
   */
  utf8Name = (what: string): string => {
    const length = this.i32();
    if (length < 0)
      throw new UnrealPakFormatFailure(
        "invalid-string",
        `${this.label} ${what} has negative length ${length}`,
      );
    const at = this.take(length);
    const raw = this.bytes.subarray(at, at + length);
    if (raw.includes(0))
      throw new UnrealPakFormatFailure(
        "invalid-string",
        `${this.label} ${what} at byte ${at} contains a NUL`,
      );
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        raw,
      );
    } catch (cause: unknown) {
      throw new UnrealPakFormatFailure(
        "invalid-string",
        `${this.label} ${what} at byte ${at} is not valid UTF-8`,
        { cause },
      );
    }
  };
  /**
   * FString: a negative length counts UTF-16 units, a positive one Latin-1
   * bytes; both count the NUL.
   */
  string = (what: string): string => {
    const length = this.i32();
    if (length === 0) return "";
    const units = Math.abs(length);
    const width = length > 0 ? 1 : 2;
    const at = this.take(units * width);
    const raw = this.bytes.subarray(at, at + units * width);
    const terminator =
      width === 1 ? raw[units - 1] : raw.readUInt16LE((units - 1) * 2);
    if (terminator !== 0)
      throw new UnrealPakFormatFailure(
        "invalid-string",
        `${this.label} ${what} at byte ${at} is not NUL-terminated`,
      );
    const body = raw.subarray(0, (units - 1) * width);
    const text =
      width === 1 ? body.toString("latin1") : body.toString("utf16le");
    // Only the terminator may be NUL; an inner one would truncate the path in UE.
    if (text.includes("\0"))
      throw new UnrealPakFormatFailure(
        "invalid-string",
        `${this.label} ${what} at byte ${at} contains a NUL before its terminator`,
      );
    return text;
  };
}

const sha1Hex = (cursor: Cursor) => cursor.hex(20);

/** Find the footer by trying each layout's fixed size from the end, newest first. */
const readFooter = async (
  source: UnrealPakSource,
): Promise<{ footer: UnrealPakFooter; shape: LayoutShape }> => {
  const longest = Math.max(
    ...UNREAL_PAK_FOOTER_LAYOUTS.map((layout) => footerBytes(shape(layout))),
  );
  const tailLength = Math.min(longest, source.size);
  const tail = await source.read(source.size - tailLength, tailLength);
  for (const layout of UNREAL_PAK_FOOTER_LAYOUTS) {
    const layoutShape = shape(layout);
    const size = footerBytes(layoutShape);
    if (size > tail.length) continue;
    const start = tail.length - size;
    const magicAt =
      start +
      (layoutShape.keyGuid ? 16 : 0) +
      (layoutShape.encryptedFlag ? 1 : 0);
    if (tail.readUInt32LE(magicAt) !== UNREAL_PAK_MAGIC) continue;
    if (tail.readUInt32LE(magicAt + 4) !== layoutShape.version) continue;
    const cursor = new Cursor(tail.subarray(start), "footer");
    const keyGuid = layoutShape.keyGuid ? cursor.hex(16) : null;
    const indexEncrypted = layoutShape.encryptedFlag
      ? cursor.bool("index encryption flag")
      : null;
    cursor.u32();
    cursor.u32();
    const indexOffset = cursor.u64();
    const indexSize = cursor.u64();
    const indexSha1 = sha1Hex(cursor);
    const frozen = layoutShape.frozenFlag
      ? cursor.bool("frozen index flag")
      : null;
    const names: (string | null)[] = [];
    for (let slot = 0; slot < layoutShape.compressionSlots; slot++) {
      const raw = cursor.bytes.subarray(cursor.position, cursor.position + 32);
      cursor.position += 32;
      const end = raw.indexOf(0);
      const name = raw.subarray(0, end === -1 ? 32 : end).toString("latin1");
      names.push(name === "" ? null : name);
    }
    const footerOffset = source.size - size;
    return {
      shape: layoutShape,
      footer: {
        offset: footerOffset,
        size,
        layout,
        version: layoutShape.version,
        index: { offset: indexOffset, size: indexSize, sha1: indexSha1 },
        index_encrypted: indexEncrypted,
        encryption_key_guid: keyGuid,
        frozen_index: frozen,
        compression_methods: names,
      },
    };
  }
  throw new UnrealPakFormatFailure(
    "unrecognized-footer",
    "no pak footer layout (versions 1 to 12) matches the end of the file",
  );
};

/** Reject a region the footer or index names outside the file or the limit. */
const checkRegion = (
  region: { offset: number; size: number },
  limits: UnrealPakLimits,
  label: string,
  end: number,
) => {
  if (region.size > limits.regionBytes)
    throw new UnrealPakFormatFailure(
      "region-too-large",
      `${label} is ${region.size} bytes, above the ${limits.regionBytes}-byte limit`,
    );
  if (region.offset + region.size > end)
    throw new UnrealPakFormatFailure(
      "region-out-of-bounds",
      `${label} at ${region.offset} (+${region.size}) ends past byte ${end}`,
    );
};

/** Read one region the footer or index points at, inside the file and the limit. */
const readRegion = async (
  source: UnrealPakSource,
  region: { offset: number; size: number; sha1: string },
  limits: UnrealPakLimits,
  label: string,
  end: number,
): Promise<Buffer> => {
  checkRegion(region, limits, label, end);
  const bytes = await source.read(region.offset, region.size);
  if (createHash("sha1").update(bytes).digest("hex") !== region.sha1)
    throw new UnrealPakFormatFailure(
      "region-hash-mismatch",
      `${label} bytes do not match the SHA-1 recorded for them`,
    );
  return bytes;
};

/** Count path characters against the limit before a path is built. */
const spendPath = (
  budget: { used: number },
  limits: UnrealPakLimits,
  length: number,
  label: string,
) => {
  budget.used += length;
  if (budget.used > limits.pathChars)
    throw new UnrealPakFormatFailure(
      "paths-too-large",
      `${label} builds more than ${limits.pathChars} path characters`,
    );
};

/** Reject entries whose stored bytes would extend past the data area. */
const checkPlacement = (entries: readonly UnrealPakEntry[], end: number) => {
  for (const entry of entries)
    if (entry.offset + entry.size > end)
      throw new UnrealPakFormatFailure(
        "entry-out-of-bounds",
        `${entry.path ?? entry.path_hash} at ${entry.offset} (+${entry.size}) ends past the data area at byte ${end}`,
      );
};

const compressionName = (
  footer: UnrealPakFooter,
  method: number,
): string | null => {
  if (method === 0) return null;
  if (footer.version < 8) return LEGACY_COMPRESSION.get(method) ?? null;
  const name = footer.compression_methods[method - 1];
  if (name === undefined || name === null)
    throw new UnrealPakFormatFailure(
      "unknown-compression-slot",
      `an entry names compression slot ${method}, which the footer leaves ${name === null ? "empty" : "undefined"}`,
    );
  return name;
};

/** A full FPakEntry record, as stored in legacy indexes and non-encoded lists. */
const readFullEntry = (
  cursor: Cursor,
  footer: UnrealPakFooter,
  path: string | null,
  pathHash: string | null,
): UnrealPakEntry => {
  const offset = cursor.u64();
  const size = cursor.u64();
  const uncompressed = cursor.u64();
  const method = footer.layout === "v8a" ? cursor.u8() : cursor.u32();
  if (footer.version === 1) cursor.u64();
  const sha1 = sha1Hex(cursor);
  let blocks = 0;
  if (footer.version >= 3 && method !== 0) {
    blocks = cursor.u32();
    if (blocks * 16 > cursor.bytes.length - cursor.position)
      throw new UnrealPakFormatFailure(
        "truncated-record",
        `${cursor.label} entry declares ${blocks} compression blocks past its end`,
      );
    cursor.position += blocks * 16;
  }
  const flags = footer.version >= 3 ? cursor.u8() : 0;
  const blockSize = footer.version >= 3 ? cursor.u32() : 0;
  return {
    path,
    path_hash: pathHash,
    offset,
    size,
    uncompressed_size: uncompressed,
    compression_method: method,
    compression_name: compressionName(footer, method),
    compression_blocks: blocks,
    compression_block_size: blockSize,
    encrypted: (flags & 1) !== 0,
    deleted: (flags & 2) !== 0,
    sha1,
    record: "full",
  };
};

/** One bit-packed FPakEntry from the version 10+ encoded entry blob. */
const readEncodedEntry = (
  cursor: Cursor,
  footer: UnrealPakFooter,
  path: string | null,
  pathHash: string | null,
): UnrealPakEntry => {
  const bits = cursor.u32();
  const method = (bits >>> 23) & 0x3f;
  const encrypted = (bits & (1 << 22)) !== 0;
  const blocks = (bits >>> 6) & 0xffff;
  let blockSize = bits & 0x3f;
  blockSize = blockSize === 0x3f ? cursor.u32() : blockSize << 11;
  const varInt = (bit: number) =>
    (bits & (1 << bit)) !== 0 ? cursor.u32() : cursor.u64();
  const offset = varInt(31);
  const uncompressed = varInt(30);
  const size = method === 0 ? uncompressed : varInt(29);
  // One unencrypted block is implied; otherwise each block's size follows.
  if (blocks > 1 || (blocks === 1 && encrypted)) {
    if (blocks * 4 > cursor.bytes.length - cursor.position)
      throw new UnrealPakFormatFailure(
        "truncated-record",
        `encoded entry declares ${blocks} compression blocks past its end`,
      );
    cursor.position += blocks * 4;
  }
  return {
    path,
    path_hash: pathHash,
    offset,
    size,
    uncompressed_size: uncompressed,
    compression_method: method,
    compression_name: compressionName(footer, method),
    compression_blocks: blocks,
    compression_block_size: blockSize,
    encrypted,
    deleted: false,
    sha1: null,
    record: "encoded",
  };
};

const checkCountLimit = (
  count: number,
  limits: UnrealPakLimits,
  label: string,
) => {
  if (count > limits.entries)
    throw new UnrealPakFormatFailure(
      "too-many-entries",
      `${label} declares ${count} entries, above the ${limits.entries}-entry limit`,
    );
};

/** Entry counts become report rows, so the caller may refuse them before they are built. */
const checkEntryCount = (
  count: number,
  limits: UnrealPakLimits,
  label: string,
) => {
  checkCountLimit(count, limits, label);
  limits.beforeEntries?.(count);
};

const finished = (cursor: Cursor) => {
  if (cursor.position !== cursor.bytes.length)
    throw new UnrealPakFormatFailure(
      "index-trailing-bytes",
      `${cursor.label} has ${cursor.bytes.length - cursor.position} unread bytes`,
    );
};

/**
 * One directory listing (the full directory index, or the pruned one inside
 * the path hash index): directories, each with file names and entry references.
 */
const readDirectoryListing = (
  cursor: Cursor,
  footer: UnrealPakFooter,
  limits: UnrealPakLimits,
  budget: { used: number },
) => {
  const directories = cursor.u32();
  // Directories produce no rows, so only the count limit applies.
  checkCountLimit(directories, limits, cursor.label);
  const seen = new Set<string>();
  const listed: [string, number][] = [];
  for (let d = 0; d < directories; d++) {
    const directory = cursor.string("directory name");
    const fileCount = cursor.u32();
    checkEntryCount(listed.length + fileCount, limits, cursor.label);
    for (let f = 0; f < fileCount; f++) {
      const name =
        footer.version >= 12
          ? cursor.utf8Name("file name")
          : cursor.string("file name");
      spendPath(budget, limits, directory.length + name.length, cursor.label);
      const path = joinPath(directory, name);
      if (seen.has(path))
        throw new UnrealPakFormatFailure(
          "duplicate-path",
          `${cursor.label} lists ${path} twice`,
        );
      seen.add(path);
      listed.push([path, cursor.i32()]);
    }
  }
  return { directories, listed };
};

/** Join a full-directory-index directory and file name as the pak stores them. */
const joinPath = (directory: string, file: string) =>
  `${directory.startsWith("/") ? directory.slice(1) : directory}${file}`;

/**
 * Decode the footer and, unless it is encrypted, the index of one pak file.
 * Only the footer and the regions it names are read; file data is not.
 */
export const readUnrealPak = async (
  source: UnrealPakSource,
  limits: UnrealPakLimits,
): Promise<UnrealPakDecoded> => {
  const { footer } = await readFooter(source);
  if (footer.frozen_index === true)
    throw new UnrealPakFormatFailure(
      "frozen-index",
      "version 9 frozen indexes store a serialized memory image and are not decoded",
    );
  const dataEnd = footer.offset;
  if (footer.index_encrypted === true) {
    // The encrypted index is not read, but its declared region must still fit.
    checkRegion(footer.index, limits, "index", dataEnd);
    return { footer, index: { state: "encrypted" }, entries: [] };
  }
  const index = new Cursor(
    await readRegion(source, footer.index, limits, "index", dataEnd),
    "index",
  );
  const mountPoint = index.string("mount point");
  // The mount point is returned text too, so it shares the path budget.
  const budget = { used: 0 };
  spendPath(budget, limits, mountPoint.length, "index mount point");
  const entryCount = index.u32();
  checkEntryCount(entryCount, limits, "index");

  if (footer.version < 10) {
    const entries: UnrealPakEntry[] = [];
    const seen = new Set<string>();
    for (let at = 0; at < entryCount; at++) {
      const path = index.string("entry path");
      spendPath(budget, limits, path.length, "index");
      if (seen.has(path))
        throw new UnrealPakFormatFailure(
          "duplicate-path",
          `index lists ${path} twice`,
        );
      seen.add(path);
      entries.push(readFullEntry(index, footer, path, null));
    }
    finished(index);
    checkPlacement(entries, footer.index.offset);
    return {
      footer,
      index: {
        state: "decoded",
        mount_point: mountPoint,
        entry_count: entryCount,
        path_hash_seed: null,
        path_hash_index: null,
        full_directory_index: null,
      },
      entries,
    };
  }

  const seed = index.u64Hex();
  const region = (label: string) => ({
    offset: index.u64(),
    size: index.u64(),
    sha1: sha1Hex(index),
    label,
  });
  const pathHashRegion = index.bool32("path hash index flag")
    ? region("path hash index")
    : null;
  const directoryRegion = index.bool32("full directory index flag")
    ? region("full directory index")
    : null;
  const encodedSize = index.u32();
  if (encodedSize > index.bytes.length - index.position)
    throw new UnrealPakFormatFailure(
      "truncated-record",
      `index declares ${encodedSize} encoded entry bytes past its end`,
    );
  const encoded = index.bytes.subarray(
    index.position,
    index.position + encodedSize,
  );
  index.position += encodedSize;
  // Walk the encoded records so references can only name a record start.
  const recordStarts = new Set<number>();
  const walk = new Cursor(encoded, "encoded entries");
  while (walk.position < encoded.length) {
    checkCountLimit(recordStarts.size + 1, limits, "encoded entries");
    recordStarts.add(walk.position);
    readEncodedEntry(walk, footer, null, null);
  }
  const fullCount = index.u32();
  checkEntryCount(fullCount, limits, "non-encoded entry list");
  const fullEntries: Buffer[] = [];
  for (let at = 0; at < fullCount; at++) {
    const start = index.position;
    readFullEntry(index, footer, null, null);
    fullEntries.push(index.bytes.subarray(start, index.position));
  }
  finished(index);

  const resolve = (
    reference: number,
    path: string | null,
    hash: string | null,
  ) => {
    if (reference >= 0) {
      if (!recordStarts.has(reference))
        throw new UnrealPakFormatFailure(
          "entry-reference-out-of-range",
          `entry reference ${reference} is not the start of an encoded entry`,
        );
      const cursor = new Cursor(encoded, "encoded entries");
      cursor.position = reference;
      return readEncodedEntry(cursor, footer, path, hash);
    }
    const record = fullEntries[-reference - 1];
    if (record === undefined)
      throw new UnrealPakFormatFailure(
        "entry-reference-out-of-range",
        `entry reference ${reference} names no non-encoded entry`,
      );
    return readFullEntry(
      new Cursor(record, "non-encoded entry"),
      footer,
      path,
      hash,
    );
  };

  const entries: UnrealPakEntry[] = [];
  let directoryIndex = null;
  let pathHashIndex = null;
  if (pathHashRegion !== null) {
    const phi = new Cursor(
      await readRegion(
        source,
        pathHashRegion,
        limits,
        "path hash index",
        dataEnd,
      ),
      "path hash index",
    );
    const phiCount = phi.u32();
    checkEntryCount(phiCount, limits, "path hash index");
    const hashed: [string, number][] = [];
    const seenHashes = new Set<string>();
    for (let at = 0; at < phiCount; at++) {
      const hash = phi.u64Hex();
      if (seenHashes.has(hash))
        throw new UnrealPakFormatFailure(
          "duplicate-path",
          `path hash index lists hash ${hash} twice`,
        );
      seenHashes.add(hash);
      hashed.push([hash, phi.i32()]);
    }
    // The pruned directory index follows the hashes inside the same region.
    const pruned = readDirectoryListing(phi, footer, limits, budget);
    finished(phi);
    // Every reference must name a placed record, even when the full
    // directory index is the one that names the returned entries.
    checkPlacement(
      pruned.listed.map(([path, reference]) => resolve(reference, path, null)),
      footer.index.offset,
    );
    const fromHashes = hashed.map(([hash, reference]) =>
      resolve(reference, null, hash),
    );
    checkPlacement(fromHashes, footer.index.offset);
    pathHashIndex = {
      region: {
        offset: pathHashRegion.offset,
        size: pathHashRegion.size,
        sha1: pathHashRegion.sha1,
      },
      entries: phiCount,
      pruned_directories: pruned.directories,
      pruned_files: pruned.listed.length,
    };
    if (directoryRegion === null)
      for (const entry of fromHashes) entries.push(entry);
  }
  if (directoryRegion !== null) {
    const fdi = new Cursor(
      await readRegion(
        source,
        directoryRegion,
        limits,
        "full directory index",
        dataEnd,
      ),
      "full directory index",
    );
    const { directories, listed } = readDirectoryListing(
      fdi,
      footer,
      limits,
      budget,
    );
    for (const [path, reference] of listed)
      entries.push(resolve(reference, path, null));
    const files = listed.length;
    finished(fdi);
    directoryIndex = {
      region: {
        offset: directoryRegion.offset,
        size: directoryRegion.size,
        sha1: directoryRegion.sha1,
      },
      directories,
      files,
    };
  }
  const listed = [
    ["path hash index", pathHashIndex?.entries],
    ["full directory index", directoryIndex?.files],
    ["decoded entry list", entries.length],
  ] as const;
  for (const [label, listedCount] of listed)
    if (listedCount !== undefined && listedCount !== entryCount)
      throw new UnrealPakFormatFailure(
        "entry-count-mismatch",
        `the index declares ${entryCount} entries but the ${label} holds ${listedCount}`,
      );
  checkPlacement(entries, footer.index.offset);
  return {
    footer,
    index: {
      state: "decoded",
      mount_point: mountPoint,
      entry_count: entryCount,
      path_hash_seed: seed,
      path_hash_index: pathHashIndex,
      full_directory_index: directoryIndex,
    },
    entries,
  };
};
