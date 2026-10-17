import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readUnrealPak,
  UnrealPakFormatFailure,
  type UnrealPakLimits,
} from "../../../src/unreal/UnrealPakFile.js";
import {
  createPakFixture,
  PAK_FIXTURE_FILES,
  type PakFixtureLayout,
} from "../../fixtures/unreal/pak.js";

const LIMITS: UnrealPakLimits = {
  regionBytes: 1 << 20,
  entries: 1000,
  pathChars: 1 << 20,
};

const sourceOf = (bytes: Buffer) => ({
  size: bytes.length,
  read: async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length),
});

const read = (bytes: Buffer, limits: UnrealPakLimits = LIMITS) =>
  readUnrealPak(sourceOf(bytes), limits);

const failure = async (bytes: Buffer, limits: UnrealPakLimits = LIMITS) => {
  try {
    await read(bytes, limits);
  } catch (cause) {
    if (cause instanceof UnrealPakFormatFailure)
      return { reason: cause.reason, kind: cause.kind };
    throw cause;
  }
  throw new Error("expected a pak failure");
};

describe("Unreal pak footers and indexes", () => {
  it.each([
    "v1",
    "v3",
    "v4",
    "v7",
    "v8a",
    "v8b",
    "v9",
    "v10",
    "v11",
    "v12",
  ] as const satisfies readonly PakFixtureLayout[])(
    "reads every %s entry with its placement and compression",
    async (layout) => {
      const { bytes, files, indexOffset, indexSize } = createPakFixture({
        layout,
      });
      const pak = await read(bytes);
      expect(pak.footer).toMatchObject({
        layout,
        index: { offset: indexOffset, size: indexSize },
      });
      expect(pak.index).toMatchObject({
        state: "decoded",
        mount_point: "../../../",
        entry_count: files.length,
      });
      expect(
        pak.entries.map((entry) => [
          entry.path,
          entry.offset,
          entry.size,
          entry.uncompressed_size,
          entry.compression_name,
        ]),
      ).toEqual(
        files.map((file) => [
          file.path,
          file.offset,
          file.stored,
          file.uncompressed,
          file.method === 0 ? null : "Zlib",
        ]),
      );
      const version = Number(layout.replace(/[ab]$/u, "").slice(1));
      expect(
        pak.entries.every(
          (entry) => entry.record === (version >= 10 ? "encoded" : "full"),
        ),
      ).toBe(true);
    },
  );

  it.each(["v8b", "v11"] as const)(
    "reports %s block counts, flags and record hashes",
    async (layout) => {
      const pak = await read(
        createPakFixture({
          layout,
          files: [
            { path: "A/multi", size: 30, compressed: true, blocks: 3 },
            { path: "A/sealed", size: 20, compressed: true, encrypted: true },
            { path: "A/gone", size: 4, fullRecord: true, deleted: true },
          ],
        }).bytes,
      );
      expect(
        pak.entries.map((entry) => [
          entry.path,
          entry.compression_blocks,
          entry.compression_block_size,
          entry.encrypted,
          entry.deleted,
          entry.sha1,
        ]),
      ).toEqual([
        [
          "A/multi",
          3,
          65536,
          false,
          false,
          layout === "v8b" ? "00".repeat(20) : null,
        ],
        [
          "A/sealed",
          1,
          65536,
          true,
          false,
          layout === "v8b" ? "01".repeat(20) : null,
        ],
        ["A/gone", 0, 0, false, true, "02".repeat(20)],
      ]);
    },
  );

  it("reads version 12 file names as UTF-8 without a terminator", async () => {
    const pak = await read(createPakFixture({ layout: "v12" }).bytes);
    expect(pak.entries.map((entry) => entry.path)).toContain(
      "Game/Content/한글.txt",
    );
  });

  it("resolves negative references to the non-encoded full records", async () => {
    const pak = await read(
      createPakFixture({
        layout: "v11",
        files: [
          { path: "A/b.txt", size: 9, fullRecord: true },
          { path: "A/c.txt", size: 5 },
        ],
      }).bytes,
    );
    expect(
      pak.entries.map((entry) => [entry.path, entry.record, entry.size]),
    ).toEqual([
      ["A/b.txt", "full", 9],
      ["A/c.txt", "encoded", 5],
    ]);
  });

  it("names entries by path hash when no full directory index exists", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", directoryIndex: false }).bytes,
    );
    expect(pak.index).toMatchObject({ full_directory_index: null });
    expect(pak.entries).toHaveLength(PAK_FIXTURE_FILES.length);
    expect(
      pak.entries.every(
        (entry) => entry.path === null && entry.path_hash !== null,
      ),
    ).toBe(true);
  });

  it("reports an encrypted index from the footer without reading it", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", encryptedIndex: true }).bytes,
    );
    expect(pak).toMatchObject({
      footer: { index_encrypted: true },
      index: { state: "encrypted" },
      entries: [],
    });
  });
});

