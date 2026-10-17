import { IL2CPP_METADATA_SECTION_NAMES } from "../../../src/domain/il2cpp/il2cppMetadata.js";

type SectionName = (typeof IL2CPP_METADATA_SECTION_NAMES)[number];
type Width = 1 | 2 | 4;

/** Synthetic version 39 metadata small enough to read in a hex dump. */
export interface Il2cppMetadataFixtureOptions {
  /** Serialized TypeIndex width. */
  readonly typeIndexWidth?: Width;
  /** Omit interfaceOffsets so the TypeIndex width comes from type records. */
  readonly interfaceOffsets?: boolean;
  /** Raw interfaceOffsets record size; defaults to 4 + typeIndexWidth. */
  readonly interfaceOffsetRecordBytes?: number;
  /** Make type 1 also list type 0, so 0 and 1 nest in each other. */
  readonly nestingCycle?: boolean;
  /** Append an image with no types, whose start is the -1 sentinel at the narrow width. */
  readonly emptyImage?: boolean;
  /** Metadata version; 29 and 31 use fixed 4-byte indices and no header counts. */
  readonly version?: 29 | 31 | 39;
  /**
   * Version 39 entry counts that widen the serialized indices: filler type
   * definitions (the last owns one extra method), and generic container and
   * parameter sections whose records are zero-filled and never decoded.
   */
  readonly wide?: {
    readonly fillerTypes: number;
    readonly genericContainers: number;
    readonly parameters: number;
  };
}

const widthFor = (entries: number): Width =>
  entries <= 0xff ? 1 : entries <= 0xffff ? 2 : 4;

/** Type and method rows a fixture holds, including any wide-index filler. */
export const fixtureRows = (options: Il2cppMetadataFixtureOptions = {}) => {
  const fillers = options.wide?.fillerTypes ?? 0;
  const last = FIXTURE_TYPES.length + fillers - 1;
  const types = [
    ...FIXTURE_TYPES,
    ...Array.from({ length: fillers }, (_, index) => ({
      name: "Filler",
      namespace: "",
      method_start: index === fillers - 1 ? FIXTURE_METHODS.length : -1,
      method_count: index === fillers - 1 ? 1 : 0,
      nested_type_start: -1,
      nested_type_count: 0,
      declaring_type: -1,
    })),
  ];
  const methods = [
    ...FIXTURE_METHODS,
    ...(fillers === 0 ? [] : [{ name: "Fill", declaring_type: last }]),
  ];
  return { types, methods };
};

export const FIXTURE_IMAGES = [
  { name: "Assembly-CSharp.dll", type_start: 0, type_count: 3 },
  { name: "mscorlib.dll", type_start: 3, type_count: 1 },
] as const;

export const FIXTURE_TYPES = [
  {
    name: "Player",
    namespace: "Game",
    method_start: 0,
    method_count: 2,
    nested_type_start: 0,
    nested_type_count: 1,
    declaring_type: -1,
  },
  {
    name: "Slot",
    namespace: "",
    method_start: 2,
    method_count: 1,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: 0,
  },
  {
    name: "<Module>",
    namespace: "",
    method_start: -1,
    method_count: 0,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: -1,
  },
  {
    name: "Größe",
    namespace: "System",
    method_start: 3,
    method_count: 2,
    nested_type_start: -1,
    nested_type_count: 0,
    declaring_type: -1,
  },
] as const;

export const FIXTURE_METHODS = [
  { name: ".ctor", declaring_type: 0 },
  { name: "Update", declaring_type: 0 },
  { name: "Add", declaring_type: 1 },
  { name: ".ctor", declaring_type: 3 },
  { name: "ToString", declaring_type: 3 },
] as const;

const writeIndex = (
  target: Buffer,
  offset: number,
  width: Width,
  value: number,
) => {
  if (width === 1) target.writeUInt8(value === -1 ? 0xff : value, offset);
  else if (width === 2)
    target.writeUInt16LE(value === -1 ? 0xffff : value, offset);
  else target.writeInt32LE(value, offset);
};

/** Built bytes with helpers that address header fields and records by name. */
export interface Il2cppMetadataFixture {
  readonly bytes: Buffer;
  readonly typeIndexWidth: Width;
  readonly recordBytes: {
    readonly typeDefinitions: number;
    readonly images: number;
    readonly methods: number;
  };
  /** Byte offset of a header entry field; only version 39 records counts. */
  header(name: SectionName, field: "offset" | "size" | "count"): number;
  section(name: SectionName): {
    offset: number;
    size: number;
    count: number | null;
  };
  record(name: "typeDefinitions" | "images" | "methods", index: number): number;
  /** Absolute offset of a string's first byte in the strings section. */
  stringOffset(value: string): number;
}

