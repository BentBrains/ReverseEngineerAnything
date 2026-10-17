import { expect, it } from "vitest";
import { Il2cppMetadataService } from "./Il2cppMetadataService.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  IL2CPP_METADATA_SECTION_NAMES,
  type Il2cppMetadata,
} from "../../domain/il2cpp/il2cppMetadata.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "fixture-il2cpp",
  name: "Source-owned IL2CPP reader seam",
  version: "1",
};
const report: Il2cppMetadata = {
  artifact: {
    path: "/artifacts/global-metadata.dat",
    sha256: "a".repeat(64),
    bytes: 1024,
  },
  metadata_version: 39,
  index_widths: {
    type_definition: 1,
    generic_container: 1,
    parameter: 1,
    type: 1,
    type_width_source: "interface-offsets-record",
  },
  sections: IL2CPP_METADATA_SECTION_NAMES.map((name) => ({
    name,
    offset: 380,
    size: 0,
    count: 0,
  })),
  images: [],
  types: [],
  methods: [],
  limitations: [],
};

const serviceReturning = (value: Il2cppMetadata, calls = { count: 0 }) =>
  new Il2cppMetadataService({
    identity,
    inspect: () => {
      calls.count += 1;
      return Promise.resolve(ok(value));
    },
  });

it("rejects invalid paths and extra arguments before invoking the reader", async () => {
  const calls = { count: 0 };
  const service = serviceReturning(report, calls);
  for (const input of [
    { path: "relative/global-metadata.dat", detail: "complete" },
    { path: "/artifacts/\0global-metadata.dat", detail: "complete" },
    { path: report.artifact.path, detail: "complete", decrypt: true },
    { path: report.artifact.path, detail: "rows" },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls.count).toBe(0);
});

it("refuses summary delivery without Evidence retention before reading", async () => {
  const calls = { count: 0 };
  const result = await serviceReturning(report, calls).inspect({
    path: report.artifact.path,
    detail: "summary",
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(calls.count).toBe(0);
});

it("returns complete artifact-bound Evidence without retention by default", async () => {
  const result = await serviceReturning(report).inspect({
    path: report.artifact.path,
  });
  if (!result.ok) throw result.error;
  expect(result.value.parameters).toEqual({ path: report.artifact.path });
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.subject).toMatchObject({
    format: "file",
    local_path: report.artifact.path,
    digest: { sha256: report.artifact.sha256 },
  });
});

it("rejects a reader that changes the selected artifact identity", async () => {
  const result = await serviceReturning({
    ...report,
    artifact: { ...report.artifact, path: "/artifacts/other.dat" },
  }).inspect({ path: report.artifact.path, detail: "complete" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("reports cancellation before and after reading", async () => {
  const aborted = new AbortController();
  aborted.abort();
  const calls = { count: 0 };
  const before = await serviceReturning(report, calls).inspect(
    { path: report.artifact.path, detail: "complete" },
    { signal: aborted.signal },
  );
  expect(before.ok).toBe(false);
  if (!before.ok) expect(before.error).toBeInstanceOf(AnalysisCancelledError);
  expect(calls.count).toBe(0);

  const during = new AbortController();
  const service = new Il2cppMetadataService({
    identity,
    inspect: () => {
      during.abort();
      return Promise.resolve(ok(report));
    },
  });
  const after = await service.inspect(
    { path: report.artifact.path, detail: "complete" },
    { signal: during.signal },
  );
  expect(after.ok).toBe(false);
  if (!after.ok) expect(after.error).toBeInstanceOf(AnalysisCancelledError);
});
