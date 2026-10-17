import { z } from "zod";
import { unrealPakSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  inspectUnrealPakInputSchema,
  unrealPakSchema,
} from "../../domain/unreal/unrealPak.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static pak indexes are independent of native-analysis providers and Unreal installations. */
export const UNREAL_TOOL_CONTRACTS = [
  {
    name: "inspect_unreal_pak",
    ...toolContractMetadata("inspect_unreal_pak"),
    kind: "artifact-provider",
    description:
      "Inspect an explicit local Unreal Engine .pak file (pak versions 1 to 12) and return its footer (version, index region and SHA-1, index encryption flag, key GUID, compression method names) and every index entry: path, offset, size, uncompressed size, compression method, block count and size, encryption and deletion flags, and the SHA-1 stored with full records. Only the footer and index regions are read, so multi-gigabyte paks are inspected without loading them; the whole file is still hashed for artifact identity. By default returns every entry inline; detail summary retains the complete Evidence and returns footer, index facts and entry counts, then page entries with inspect_analysis_view kind unreal-pak and normalized_result.parent_evidence_id. Does not extract, decompress or decrypt file data, accepts no key, and does not attribute the pak version to an engine release. An encrypted index is reported as encrypted with footer facts only. Unrecognized footers and version 9 frozen indexes are unsupported; truncated records, out-of-file regions, invalid strings or flags, trailing index bytes, dangling entry references, duplicate paths, disagreeing entry counts, empty compression slots, index regions that fail their recorded SHA-1 and entries ending past the data area are rejected with a reason and no partial success. Resource guards bound each index region to 256 MiB, entries to 1,000,000, and built paths and the complete report to 64 MiB.",
    inputSchema: inspectUnrealPakInputSchema,
    outputSchema: evidenceResultOf(
      z.union([unrealPakSchema, unrealPakSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize a pak index and retain entries for paging",
        input: {
          path: "/artifacts/Content/Paks/Game-Windows.pak",
          detail: "summary",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
