import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../domain/evidenceErrors.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { compareBundles } from "../domain/bundleComparison.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readEvidenceBundle,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "./EvidenceBundleFiles.js";

/** Validate a standalone bundle and report its complete record/revision counts. */
export const importEvidenceBundleCommand = async (
  path: string,
): Promise<Result<JsonValue, AnalysisError>> => {
  const loaded = await readEvidenceBundle(path);
  if (!loaded.ok) return loaded;
  return ok({
    imported: loaded.value.records.length,
    unknowns_added: loaded.value.unknowns.length,
    total: loaded.value.records.length,
  });
};

/** Validate a source bundle and atomically export canonical bytes. */
export const exportEvidenceBundleCommand = async (
  sourcePath: string,
  outputPath: string,
  overwrite: boolean,
): Promise<Result<JsonValue, AnalysisError>> => {
  // The sealed snapshot lets the writer reuse this authentication.
  const loaded = await readImmutableEvidenceBundle(sourcePath);
  if (!loaded.ok) return loaded;
  const resources = new ArtifactResourceScope();
  const written = await writeEvidenceBundle(
    loaded.value,
    outputPath,
    overwrite,
    resources,
  );
  if (written.ok) return projectExportedEvidenceBundle(loaded.value, written);

  let cleanupSucceeded = false;
  try {
    await resources.close();
    cleanupSucceeded = true;
  } catch {
    // The original error cause retains the same staged-output owner for diagnostics.
  }
  if (
    cleanupSucceeded &&
    written.error instanceof EvidenceFileError &&
    written.error.published
  ) {
    return projectExportedEvidenceBundle(loaded.value, {
      ok: true,
      value: written.error.published,
    });
  }
  return written;
};

/** Compare two validated canonical Evidence bundles without session state. */
export const compareEvidenceBundlesCommand = async (input: {
  readonly leftPath: string;
  readonly rightPath: string;
}): Promise<Result<JsonValue, AnalysisError>> => {
  // Sealed snapshots let comparison and its bundle digests reuse this
  // authentication instead of re-validating every record twice more.
  const [left, right] = await Promise.all([
    readImmutableEvidenceBundle(input.leftPath),
    readImmutableEvidenceBundle(input.rightPath),
  ]);
  if (!left.ok) return left;
  if (!right.ok) return right;
  try {
    return ok(jsonValueSchema.parse(compareBundles(left.value, right.value)));
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Evidence bundle comparison failed", {
        cause,
      }),
    );
  }
};

/**
 * Project one written bundle into the complete `export_evidence_bundle`
 * result shape. This is the single owner of that projection: the CLI command
 * and the MCP handler both consume it so their output cannot drift from the
 * advertised contract.
 */
export const projectExportedEvidenceBundle = (
  bundle: EvidenceBundle,
  written: Awaited<ReturnType<typeof writeEvidenceBundle>>,
): Result<JsonValue, AnalysisError> =>
  written.ok
    ? ok({
        path: written.value.path,
        bytes: written.value.bytes,
        records: bundle.records.length,
        unknowns: bundle.unknowns.length,
      })
    : err(written.error);
