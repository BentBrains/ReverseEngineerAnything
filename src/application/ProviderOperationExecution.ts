import { z } from "zod";
import type {
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "./AnalysisProvider.js";

/** Validated caller-selected request carrying its operation input. */
export interface ProviderOperationRequest {
  readonly input: unknown;
}

/** Provider boundary executing one validated caller-selected request. */
export interface ProviderOperationPort<
  TRequest extends ProviderOperationRequest,
> {
  execute(
    request: TRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}

/**
 * Shared CLI/MCP admission, execution, and Evidence composition for
 * single-request providers. The caller retains its operation vocabulary and
 * confidence; this normalizes cancellation, input validation, and Evidence
 * assembly once instead of per provider.
 */
export const executeProviderOperation = async <
  TRequest extends ProviderOperationRequest,
>(
  operation: string,
  input: unknown,
  options: ExecutionOptions | undefined,
  schema: z.ZodType<TRequest>,
  provider: ProviderOperationPort<TRequest>,
  confidence: "observed" | "derived",
  projection?: {
    readonly parameters?: (
      request: TRequest,
      execution: AnalysisExecution,
    ) => Readonly<Record<string, JsonValue>>;
    readonly authority?: (request: TRequest) => Evidence["authority"];
  },
): Promise<Result<Evidence, AnalysisError>> => {
  if (options?.signal?.aborted)
    return err(
      new AnalysisCancelledError(operation, { cause: options.signal.reason }),
    );
  const request = schema.safeParse({ operation, input });
  if (!request.success)
    return err(new AnalysisInputError(operation, { cause: request.error }));
  const executed = await provider.execute(request.data, options);
  if (!executed.ok) return executed;
  const execution = executed.value;
  const evidence = createEvidence(
    execution.subject ?? undefined,
    execution.provider,
    {
      operation,
      parameters:
        projection?.parameters?.(request.data, execution) ??
        jsonObjectSchema.parse(request.data.input),
      result: execution.result,
      rawResult: execution.rawResult,
      limitations: execution.limitations,
      locations: execution.locations,
      confidence,
      ...(projection?.authority === undefined
        ? {}
        : { authority: projection.authority(request.data) }),
    },
  );
  return completeProviderEvidence(evidence, options?.signal);
};

/** Classify completion after Evidence assembly, preserving facts on late abort. */
export const completeProviderEvidence = (
  evidence: Evidence,
  signal?: AbortSignal,
  capturedOutput?: AnalysisErrorOptions["capturedOutput"],
): Result<Evidence, AnalysisCancelledError> => {
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(evidence.operation, {
        cause: signal.reason,
        partialObservation: evidence,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      }),
    );
  return ok(evidence);
};