describe("rejected Unreal pak files", () => {
  const valid = () => createPakFixture({ layout: "v11" });

  it("refuses an unrecognized footer", async () => {
    expect(await failure(Buffer.alloc(300))).toEqual({
      reason: "unrecognized-footer",
      kind: "unsupported",
    });
  });

  it("refuses a version 9 frozen index", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v9", frozenIndex: true }).bytes,
      ),
    ).toEqual({
      reason: "frozen-index",
      kind: "unsupported",
    });
  });

  it("rejects an index region that leaves the file", async () => {
    const { bytes } = valid();
    // Footer index size sits 4 + 8 bytes past the magic, before the SHA-1.
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(bytes.length), magic + 16);
    expect(await failure(bytes)).toEqual({
      reason: "region-out-of-bounds",
      kind: "corrupt",
    });
  });

  it("rejects an index cut short", async () => {
    const { bytes, indexSize } = valid();
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(indexSize - 6), magic + 16);
    expect((await failure(bytes)).kind).toBe("corrupt");
  });

  it("rejects duplicate legacy paths", async () => {
    const bytes = createPakFixture({
      layout: "v8b",
      files: [
        { path: "A/x", size: 1 },
        { path: "A/x", size: 1 },
      ],
    }).bytes;
    expect(await failure(bytes)).toEqual({
      reason: "duplicate-path",
      kind: "corrupt",
    });
  });

  it("refuses an index region above the limit before reading it", async () => {
    expect(
      await failure(valid().bytes, { ...LIMITS, regionBytes: 16 }),
    ).toEqual({ reason: "region-too-large", kind: "resource" });
  });

  it("refuses more entries than the limit before building them", async () => {
    expect(await failure(valid().bytes, { ...LIMITS, entries: 2 })).toEqual({
      reason: "too-many-entries",
      kind: "resource",
    });
  });

  it("lets the caller refuse an entry count before entries are built", async () => {
    const seen: number[] = [];
    await expect(
      read(valid().bytes, {
        ...LIMITS,
        beforeEntries: (count) => {
          seen.push(count);
          throw new Error("refused");
        },
      }),
    ).rejects.toThrow("refused");
    expect(seen).toEqual([PAK_FIXTURE_FILES.length]);
  });
});

describe("inconsistent Unreal pak indexes", () => {
  it("rejects a header entry count the listings do not match", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", declaredEntries: 5 }).bytes,
      ),
    ).toEqual({ reason: "entry-count-mismatch", kind: "corrupt" });
  });

  it.each(["pathHashTrailer", "directoryTrailer"] as const)(
    "rejects bytes left over after the listing (%s)",
    async (option) => {
      expect(
        await failure(
          createPakFixture({ layout: "v11", [option]: Buffer.of(1, 2, 3, 4) })
            .bytes,
        ),
      ).toEqual({ reason: "index-trailing-bytes", kind: "corrupt" });
    },
  );

  it("rejects a directory index that lists one path twice", async () => {
    const bytes = createPakFixture({
      layout: "v11",
      files: [
        { path: "A/x", size: 1 },
        { path: "A/x", size: 1 },
      ],
    }).bytes;
    expect(await failure(bytes)).toEqual({
      reason: "duplicate-path",
      kind: "corrupt",
    });
  });

  it("rejects a version 10+ reference past the encoded entries", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", firstReference: 4096 }).bytes,
      ),
    ).toEqual({ reason: "entry-reference-out-of-range", kind: "corrupt" });
  });

  it("rejects a NUL inside a version 12 file name", async () => {
    const bytes = createPakFixture({
      layout: "v12",
      files: [{ path: "A/a\0b", size: 1 }],
    }).bytes;
    expect(await failure(bytes)).toEqual({
      reason: "invalid-string",
      kind: "corrupt",
    });
  });

  it.each(["v8b", "v11"] as const)(
    "rejects a NUL inside a %s FString path",
    async (layout) => {
      const bytes = createPakFixture({
        layout,
        files: [{ path: "A/a\0b", size: 1 }],
      }).bytes;
      expect(await failure(bytes)).toEqual({
        reason: "invalid-string",
        kind: "corrupt",
      });
    },
  );

  it("rejects an entry naming an empty compression slot", async () => {
    const { bytes } = createPakFixture({ layout: "v11" });
    // The five 32-byte compression names end the footer; clear slot 1 (Zlib).
    bytes.fill(0, bytes.length - 160, bytes.length - 128);
    expect(await failure(bytes)).toEqual({
      reason: "unknown-compression-slot",
      kind: "corrupt",
    });
  });

  it.each(["index", "path hash index", "full directory index"] as const)(
    "rejects %s bytes that do not match their recorded SHA-1",
    async (region) => {
      const { bytes, indexOffset } = createPakFixture({ layout: "v11" });
      const pak = await read(Buffer.from(bytes));
      if (pak.index.state !== "decoded") throw new Error("expected an index");
      const at =
        region === "index"
          ? indexOffset
          : region === "path hash index"
            ? pak.index.path_hash_index!.region.offset
            : pak.index.full_directory_index!.region.offset;
      // Flip the last byte of the region's first u32 count or mount length.
      bytes[at + 3]! ^= 0x80;
      expect(await failure(bytes)).toEqual({
        reason: "region-hash-mismatch",
        kind: "corrupt",
      });
    },
  );

  it.each(["v8b", "v11"] as const)(
    "rejects a %s entry that ends past the data area",
    async (layout) => {
      expect(
        await failure(
          createPakFixture({ layout, lastOffsetShift: 1 << 20 }).bytes,
        ),
      ).toEqual({ reason: "entry-out-of-bounds", kind: "corrupt" });
    },
  );

  it.each(["v8b", "v11"] as const)(
    "refuses %s paths whose total length exceeds the limit before building them",
    async (layout) => {
      expect(
        await failure(createPakFixture({ layout }).bytes, {
          ...LIMITS,
          pathChars: 40,
        }),
      ).toEqual({ reason: "paths-too-large", kind: "resource" });
    },
  );
});

