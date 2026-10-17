import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  IL2CPP_METADATA_COLLECTIONS,
  il2cppMetadataImageSchema,
  il2cppMetadataMethodSchema,
  il2cppMetadataObjectSchema,
  il2cppMetadataSchema,
  il2cppMetadataTypeSchema,
} from "../il2cpp/il2cppMetadata.js";
import { err, ok, type Result } from "../result.js";
import { parseAnalysisViewResult } from "./analysisViewParent.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const countsSchema = z.strictObject({
  images: z.number().int().nonnegative(),
  types: z.number().int().nonnegative(),
  methods: z.number().int().nonnegative(),
  nested_types: z.number().int().nonnegative(),
});

/** Metadata identity, index widths and sections with row counts instead of rows. */
export const il2cppMetadataSummarySchema = il2cppMetadataObjectSchema
  .omit({ images: true, types: true, methods: true })
  .extend({ counts: countsSchema });

/** Pages of decoded rows; offsets are the metadata indices of the collection. */
export const il2cppMetadataViewRequestSchema = z.strictObject({
  kind: z.literal("il2cpp-metadata"),
  collection: z.enum(IL2CPP_METADATA_COLLECTIONS),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const il2cppMetadataViewItemsSchema = z.union([
  z.array(il2cppMetadataImageSchema),
  z.array(il2cppMetadataTypeSchema),
  z.array(il2cppMetadataMethodSchema),
]);

export const il2cppMetadataViewContextSchema = z.strictObject({
  metadata_version: il2cppMetadataObjectSchema.shape.metadata_version,
  counts: countsSchema,
});

type Il2cppMetadataReport = z.infer<typeof il2cppMetadataSchema>;
interface CheckedReport {
  readonly report: Il2cppMetadataReport;
  readonly counts: z.infer<typeof countsSchema>;
}

// A sealed parent result cannot change, so its validated report and counts
// stay exact for every later page. The weak reference lets memory pressure
// reclaim them; unsealed inline input is validated on each call.
const checkedReports = new WeakMap<object, WeakRef<CheckedReport>>();

/** Validate the parent and count its rows once per sealed result. */
const parseMetadataReport = (
  parent: AnalysisViewParent,
): Result<CheckedReport, AnalysisError> => {
  const { normalizedResult } = parent;
  const sealed =
    parent.sealedResult === true &&
    typeof normalizedResult === "object" &&
    normalizedResult !== null;
  const cached = sealed
    ? checkedReports.get(normalizedResult)?.deref()
    : undefined;
  if (cached !== undefined) return ok(cached);
  const parsed = parseAnalysisViewResult(il2cppMetadataSchema, parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const checked = {
    report,
    counts: {
      images: report.images.length,
      types: report.types.length,
      methods: report.methods.length,
      nested_types: report.types.filter((type) => type.declaring_type !== -1)
        .length,
    },
  };
  if (sealed) checkedReports.set(normalizedResult, new WeakRef(checked));
  return ok(checked);
};

/** Reuse retained metadata Evidence without reopening or decoding the file. */
export const projectIl2cppMetadataView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "il2cpp-metadata")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "IL2CPP metadata Evidence supports summary and images/types/methods pages.",
        },
      ]),
    );
  const parsed = parseMetadataReport(parent);
  if (!parsed.ok) return parsed;
  const { report, counts } = parsed.value;
  const { images, types, methods, ...identity } = report;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_il2cpp_metadata" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: identity.artifact.path,
      sha256: identity.artifact.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "Names come from unencrypted metadata only; native code addresses and runtime registration remain unknown.",
      ...(parent.subject == null
        ? [
            "The parent has no recorded subject; its normalized artifact identity cannot be cross-checked against a subject digest.",
          ]
        : []),
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: { ...identity, counts },
      coverage: completeWithinViewCoverage(1, 1),
    });
  const collection = { images, types, methods }[view.collection];
  const items = collection.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "il2cpp-metadata",
    view,
    ...shared,
    items,
    metadata_version: identity.metadata_version,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, collection.length),
  });
};
