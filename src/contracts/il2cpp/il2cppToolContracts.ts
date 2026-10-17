import { z } from "zod";
import { il2cppMetadataSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  il2cppMetadataSchema,
  inspectIl2cppMetadataInputSchema,
} from "../../domain/il2cpp/il2cppMetadata.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static IL2CPP metadata is independent of native-analysis providers and Unity installations. */
export const IL2CPP_TOOL_CONTRACTS = [
  {
    name: "inspect_il2cpp_metadata",
    ...toolContractMetadata("inspect_il2cpp_metadata"),
    kind: "artifact-provider",
    description:
      "Inspect an explicit local Unity IL2CPP global-metadata.dat (metadata versions 29, 31 and 39) and return its assembly images, type definitions and method definitions by name, namespace, index range and count, plus header sections and serialized index widths. Type declaring_type comes from the nestedTypes section; row positions are metadata indices, except nested_type_start, which indexes the unreturned nestedTypes table (find nested types by declaring_type). By default returns every row inline. A large game returns megabytes of rows and can exceed the transport; detail summary retains the complete Evidence and returns identity, sections and counts, then page images/types/methods with inspect_analysis_view kind il2cpp-metadata and normalized_result.parent_evidence_id. Runs no Unity, IL2CPP binary or disassembler, does not decrypt, and does not recover native code addresses, fields, signatures or runtime behavior. Unrecognized magic and other versions are unsupported; damaged headers, overlapping sections, inconsistent record sizes, out-of-range indices, inconsistent nesting, method ownership or image ranges and invalid strings are rejected with a reason and no partial success. Resource guards bound files to 256 MiB and the complete report to 64 MiB.",
    inputSchema: inspectIl2cppMetadataInputSchema,
    outputSchema: evidenceResultOf(
      z.union([il2cppMetadataSchema, il2cppMetadataSummaryViewResultSchema]),
    ),
    examples: [
      {
        title: "Summarize metadata and retain rows for paging",
        input: {
          path: "/artifacts/Data/Managed/Metadata/global-metadata.dat",
          detail: "summary",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
