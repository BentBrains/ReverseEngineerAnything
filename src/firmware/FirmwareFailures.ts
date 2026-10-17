import type { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactResourceRetryFailure } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { FirmwareDeadline } from "./FirmwareRelease.js";
import { z } from "zod";

/** Translate the producing file owner's outcome without guessing from a later signal. */
export const firmwareFailure = (
  cause: unknown,
  engine: string,
  operation: string,
  deadline?: FirmwareDeadline,
  treeCleanupLease?: AnalysisCleanupLease,
): AnalysisError => {
  if (
    cause instanceof AnalysisCancelledError &&
    deadline?.signal.aborted &&
    cause.cause === deadline.signal.reason
  )
    return new AnalysisTimeoutError(operation, deadline.timeoutMs, {
      cause: cause.cause,
      partialObservation: cause.partialObservation,
    });
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined) {
    const cleanup = new ProviderCleanupError(
      engine,
      cause.cleanup.resources,
      { reason: cause.cleanup.reason },
      { operation, cause },
    );
    bindArtifactFileCleanup(cause, cleanup);
    if (
      !(cause instanceof ArtifactFileCleanupFailure) &&
      !(cause instanceof ArtifactResourceRetryFailure)
    )
      treeCleanupLease?.bindCleanupError(cleanup);
    if (cause instanceof ArtifactFileCleanupFailure) {
      const outcome = cause.fileCleanupFailure.outcome;
      const primary =
        outcome.kind === "failed"
          ? firmwareFailure(
              outcome.cause,
              engine,
              operation,
              deadline,
              treeCleanupLease,
            )
          : cause.fileCleanupFailure.completionCancellation !== undefined
            ? firmwareCancellation(
                operation,
                cause.fileCleanupFailure.completionCancellation.reason,
                deadline,
              )
            : undefined;
      if (primary !== undefined)
        return analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          operation,
        ).bindCleanupDependencies([primary, cleanup]);
    }
    if (cause.reason === "cancelled")
      return analysisErrorWithCleanupFailure(
        firmwareCancellation(
          operation,
          artifactFileCancellationCause(cause),
          deadline,
        ),
        cleanup,
        operation,
      ).bindCleanupDependencies([cleanup]);
    return cleanup;
  }
  if (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
    return firmwareCancellation(
      operation,
      artifactFileCancellationCause(cause),
      deadline,
    );
  if (cause instanceof z.ZodError)
    return new AnalysisOutputError(
      operation,
      "Tool report violated the pinned producer protocol",
      { cause },
    );
  return new ProviderAdapterError(engine, operation, {
    cause,
    diagnostics: {
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** Classify the interruption actually observed, before composing cleanup failures. */
export const firmwareCancellation = (
  operation: string,
  reason: unknown,
  deadline?: FirmwareDeadline,
): AnalysisError =>
  deadline?.signal.aborted && reason === deadline.signal.reason
    ? new AnalysisTimeoutError(operation, deadline.timeoutMs, {
        cause: reason,
      })
    : new AnalysisCancelledError(operation, { cause: reason });