describe("Unreal pak record and resource guards", () => {
  /** Change index bytes, then rewrite the footer's index SHA-1 so the edit reaches the decoder. */
  const editIndex = (layout: PakFixtureLayout, at: number, edit: Buffer) => {
    const { bytes, indexOffset, indexSize } = createPakFixture({ layout });
    edit.copy(bytes, indexOffset + at);
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    createHash("sha1")
      .update(bytes.subarray(indexOffset, indexOffset + indexSize))
      .digest()
      .copy(bytes, magic + 24);
    return bytes;
  };

  it("rejects a string that runs past its region", async () => {
    // The mount point's FString length is the first index field.
    const length = Buffer.alloc(4);
    length.writeInt32LE(0x7fff);
    expect(await failure(editIndex("v8b", 0, length))).toEqual({
      reason: "truncated-record",
      kind: "corrupt",
    });
  });

  it("rejects a version 10+ index flag that is neither 0 nor 1", async () => {
    // Mount point (4 + 10 bytes), entry count (4) and path hash seed (8) precede the flag.
    expect(await failure(editIndex("v11", 26, Buffer.of(2, 0, 0, 0)))).toEqual({
      reason: "invalid-flag",
      kind: "corrupt",
    });
  });

  it("rejects a version 10+ reference into the middle of an encoded entry", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", firstReference: 2 }).bytes,
      ),
    ).toEqual({ reason: "entry-reference-out-of-range", kind: "corrupt" });
  });

  it("rejects an encrypted index region that leaves the file without reading it", async () => {
    const { bytes } = createPakFixture({ layout: "v11", encryptedIndex: true });
    const magic = bytes.lastIndexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a]));
    bytes.writeBigUInt64LE(BigInt(bytes.length), magic + 8);
    expect(await failure(bytes)).toEqual({
      reason: "region-out-of-bounds",
      kind: "corrupt",
    });
  });

  it("does not charge directories to the entry-row hook", async () => {
    const pak = await read(
      createPakFixture({ layout: "v11", emptyDirectories: 10 }).bytes,
      {
        ...LIMITS,
        beforeEntries: (count) => {
          if (count > PAK_FIXTURE_FILES.length)
            throw new Error(`charged ${count}`);
        },
      },
    );
    expect(pak.index).toMatchObject({
      full_directory_index: { directories: 13 },
    });
  });

  it("refuses more encoded records than the entry limit even when unreferenced", async () => {
    const files = Array.from({ length: 5 }, (_, at) => ({
      path: `D/${at}`,
      size: 0,
    }));
    expect(
      await failure(
        createPakFixture({
          layout: "v11",
          files,
          declaredEntries: 1,
          pathHashIndex: false,
          directoryIndex: false,
        }).bytes,
        {
          ...LIMITS,
          entries: 4,
        },
      ),
    ).toEqual({ reason: "too-many-entries", kind: "resource" });
  });

  it("rejects a path-hash row naming a misplaced record the directory index does not list", async () => {
    expect(
      await failure(
        createPakFixture({ layout: "v11", strayHashOffset: 1 << 20 }).bytes,
      ),
    ).toEqual({ reason: "entry-out-of-bounds", kind: "corrupt" });
  });

  it("counts the mount point against the path budget", async () => {
    expect(
      await failure(
        createPakFixture({
          layout: "v11",
          files: [],
          mountPoint: "M".repeat(64),
        }).bytes,
        { ...LIMITS, pathChars: 32 },
      ),
    ).toEqual({ reason: "paths-too-large", kind: "resource" });
  });

  it("lists a large path-hash-only index", async () => {
    const files = Array.from({ length: 200_000 }, (_, at) => ({
      path: `D/${at}`,
      size: 0,
    }));
    const pak = await read(
      createPakFixture({ layout: "v11", files, directoryIndex: false }).bytes,
      { ...LIMITS, entries: 300_000, regionBytes: 64 << 20 },
    );
    expect(pak.entries).toHaveLength(200_000);
  }, 60_000);

  it("reads the pruned directory index stored after the path hashes", async () => {
    const pak = await read(createPakFixture({ layout: "v11" }).bytes);
    expect(pak.index).toMatchObject({
      path_hash_index: { entries: 3, pruned_directories: 0, pruned_files: 0 },
    });
  });
});
