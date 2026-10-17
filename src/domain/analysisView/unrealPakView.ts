import { analysisViewInputError } from "./analysisViewErrors.js";
import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  UNREAL_PAK_COLLECTIONS,
  unrealPakEntrySchema,
  unrealPakSchema,
} from "../unreal/unrealPak.js";
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

const count = z.number().int().nonnegative();
const countsSchema = z.strictObject({
  entries: count,
  encoded_records: count,
  full_records: count,
  compressed: count,
  encrypted: count,
  deleted: count,
  without_path: count,
});

/** Footer and index facts with entry counts instead of entries. */
export const unrealPakSummarySchema = unrealPakSchema
  .omit({ entries: true })
  .extend({ counts: countsSchema });

/** Pages of index entries in the order the index lists them. */
export const unrealPakViewRequestSchema = z.strictObject({
  kind: z.literal("unreal-pak"),
  collection: z.enum(UNREAL_PAK_COLLECTIONS),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
});

export const unrealPakViewItemsSchema = z.array(unrealPakEntrySchema);

export const unrealPakViewContextSchema = z.strictObject({
  footer_layout: unrealPakSchema.shape.footer.shape.layout,
  counts: countsSchema,
});

type UnrealPakReport = z.infer<typeof unrealPakSchema>;
interface CheckedReport {
  readonly report: UnrealPakReport;
  readonly counts: z.infer<typeof countsSchema>;
}

// A sealed parent result cannot change, so its validated report and counts
// stay exact for every later page; unsealed inline input is validated on each call.
const checkedReports = new WeakMap<object, WeakRef<CheckedReport>>();

/** Validate the parent and count its entries once per sealed result. */
const parsePakReport = (
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
  const parsed = parseAnalysisViewResult(unrealPakSchema, parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const tally = (
    keep: (entry: UnrealPakReport["entries"][number]) => boolean,
  ) => report.entries.filter(keep).length;
  const checked = {
    report,
    counts: {
      entries: report.entries.length,
      encoded_records: tally((entry) => entry.record === "encoded"),
      full_records: tally((entry) => entry.record === "full"),
      compressed: tally((entry) => entry.compression_method !== 0),
      encrypted: tally((entry) => entry.encrypted),
      deleted: tally((entry) => entry.deleted),
      without_path: tally((entry) => entry.path === null),
    },
  };
  if (sealed) checkedReports.set(normalizedResult, new WeakRef(checked));
  return ok(checked);
};

/** Reuse retained pak Evidence without reopening or decoding the file. */
export const projectUnrealPakView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "unreal-pak")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message: "Unreal pak Evidence supports summary and entries pages.",
        },
      ]),
    );
  const parsed = parsePakReport(parent);
  if (!parsed.ok) return parsed;
  const { report, counts } = parsed.value;
  const { entries, ...identity } = report;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_unreal_pak" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: {
      path: identity.artifact.path,
      sha256: identity.artifact.sha256,
    },
    limitations: [...parent.limitations],
    unknowns: [
      "Entries come from the pak index only; file data, compressed contents and encrypted indexes were not read or decrypted.",
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
  const items = entries.slice(view.offset, view.offset + view.limit);
  return ok({
    kind: "unreal-pak",
    view,
    ...shared,
    items,
    footer_layout: identity.footer.layout,
    counts,
    coverage: pageViewCoverage(view.offset, items.length, entries.length),
  });
};
