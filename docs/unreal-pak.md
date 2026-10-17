# Unreal pak indexes

`inspect_unreal_pak` (CLI: `inspect-unreal-pak`) reads the footer and index of
one local Unreal Engine `.pak` file and returns every index entry: path,
offset, stored and uncompressed size, compression method, block count and size,
encryption and deletion flags, and the SHA-1 stored with full records. It reads
only the footer and the index regions the footer names, so a multi-gigabyte pak
is inspected without loading it; the whole file is still hashed for artifact
identity. It does not extract, decompress or decrypt file data and starts no
Unreal process.

Pak versions 1 to 12 are decoded. The tool reports the serialized version and
footer layout (`v8a` and `v8b` share version 8) and never attributes a version
to an engine release. The path must name a regular file; symbolic links are
rejected.

## MCP

MCP returns every entry by default, like the other inspection tools. For a large
pak, select `detail: "summary"` first:

```json
{
  "name": "inspect_unreal_pak",
  "arguments": {
    "path": "/artifacts/Content/Paks/Game-Windows.pak",
    "detail": "summary"
  }
}
```

The summary retains the complete Evidence in the session and returns the
footer, the index facts and `counts` (`entries`, `encoded_records`,
`full_records`, `compressed`, `encrypted`, `deleted`, `without_path`). Page the
entries in index order without reopening the file:

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": {
      "kind": "retained-evidence",
      "evidence_id": "<parent_evidence_id>"
    },
    "view": {
      "kind": "unreal-pak",
      "collection": "entries",
      "offset": 0,
      "limit": 64
    }
  }
}
```

## CLI

```bash
rea inspect-unreal-pak /absolute/path/Game-Windows.pak --json
```

The CLI always returns the complete report.

## Observations

- **Footer.** Found by trying each layout's fixed size from the end of the file,
  newest first; the magic and the serialized version must both match. It gives
  the index region and its SHA-1, the index encryption flag (version 4+), the
  encryption key GUID as stored (version 7+), the frozen-index flag (version 9)
  and the compression method names (version 8+).
- **Legacy index (versions 1 to 9).** A mount point, then each path with a full
  entry record.
- **Version 10+ index.** A mount point, the entry count, the path hash seed, the
  locations of the path hash index and the full directory index, a blob of
  bit-packed entries and a list of full records. Paths come from the full
  directory index. Without one, entries are listed from the path hash index
  with `path: null` and their 64-bit `path_hash`. The path hash index region
  also holds a pruned directory index after the hashes; its directory and file
  counts are reported and its references are checked. The header entry count,
  the path hash count, the directory index file count and the decoded entries
  must all agree.
- **Integrity.** The index, path hash index and full directory index bytes must
  match the SHA-1 recorded for them, and every entry's offset plus stored size
  must end before the index. The per-entry SHA-1 of file data is reported, not
  checked, because file data is not read. Footer fields (compression names, the
  key GUID and the flags) have no recorded hash and are reported as stored.
- **Version 12.** Reported as layout `v12`; its bytes are arranged like the
  version 11 footer. In the directory
  listings, directory names keep the FString form and file names are UTF-8
  byte counts without a terminator; a NUL inside a name is rejected. This was
  observed on a pak written by Unreal Engine 5.8.3.
- **Block facts.** `compression_blocks` and `compression_block_size` are the
  values stored in the index. Unreal Engine 5.8.3 writes a block size of 0 for
  some single-block entries; it is reported as 0, not replaced by the
  uncompressed size.
- **Compression names.** `compression_method` 0 means stored, with
  `compression_name: null`. In version 8+ any other value counts from 1 into the
  footer table (`compression_methods[method - 1]`), and a method naming an empty
  or missing slot is rejected. Before version 8, from the legacy
  flag values (1 `Zlib`, 2 `Gzip`, 4 `Custom`); other legacy values keep their
  raw `compression_method` with `compression_name: null`. Names identify
  methods; no data is decompressed, so they are not codec verification.
- **Encrypted index.** Reported with `index.state: "encrypted"`, the footer
  facts and no entries. No key is accepted and nothing is decrypted.

## Failures

| Reason                         | Kind        | Meaning                                                                                |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------------- |
| `unrecognized-footer`          | unsupported | No pak footer layout matches the end of the file.                                      |
| `frozen-index`                 | unsupported | Version 9 frozen indexes store a serialized memory image.                              |
| `region-out-of-bounds`         | corrupt     | An index region ends past the footer or a 64-bit value exceeds the safe integer range. |
| `truncated-record`             | corrupt     | A record or declared block list ends past its region.                                  |
| `invalid-string`               | corrupt     | A string lacks its terminator or is not valid UTF-8.                                   |
| `invalid-flag`                 | corrupt     | A boolean field is neither 0 nor 1.                                                    |
| `index-trailing-bytes`         | corrupt     | The index or a listing region has bytes after its last record.                         |
| `entry-reference-out-of-range` | corrupt     | A directory or path hash entry names no record start.                                  |
| `duplicate-path`               | corrupt     | A listing names one path, or the path hash index one hash, twice.                      |
| `entry-count-mismatch`         | corrupt     | The header entry count disagrees with a listing or the decoded entries.                |
| `unknown-compression-slot`     | corrupt     | A version 8+ entry names an empty or missing compression slot.                         |
| `region-hash-mismatch`         | corrupt     | An index region does not match its recorded SHA-1.                                     |
| `entry-out-of-bounds`          | corrupt     | An entry's stored bytes would end past the data area.                                  |
| `region-too-large`             | resource    | An index region exceeds 256 MiB.                                                       |
| `too-many-entries`             | resource    | An index declares more than 1,000,000 entries.                                         |
| `paths-too-large`              | resource    | Directory and file names would build more path text than the 64 MiB report allows.     |

The complete report is limited to 64 MiB. It is refused from the declared entry
count before entries are built when even minimal rows would exceed it. There is
no partial success.

## Outside this tool

- Extracting, decompressing or decrypting file data, and accepting keys.
- IoStore containers (`.utoc`/`.ucas`) and `.uasset` contents.
- Attributing a pak version to an engine release.

## Real producer verification

`npm run verify:unreal:pak -- --pak PATH` compares the CLI with stdio MCP for a
caller-owned pak and checks summary and page parity. Pak files from games are
not redistributable, so CI uses synthetic fixtures.
