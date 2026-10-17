import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { firmwareFailure } from "./FirmwareFailures.js";
import {
  FIRMWARE_LIMITS,
  firmwarePublicationTimeoutMs,
} from "./FirmwareRelease.js";

it("budgets publication beyond the extraction deadline in proportion to admitted entries", () => {
  // Issue #4176: 1,101 files took about 133 s to publish to a slow bind mount.
  expect(firmwarePublicationTimeoutMs(0)).toBe(FIRMWARE_LIMITS.timeoutMs);
  expect(firmwarePublicationTimeoutMs(1101)).toBeGreaterThan(133_000);
  expect(firmwarePublicationTimeoutMs(2000)).toBeGreaterThan(
    firmwarePublicationTimeoutMs(1000),
  );
});

it("reports the expired phase's own budget in the timeout", () => {
  const reason = new Error("deadline");
  const failure = firmwareFailure(
    new AnalysisCancelledError("extract_firmware", { cause: reason }),
    "unblob",
    "extract_firmware",
    { signal: AbortSignal.abort(reason), timeoutMs: 345_678 },
  );
  expect(failure).toMatchObject({
    _tag: "AnalysisTimeoutError",
    timeoutMs: 345_678,
  });
});
