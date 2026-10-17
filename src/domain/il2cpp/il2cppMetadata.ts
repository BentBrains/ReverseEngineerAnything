import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Header section order shared by global-metadata.dat versions 29, 31 and 39. */
export const IL2CPP_METADATA_SECTION_NAMES = [
  "stringLiterals",
  "stringLiteralData",
  "strings",
  "events",
  "properties",
  "methods",
  "parameterDefaultValues",
  "fieldDefaultValues",
  "fieldAndParameterDefaultValueData",
  "fieldMarshaledSizes",
  "parameters",
  "fields",
  "genericParameters",
  "genericParameterConstraints",
  "genericContainers",
  "nestedTypes",
  "interfaces",
  "vtableMethods",
  "interfaceOffsets",
  "typeDefinitions",
  "images",
  "assemblies",
  "fieldRefs",
  "referencedAssemblies",
  "attributeData",
  "attributeDataRanges",
  "unresolvedIndirectCallParameterTypes",
  "unresolvedIndirectCallParameterRanges",
  "windowsRuntimeTypeNames",
  "windowsRuntimeStrings",
  "exportedTypeDefinitions",
] as const;

/** Decoded metadata versions; 29 and 31 use fixed 4-byte indices. */
export const IL2CPP_METADATA_VERSIONS = [29, 31, 39] as const;

export const IL2CPP_METADATA_COLLECTIONS = [
  "images",
  "types",
  "methods",
] as const;

const count = z.number().int().nonnegative();
/** Serialized metadata indices use -1 for an absent reference. */
const optionalIndex = z.number().int().min(-1);
const indexWidth = z.union([z.literal(1), z.literal(2), z.literal(4)]);

/** One explicit local file; detail selects delivery, never decoding coverage. */
export const inspectIl2cppMetadataInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to a Unity IL2CPP global-metadata.dat file",
  ),
  detail: z
    .enum(["complete", "summary"])
    .default("complete")
    .describe(
      "complete (default) returns every image, type and method row inline; summary retains every row and returns counts with a linked inspect_analysis_view summary",
    ),
});

export const il2cppMetadataSectionSchema = z.strictObject({
  name: z.enum(IL2CPP_METADATA_SECTION_NAMES),
  offset: count,
  size: count,
  /** Header-recorded entry count; versions 29 and 31 record none. */
  count: count.nullable(),
});

/** Assembly image and its contiguous type-definition range. */
export const il2cppMetadataImageSchema = z.strictObject({
  name: z.string(),
  type_start: optionalIndex,
  type_count: count,
});

/** Type definition; row position is its TypeDefinitionIndex. */
export const il2cppMetadataTypeSchema = z.strictObject({
  name: z.string(),
  namespace: z.string(),
  method_start: optionalIndex,
  method_count: count,
  nested_type_start: optionalIndex,
  nested_type_count: count,
  /** Enclosing type derived from the nestedTypes section; -1 for top-level types. */
  declaring_type: optionalIndex,
});

/** Method definition; row position is its MethodIndex. */
export const il2cppMetadataMethodSchema = z.strictObject({
  name: z.string(),
  declaring_type: optionalIndex,
});

/** Unrefined report fields, shared with projections that omit row collections. */
export const il2cppMetadataObjectSchema = z.strictObject({
  artifact: z.strictObject({
    path: localPathStringSchema,
    sha256: digestSchema,
    bytes: count,
  }),
  metadata_version: z.union(
    IL2CPP_METADATA_VERSIONS.map((version) => z.literal(version)),
  ),
  index_widths: z.strictObject({
    type_definition: indexWidth,
    generic_container: indexWidth,
    parameter: indexWidth,
    type: indexWidth,
    type_width_source: z.enum([
      "interface-offsets-record",
      "type-definition-record",
      "fixed-width-version",
    ]),
  }),
  sections: z
    .array(il2cppMetadataSectionSchema)
    .length(IL2CPP_METADATA_SECTION_NAMES.length),
  images: z.array(il2cppMetadataImageSchema),
  types: z.array(il2cppMetadataTypeSchema),
  methods: z.array(il2cppMetadataMethodSchema),
  limitations: z.array(z.string()),
});

/** Complete name and count inventory of one decoded global-metadata.dat file. */
export const il2cppMetadataSchema = il2cppMetadataObjectSchema.superRefine(
  (report, context) => {
    report.sections.forEach((section, index) => {
      if (section.name !== IL2CPP_METADATA_SECTION_NAMES[index])
        context.addIssue({
          code: "custom",
          path: ["sections", index, "name"],
          message: "Sections must follow header order.",
        });
      if (section.offset + section.size > report.artifact.bytes)
        context.addIssue({
          code: "custom",
          path: ["sections", index],
          message: "Section range is outside the selected artifact.",
        });
    });
  },
);

export type InspectIl2cppMetadataInput = z.infer<
  typeof inspectIl2cppMetadataInputSchema
>;
export type Il2cppMetadataProviderInput = Omit<
  InspectIl2cppMetadataInput,
  "detail"
>;
export type Il2cppMetadataSection = z.infer<typeof il2cppMetadataSectionSchema>;
export type Il2cppMetadata = z.infer<typeof il2cppMetadataSchema>;