type SectionContent = { bytes: Buffer; count: number };

/** Write the header and lay out non-empty sections in header order. */
const assembleFile = (
  version: 29 | 31 | 39,
  contents: ReadonlyMap<SectionName, SectionContent>,
) => {
  const fixed = version !== 39;
  const entryBytes = fixed ? 8 : 12;
  const headerBytes = 8 + IL2CPP_METADATA_SECTION_NAMES.length * entryBytes;
  const header = Buffer.alloc(headerBytes);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(version, 4);
  const body: Buffer[] = [];
  let cursor = headerBytes;
  IL2CPP_METADATA_SECTION_NAMES.forEach((name, index) => {
    const content = contents.get(name);
    const at = 8 + index * entryBytes;
    header.writeInt32LE(cursor, at);
    header.writeInt32LE(content?.bytes.length ?? 0, at + 4);
    if (!fixed) header.writeInt32LE(content?.count ?? 0, at + 8);
    if (content !== undefined) {
      body.push(content.bytes);
      cursor += content.bytes.length;
    }
  });
  const bytes = Buffer.concat([header, ...body]);
  const headerField = (
    name: SectionName,
    field: "offset" | "size" | "count",
  ) => {
    if (fixed && field === "count")
      throw new Error(`Version ${version} headers record no counts`);
    return (
      8 +
      IL2CPP_METADATA_SECTION_NAMES.indexOf(name) * entryBytes +
      { offset: 0, size: 4, count: 8 }[field]
    );
  };
  const section = (name: SectionName) => ({
    offset: bytes.readInt32LE(headerField(name, "offset")),
    size: bytes.readInt32LE(headerField(name, "size")),
    count: fixed ? null : bytes.readInt32LE(headerField(name, "count")),
  });
  return { bytes, headerField, section };
};

/** Image rows a fixture holds, including the optional empty image. */
export const fixtureImages = (options: Il2cppMetadataFixtureOptions = {}) => [
  ...FIXTURE_IMAGES,
  ...(options.emptyImage === true
    ? [{ name: "Empty.dll", type_start: -1, type_count: 0 }]
    : []),
];

