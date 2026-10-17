import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../analysisView/AnalysisViewService.js";
import type { Il2cppMetadataPort } from "./Il2cppMetadataPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  il2cppMetadataSchema,
  inspectIl2cppMetadataInputSchema,
} from "../../domain/il2cpp/il2cppMetadata.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_il2cpp_metadata";
const NO_RETENTION: AnalysisViewRetention = {
  evidenceById: undefined,
  recordEvidence: undefined,
};

/** Shared exact input validation, artifact-bound Evidence and summary delivery for CLI and MCP. */
export class Il2cppMetadataService {
  constructor(readonly provider: Il2cppMetadataPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /** Inspect one explicitly selected file; detail changes delivery, not decoded coverage. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
    retention: AnalysisViewRetention = NO_RETENTION,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectIl2cppMetadataInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const { detail, ...providerInput } = input.data;
    if (detail === "summary") {
      const ready = requireAnalysisViewRetention(OPERATION, retention);
      if (!ready.ok) return ready;
    }
    const inspected = await this.provider.inspect(providerInput, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = il2cppMetadataSchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== providerInput.path)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "IL2CPP metadata reader returned malformed metadata or changed the selected artifact identity.",
        ),
      );
    const value = report.data;
    const evidence = createEvidence(
      {
        path: value.artifact.path,
        sha256: value.artifact.sha256,
        format: "file",
      },
      this.provider.identity,
      {
        operation: OPERATION,
        parameters: providerInput,
        result: value,
        confidence: "observed",
        limitations: value.limitations,
        locations: [
          { kind: "artifact-path", path: value.artifact.path },
          ...value.sections
            .filter(
              ({ name, size }) =>
                size > 0 &&
                (name === "images" ||
                  name === "typeDefinitions" ||
                  name === "methods" ||
                  name === "nestedTypes" ||
                  name === "strings"),
            )
            .map(({ offset, size }) => ({
              kind: "file-offset-range" as const,
              start: offset,
              end: offset + size,
            })),
        ],
      },
    );
    return detail === "summary"
      ? summarizeRetainedAnalysis(evidence, retention)
      : ok(evidence);
  }
}
