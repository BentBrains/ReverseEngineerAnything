import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Footer layouts in the order a reader tries them, newest first. */
export const UNREAL_PAK_FOOTER_LAYOUTS = [
  "v12",
  "v11",
  "v10",
  "v9",
  "v8b",
  "v8a",
  "v7",
  "v6",
  "v5",
  "v4",
  "v3",
  "v2",
  "v1",
] as const;

export const UNREAL_PAK_COLLECTIONS = ["entries"] as const;

const count = z.number().int().nonnegative();
const offset = z.number().int().nonnegative();
const hex = (bytes: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u"));

/** One explicit local .pak file; detail selects delivery, never decoding coverage. */
export const inspectUnrealPakInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to an Unreal Engine .pak file",
  ),
  detail: z
    .enum(["complete", "summary"])
    .default("complete")
    .describe(
      "complete (default) returns every index entry inline; summary retains every entry and returns counts with a linked inspect_analysis_view summary",
    ),
});

const regionSchema = z.strictObject({
  offset,
  size: count,
  sha1: hex(20),
});

/** Container facts read from the fixed footer at the end of the file. */
export const unrealPakFooterSchema = z.strictObject({
  offset,
  size: count,
  layout: z.enum(UNREAL_PAK_FOOTER_LAYOUTS),
  /** The serialized version number; 8 covers both the v8a and v8b layouts. */
  version: z.number().int().min(1).max(12),
  index: regionSchema,
  /** null before version 4, which has no index encryption flag. */
  index_encrypted: z.boolean().nullable(),
  /** null before version 7; an all-zero GUID is recorded as observed. */
  encryption_key_guid: hex(16).nullable(),
  /** null except in version 9. */
  frozen_index: z.boolean().nullable(),
  /** Version 8+ compression names by slot; empty slots are null. */
  compression_methods: z.array(z.string().nullable()),
});

export const unrealPakEntrySchema = z.strictObject({
  /** null when only the path hash index names the entry. */
  path: z.string().nullable(),
  /** FNV-64 path hash, present for entries found through the path hash index. */
  path_hash: hex(8).nullable(),
  offset,
  size: count,
  uncompressed_size: count,
  /** Raw serialized compression value; 0 means stored. */
  compression_method: count,
  /** Name from the footer table (version 8+) or the legacy flag value. */
  compression_name: z.string().nullable(),
  compression_blocks: count,
  compression_block_size: count,
  encrypted: z.boolean(),
  deleted: z.boolean(),
  /** SHA-1 stored with full entry records; encoded records carry none. */
  sha1: hex(20).nullable(),
  record: z.enum(["full", "encoded"]),
});

const directoryIndexSchema = z.strictObject({
  region: regionSchema,
  directories: count,
  files: count,
});

const pathHashIndexSchema = z.strictObject({
  region: regionSchema,
  entries: count,
  /** The pruned directory index stored after the hashes in the same region. */
  pruned_directories: count,
  pruned_files: count,
});

/** A decoded index, or an encrypted one recorded without decryption. */
export const unrealPakIndexSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("decoded"),
    mount_point: z.string(),
    entry_count: count,
    path_hash_seed: hex(8).nullable(),
    path_hash_index: pathHashIndexSchema.nullable(),
    full_directory_index: directoryIndexSchema.nullable(),
  }),
  z.strictObject({ state: z.literal("encrypted") }),
]);

export const unrealPakSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    sha256: digestSchema,
    bytes: count,
  }),
  footer: unrealPakFooterSchema,
  index: unrealPakIndexSchema,
  entries: z.array(unrealPakEntrySchema),
  limitations: z.array(z.string()),
});

export type UnrealPak = z.infer<typeof unrealPakSchema>;
export type UnrealPakEntry = z.infer<typeof unrealPakEntrySchema>;
export type UnrealPakFooter = z.infer<typeof unrealPakFooterSchema>;
export type UnrealPakProviderInput = Omit<
  z.infer<typeof inspectUnrealPakInputSchema>,
  "detail"
>;
