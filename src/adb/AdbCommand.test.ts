import { expect, it, vi } from "vitest";
import {
  ExecFileOutputCancelledError,
  execFileBytes,
} from "../process/ExecFileOutput.js";
import { probeAdbPathExistence, runAdbCapture } from "./AdbCommand.js";

vi.mock("../process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/ExecFileOutput.js")>()),
  execFileBytes: vi.fn(),
}));

const probe = (signal?: AbortSignal) =>
  probeAdbPathExistence(
    "push_adb_file",
    "device",
    "/device/path",
    "/host/adb",
    {
      timeoutMs: 100,
      maxOutputBytes: 1024,
    },
    signal,
  );

it("recognizes only the completed empty false result as absence", async () => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("test false"), {
      code: 1,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  await expect(probe()).resolves.toEqual({ ok: true, value: false });
});

it.each([
  { code: 2 },
  { code: "ENOENT" },
  { signal: "SIGTERM" },
  { collectionFailure: true },
  { stdout: "unexpected" },
  { stderr: " " },
])("keeps nonstandard false completion unknown: %j", async (extra) => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("probe failed"), {
      code: 1,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      ...extra,
    }),
  );
  const result = await probe();
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisProtocolError",
      diagnostics: { destination_existence: "unknown" },
    },
  });
});

it.each([
  [{ killed: true }, "AnalysisTimeoutError"],
  [{ outputTruncated: true }, "AnalysisResourceConstraintError"],
] as const)(
  "preserves a stopped or incomplete probe: %j",
  async (extra, tag) => {
    vi.mocked(execFileBytes).mockRejectedValueOnce(
      Object.assign(new Error("probe failed"), {
        code: 1,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        ...extra,
      }),
    );
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      error: { _tag: tag },
    });
  },
);

it("recognizes an empty successful probe as existence", async () => {
  vi.mocked(execFileBytes).mockResolvedValueOnce({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  await expect(probe()).resolves.toEqual({ ok: true, value: true });
});

it.each(["stdout", "stderr"] as const)(
  "retains unexpected successful %s as unknown",
  async (stream) => {
    vi.mocked(execFileBytes).mockResolvedValueOnce({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      [stream]: Buffer.from("unexpected"),
    });
    await expect(probe()).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisProtocolError",
        capturedOutput: { [stream]: "unexpected", exit_code: 0 },
      },
    });
  },
);

it.each([null, "caller stopped", new Error("caller stopped")] as const)(
  "uses the command owner's exact %s cancellation reason",
  async (reason) => {
    const cancelled = Object.assign(new ExecFileOutputCancelledError(reason), {
      stdout: "partial",
      stderr: "diagnostic",
      stdoutBytes: 7,
      stderrBytes: 10,
    });
    vi.mocked(execFileBytes).mockRejectedValueOnce(cancelled);
    const result = await probe();
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    if (result.ok) throw new Error("Expected owned cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.capturedOutput).toMatchObject({
      stdout: "partial",
      stderr: "diagnostic",
      stdout_bytes: 7,
      stderr_bytes: 10,
    });
  },
);

it("does not infer cancellation from a foreign ABORT_ERR code", async () => {
  const failure = Object.assign(new Error("foreign code"), {
    code: "ABORT_ERR",
    stdout: "",
    stderr: "",
  });
  vi.mocked(execFileBytes).mockRejectedValueOnce(failure);
  expect(await probe()).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisProtocolError" },
  });
});

it("keeps a physical failure even when the later abort reason is that same error", async () => {
  const controller = new AbortController();
  const failure = new Error("physical command failure");
  vi.mocked(execFileBytes).mockImplementationOnce(async () => {
    controller.abort(failure);
    throw failure;
  });
  const result = await runAdbCapture(
    "inspect_adb_device",
    "device",
    "/host/adb",
    [],
    { timeoutMs: 100, maxOutputBytes: 1024 },
    controller.signal,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisProtocolError", cause: failure },
  });
});

it.each([
  "adb: error: failed to stat remote object '/data/local/tmp/rea-attribute-sample.bin': No such file or directory",
  "adb: error: failed to open '/data/local/tmp/rea-attribute-sample.bin': read: Permission denied",
])(
  "names the pulled file operand for the path-specific refusal: %j",
  async (stderr) => {
    vi.mocked(execFileBytes).mockRejectedValueOnce(
      Object.assign(new Error("adb pull failed"), {
        code: 1,
        stdout: "",
        stderr,
        signal: null,
        killed: false,
      }),
    );
    const result = await runAdbCapture(
      "pull_adb_file",
      "emulator-5554",
      "/host/adb",
      [],
      { timeoutMs: 100, maxOutputBytes: 1024 },
      undefined,
      { fileTarget: "/data/local/tmp/rea-attribute-sample.bin" },
    );
    if (result.ok) throw new Error("Expected a path-specific pull refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisUnsupportedTargetError",
      operation: "pull_adb_file",
      path: "/data/local/tmp/rea-attribute-sample.bin",
      reason: stderr,
    });
    expect(result.error.message).toBe(
      `Unsupported target for pull_adb_file at /data/local/tmp/rea-attribute-sample.bin: ${stderr}`,
    );
  },
);

it("keeps the device target for device-state refusals even when a file operand is given", async () => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("adb pull failed"), {
      code: 1,
      stdout: "",
      stderr: "error: device offline",
      signal: null,
      killed: false,
    }),
  );
  const result = await runAdbCapture(
    "pull_adb_file",
    "emulator-5554",
    "/host/adb",
    [],
    { timeoutMs: 100, maxOutputBytes: 1024 },
    undefined,
    { fileTarget: "/data/local/tmp/rea-attribute-sample.bin" },
  );
  if (result.ok) throw new Error("Expected a device-state refusal");
  expect(result.error).toMatchObject({
    _tag: "AnalysisUnsupportedTargetError",
    path: "emulator-5554",
    reason: "error: device offline",
  });
});

it("keeps the shared target when no file operand is provided", async () => {
  vi.mocked(execFileBytes).mockRejectedValueOnce(
    Object.assign(new Error("adb pull failed"), {
      code: 1,
      stdout: "",
      stderr:
        "adb: error: failed to stat remote object '/data/local/tmp/x.bin': No such file or directory",
      signal: null,
      killed: false,
    }),
  );
  const result = await runAdbCapture(
    "inspect_adb_device",
    "device",
    "/host/adb",
    [],
    { timeoutMs: 100, maxOutputBytes: 1024 },
    undefined,
  );
  if (result.ok) throw new Error("Expected a refusal");
  expect(result.error.message).toContain("at device: ");
});
