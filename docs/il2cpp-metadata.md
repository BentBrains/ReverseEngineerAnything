# IL2CPP metadata

`inspect_il2cpp_metadata` / `inspect-il2cpp-metadata` decodes one selected local
Unity IL2CPP `global-metadata.dat` file and returns its assembly images, type
definitions and method definitions by name, namespace, index range and count,
with the header sections and serialized index widths. It reads the file without
running it and requires no Unity installation, IL2CPP binary, active target,
Hopper, Ghidra or IDA.

Metadata versions 29, 31 and 39 are supported. For example, Unity 2022.3.30f1
wrote version 29, 2022.3.62f3 wrote 31 and 6000.4.2f1 wrote 39; other Unity
releases that write these numbers have not been checked. Other versions are
rejected as unsupported. The path must name a regular file; directories and
symbolic links are rejected.

## MCP

MCP returns every row by default, like the other inspection tools. A large game
produces megabytes of rows, so select `detail: "summary"` first. MCP requires an
absolute filesystem path:

```json
{
  "name": "inspect_il2cpp_metadata",
  "arguments": {
    "path": "/artifacts/Data/Managed/Metadata/global-metadata.dat",
    "detail": "summary"
  }
}
```

The summary retains the complete decoded Evidence in the session and returns a
linked `inspect_analysis_view` overview: artifact identity, metadata version,
index widths, sections and `counts` (`images`, `types`, `methods` and
`nested_types`) without rows. Use `normalized_result.parent_evidence_id` to page
the original rows without reopening or decoding the file:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "il2cpp-metadata",
    "collection": "types",
    "offset": 0,
    "limit": 64
  }
}
```

Collections are `images`, `types` and `methods`. `limit` defaults to 64. The page
offset is the metadata index of the first returned row. `limit` has no cap of
its own beyond the MCP response budget. Select `detail: "complete"` to return
every row inline when the result fits that budget, as a small game's often does.

## CLI

```bash
rea inspect-il2cpp-metadata /absolute/path/global-metadata.dat --json
```

The CLI returns the complete result. It has no detail option.

## Observations

The result contains:

- `artifact`: path, SHA-256 and byte length;
- `metadata_version`: `29`, `31` or `39`;
- `index_widths`: the serialized widths (1, 2 or 4 bytes) of
  `type_definition`, `generic_container`, `parameter` and `type` indices, and
  `type_width_source`. Version 39 derives the type index width from the
  `interface-offsets-record` or the `type-definition-record`; versions 29 and
  31 always use 4-byte indices (`fixed-width-version`);
- `sections`: all 31 header sections in header order, each with `offset`, `size`
  and `count`. Versions 29 and 31 record no counts, so `count` is `null` and
  record counts come from the section sizes;
- `images`: `name`, `type_start` and `type_count`;
- `types`: `name`, `namespace`, `method_start`, `method_count`,
  `nested_type_start`, `nested_type_count` and `declaring_type`;
- `methods`: `name` and `declaring_type`;
- `limitations`.

A row's position in its collection is its metadata index, so `type_start`,
`method_start` and `declaring_type` refer to positions in `types` or `methods`.
`nested_type_start` instead indexes the metadata's `nestedTypes` table, which is
not returned; each nested type's `declaring_type` carries that relationship.
A type's `declaring_type` is derived from the `nestedTypes` section and is `-1`
for top-level types. The start of an empty range can retain the original value
`-1`.

The complete inventory of a large game is several megabytes and can exceed
the MCP response budget; summary delivery and paging avoid that. The tool has
no name search: page the collections, or filter the complete CLI JSON with a
tool such as `jq`.

## Failures

A file whose magic is not `0xFAB11BAF` fails as an unsupported target with
`unrecognized-magic`. The file may be encrypted or may not be IL2CPP metadata.
A version other than 29, 31 or 39 fails as an unsupported target with
`unsupported-version`.

Damaged metadata returns an input error (`invalid_format`) whose
message names one reason:

| Reason                    | Meaning                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `truncated-header`        | The file is shorter than the header.                                                                             |
| `unexpected-header-size`  | `stringLiterals.offset` is not the header size: 256 bytes for versions 29 and 31, 380 for 39.                    |
| `section-out-of-bounds`   | A section extends beyond the file, or a non-empty section starts inside the header.                              |
| `section-overlap`         | Two sections overlap. Zero-size sections are exempt and gaps are allowed.                                        |
| `record-size-mismatch`    | A section size does not divide into its records, or the record size differs from the one the index widths imply. |
| `type-index-width`        | The record used to derive the type index width implies no 1, 2 or 4 byte width.                                  |
| `index-out-of-range`      | A serialized index or range points outside its target collection.                                                |
| `nested-type-conflict`    | A type is listed as nested in two types, in itself, or in a cycle of declaring types.                            |
| `declaring-type-mismatch` | A method inside a type's method range names a different type, or a method lies outside its type's range.         |
| `image-range-overlap`     | Two images claim the same type definitions.                                                                      |
| `invalid-string`          | A name index does not start a string, or the name is unterminated or not valid UTF-8.                            |

A version field that disagrees with the file's layout, for example a version
39 file relabeled as 29, usually surfaces as `unexpected-header-size` or
`record-size-mismatch`.

Two checks are stricter than the IL2CPP runtime: a name index must start a
string, and an empty range's start must lie between -1 and the collection size.
Every Unity-written file checked so far satisfies both; metadata rewritten by
other tools may be rejected.

There is no partial success. A file that changes during reading and a cancelled
request keep their own distinct errors. Resource guards bound the selected file
to 256 MiB and the complete report to 64 MiB. MCP also applies its
[response transport budget](mcp-contracts.md); a complete report within the
report limit can still require the summary and paging path.

## Outside this tool

- Decrypting or deobfuscating protected metadata.
- Linking metadata to the native binary (`GameAssembly`, `UnityFramework`),
  including method RVAs and code addresses.
- Fields, properties, signatures, parameters and generic instances.
- Ghidra or other disassembler integration. Use the
  [native workflow](native-investigation.md) for native code.
- Metadata versions other than 29, 31 and 39.

Names come from the metadata file only. They do not establish which methods
were compiled into the native binary or how they behave at runtime.

## Real producer verification

`npm run verify:il2cpp:metadata -- --metadata PATH` exercises a caller-supplied
`global-metadata.dat` through the public CLI and MCP. It is opt-in, like
`verify:pcap`, because no real game metadata ships with the repository. Normal
inspection does not need it.