/** Lay sections out in header order; empty sections share the next offset. */
export const createIl2cppMetadataFixture = (
  options: Il2cppMetadataFixtureOptions = {},
): Il2cppMetadataFixture => {
  const version = options.version ?? 39;
  const fixed = version !== 39;
  const T: Width = fixed ? 4 : (options.typeIndexWidth ?? 1);
  const rows = fixtureRows(options);
  const genericContainers = options.wide?.genericContainers ?? 0;
  const parameterCount = options.wide?.parameters ?? 0;
  const D: Width = fixed ? 4 : widthFor(rows.types.length);
  const G: Width = fixed ? 4 : widthFor(genericContainers);
  const P: Width = fixed ? 4 : widthFor(parameterCount);
  // Versions 29 and 31 also store elementTypeIndex in type records.
  const typeIndexFields = fixed ? 4 : 3;
  // Version 31 added returnParameterToken to method records.
  const returnToken = version === 29 ? 0 : 4;
  const nestedTypeEntries = options.nestingCycle === true ? [1, 0] : [1];
  const typeRows = rows.types.map((type, index) =>
    options.nestingCycle === true && index === 1
      ? { ...type, nested_type_start: 1, nested_type_count: 1 }
      : type,
  );
  const recordBytes = {
    typeDefinitions: 68 + typeIndexFields * T + G,
    images: 32 + 2 * D,
    methods: 16 + returnToken + D + T + P + G,
  };

  const stringParts: Buffer[] = [];
  const stringIndex = new Map<string, number>();
  let stringBytes = 0;
  const intern = (value: string) => {
    const known = stringIndex.get(value);
    if (known !== undefined) return known;
    const encoded = Buffer.from(`${value}\0`, "utf8");
    stringIndex.set(value, stringBytes);
    stringParts.push(encoded);
    stringBytes += encoded.length;
    return stringIndex.get(value)!;
  };
  const imageRows = fixtureImages(options);
  for (const image of imageRows) intern(image.name);
  for (const type of FIXTURE_TYPES) {
    intern(type.name);
    intern(type.namespace);
  }
  for (const row of [...rows.types, ...rows.methods]) intern(row.name);
  const strings = Buffer.concat(stringParts);

  const types = Buffer.alloc(typeRows.length * recordBytes.typeDefinitions);
  typeRows.forEach((type, index) => {
    let at = index * recordBytes.typeDefinitions;
    types.writeInt32LE(intern(type.name), at);
    types.writeInt32LE(intern(type.namespace), at + 4);
    at += 8;
    // byval, native declaring and parent TypeIndex values are deliberately
    // unrelated to nesting; the reader must use nestedTypes instead.
    for (let field = 0; field < typeIndexFields; field += 1, at += T)
      writeIndex(types, at, T, 0x2a);
    writeIndex(types, at, G, -1);
    at += G + 4;
    const starts = [-1, type.method_start, -1, -1, type.nested_type_start];
    starts.forEach((value, field) => types.writeInt32LE(value, at + field * 4));
    types.writeInt32LE(-1, at + 20);
    types.writeInt32LE(-1, at + 24);
    types.writeInt32LE(-1, at + 28);
    at += 32;
    types.writeUInt16LE(type.method_count, at);
    types.writeUInt16LE(type.nested_type_count, at + 8);
    at += 16;
    types.writeUInt32LE(0, at);
    types.writeUInt32LE(0x02000001 + index, at + 4);
  });

  const images = Buffer.alloc(imageRows.length * recordBytes.images);
  imageRows.forEach((image, index) => {
    const at = index * recordBytes.images;
    images.writeInt32LE(intern(image.name), at);
    images.writeInt32LE(index, at + 4);
    writeIndex(images, at + 8, D, image.type_start);
    images.writeUInt32LE(image.type_count, at + 8 + D);
    writeIndex(images, at + 12 + D, D, -1);
    images.writeUInt32LE(0, at + 12 + 2 * D);
    images.writeInt32LE(-1, at + 16 + 2 * D);
  });

  const methods = Buffer.alloc(rows.methods.length * recordBytes.methods);
  rows.methods.forEach((method, index) => {
    const at = index * recordBytes.methods;
    methods.writeInt32LE(intern(method.name), at);
    writeIndex(methods, at + 4, D, method.declaring_type);
    writeIndex(methods, at + 4 + D, T, 0);
    const parameterStart = at + 4 + D + T + returnToken;
    writeIndex(methods, parameterStart, P, -1);
    writeIndex(methods, parameterStart + P, G, -1);
    methods.writeUInt32LE(0x06000001 + index, parameterStart + P + G);
  });

  const nested = Buffer.alloc(nestedTypeEntries.length * 4);
  nestedTypeEntries.forEach((value, index) =>
    nested.writeInt32LE(value, index * 4),
  );

  const interfaceOffsetBytes = options.interfaceOffsetRecordBytes ?? 4 + T;
  const interfaceOffsets =
    options.interfaceOffsets === false
      ? null
      : Buffer.alloc(interfaceOffsetBytes);

  const contents = new Map<SectionName, SectionContent>([
    ["strings", { bytes: strings, count: stringIndex.size }],
    ["methods", { bytes: methods, count: rows.methods.length }],
    ...(genericContainers === 0
      ? []
      : [
          [
            "genericContainers",
            {
              bytes: Buffer.alloc(genericContainers * 16),
              count: genericContainers,
            },
          ] as [SectionName, SectionContent],
        ]),
    ...(parameterCount === 0
      ? []
      : [
          [
            "parameters",
            {
              bytes: Buffer.alloc(parameterCount * (8 + T)),
              count: parameterCount,
            },
          ] as [SectionName, SectionContent],
        ]),
    ["nestedTypes", { bytes: nested, count: nestedTypeEntries.length }],
    ["typeDefinitions", { bytes: types, count: typeRows.length }],
    ["images", { bytes: images, count: imageRows.length }],
    ...(interfaceOffsets === null
      ? []
      : [
          ["interfaceOffsets", { bytes: interfaceOffsets, count: 1 }] as [
            SectionName,
            SectionContent,
          ],
        ]),
  ]);

  const { bytes, headerField, section } = assembleFile(version, contents);
  return {
    bytes,
    typeIndexWidth: T,
    recordBytes,
    header: headerField,
    section,
    record: (name, index) => section(name).offset + index * recordBytes[name],
    stringOffset: (value) => {
      const index = stringIndex.get(value);
      if (index === undefined) throw new Error(`Unknown string ${value}`);
      return section("strings").offset + index;
    },
  };
};
