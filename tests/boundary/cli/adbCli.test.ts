import { chmod, lstat, readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../../../src/process/ExecFileOutput.js";
import {
  expectConfigurationRefusal,
  serveCli as serve,
} from "./cliServeHarness.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

it.skipIf(process.platform === "win32").each([
  { exit: 1, stdout: "", stderr: "adb: error: closed", overwrite: false },
  { exit: 1, stdout: "", stderr: "adb: error: closed", overwrite: true },
  { exit: 1, stdout: "unexpected probe output", stderr: "", overwrite: false },
  { exit: 2, stdout: "", stderr: "", overwrite: false },
])("refuses an ambiguous destination probe before push: %j", async (probe) => {
  const workspace = await createTestWorkspace("rea-adb-probe-cli-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const source = await workspace.write("payload.bin", "replacement");
  await workspace.write("device-file", "original");
  const adb = await workspace.write(
    "adb",
    `#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\\n' "$3" >> "$root/calls"
if [ "$1" = version ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
if [ "$3" = shell ] && [ "$4" = test ]; then
  printf '%s' '${probe.stdout}'
  printf '%s' '${probe.stderr}' >&2
  exit ${String(probe.exit)}
fi
if [ "$3" = push ]; then cp "$4" "$root/device-file"; exit 0; fi
exit 1
`,
  );
  await chmod(adb, 0o755);
  const result = await execFileOutput(
    process.execPath,
    [
      "scripts/rea.mjs",
      "push-adb-file",
      "device",
      source,
      "/data/local/tmp/payload.bin",
      ...(probe.overwrite ? ["--overwrite"] : []),
      "--json",
    ],
    {
      env: { ...process.env, REA_ADB_PATH: adb },
      timeout: 20_000,
      stopSignal: "SIGTERM",
      maxBuffer: 1024 * 1024,
    },
  ).then(
    (output) => ({ exitCode: 0, stdout: output.stdout }),
    (cause: unknown) => {
      const failure = execFileOutputFailure(cause);
      if (failure === undefined) throw cause;
      return { exitCode: failure.code, stdout: failure.stdout };
    },
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "unreadable_output",
  });
  if (probe.stderr !== "") expect(result.stdout).toContain(probe.stderr);
  expect(await readFile(workspace.path("device-file"), "utf8")).toBe(
    "original",
  );
  expect(await readFile(workspace.path("calls"), "utf8")).toBe("\nshell\n");
});

it.each([
  [
    ["inspect-adb-client", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "/nonexistent/adb",
    "The selected adb binary was not found: /nonexistent/adb. Set REA_ADB_PATH",
  ],
  [
    ["list-adb-devices", "--json"],
    "relative/adb",
    "REA_ADB_PATH must be an absolute path to the adb binary.",
  ],
])(
  "%j with REA_ADB_PATH=%s names the host requirement",
  async (argv, binary, reason) => {
    const result = await serve(argv, { REA_ADB_PATH: binary });
    expectConfigurationRefusal(result, reason);
  },
);

it("validates device serials before contacting any device", async () => {
  const result = await serve(["inspect-adb-device", "bad serial", "--json"]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
  });
});

it.each(["string:key", ":", "string"])(
  "classifies malformed activity extra %j before contacting adb",
  async (extra) => {
    const result = await serve(
      [
        "start-adb-activity",
        "emulator-5554",
        "android.intent.action.VIEW",
        "--extra",
        extra,
        "--format",
        "json",
      ],
      { REA_ADB_PATH: "/path/that/does/not/exist" },
    );

    const error = JSON.parse(result.stdout);
    expect(error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      retryable: true,
      remediation: { action: expect.any(String) },
    });
    expect(error.remediation.action).not.toBe("");
    expect(error.message).not.toBe("");
  },
);

it.each([
  ["bogus:key:value", "invalid_request"],
  ["string:key:value", "capability_unavailable"],
] as const)(
  "preserves downstream validation for well-delimited activity extra %j",
  async (extra, code) => {
    const result = await serve(
      [
        "start-adb-activity",
        "emulator-5554",
        "android.intent.action.VIEW",
        "--extra",
        extra,
        "--format",
        "json",
      ],
      { REA_ADB_PATH: "/path/that/does/not/exist" },
    );

    expect(JSON.parse(result.stdout)).toMatchObject({ code });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves requested reinstall mode without claiming prior package state",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-install-state-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const apk = await workspace.write("app with spaces.apk", "apk");
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\\n' "$*" >> "$root/calls"
if [ "$1" = version ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
if [ "$1" = -s ] && [ "$3" = install ]; then
  if [ "$4" = -r ]; then selected="$5"; else selected="$4"; fi
  cmp "$selected" "$root/app with spaces.apk" || exit 1
  printf '%s\\n' "$selected" >> "$root/snapshots"
  if [ -f "$root/installed" ]; then
    if [ "$4" != -r ]; then
      printf 'Failure [INSTALL_FAILED_ALREADY_EXISTS]\\n'
      exit 0
    fi
    printf 'replacement\\n' >> "$root/events"
  else
    printf 'fresh-install\\n' >> "$root/events"
  fi
  : > "$root/installed"
  printf 'Performing Streamed Install\\nSuccess\\n'
  exit 0
fi
exit 1
`,
    );
    await chmod(adb, 0o755);

    const installEnvelope = z.object({
      ok: z.literal(true),
      data: toolContract("install_adb_package").outputSchema,
    });
    const install = async (replace: boolean) => {
      const result = await serve(
        [
          "install-adb-package",
          "emulator-5554",
          apk,
          ...(replace ? ["--replace"] : []),
          "--format",
          "json",
          "--full-output",
        ],
        { REA_ADB_PATH: adb },
      );
      expect(result.exitCode).toBe(0);
      return installEnvelope.parse(JSON.parse(result.stdout));
    };

    const freshReplace = await install(true);
    expect(freshReplace).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: true },
        normalized_result: { replace_requested: true, replaced: null },
        confidence: "observed",
      },
    });
    expect(freshReplace.data.limitations.join("\n")).toContain(
      "Whether an existing package was replaced is unknown",
    );

    const existingReplace = await install(true);
    expect(existingReplace).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: true },
        normalized_result: { replace_requested: true, replaced: null },
      },
    });

    await unlink(workspace.path("installed"));
    const freshDefault = await install(false);
    expect(freshDefault).toMatchObject({
      ok: true,
      data: {
        parameters: { replace: false },
        normalized_result: { replace_requested: false, replaced: null },
      },
    });
    expect(await readFile(workspace.path("events"), "utf8")).toBe(
      "fresh-install\nreplacement\nfresh-install\n",
    );
    const snapshots = (await readFile(workspace.path("snapshots"), "utf8"))
      .trim()
      .split("\n");
    expect(snapshots).toHaveLength(3);
    expect(new Set(snapshots).size).toBe(3);
    for (const snapshot of snapshots) {
      expect(snapshot).not.toBe(apk);
      expect(basename(snapshot)).toBe(basename(apk));
      await expect(lstat(dirname(snapshot))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(await readFile(apk, "utf8")).toBe("apk");
    for (const receipt of [freshReplace, existingReplace, freshDefault])
      expect(receipt.data.normalized_result).toMatchObject({
        apk_path: apk,
        bytes: 3,
        sha256: createHash("sha256").update("apk").digest("hex"),
      });
    const calls = await readFile(workspace.path("calls"), "utf8");
    expect(calls.split("\n").filter((line) => line !== "")).toEqual([
      "version",
      `-s emulator-5554 install -r ${snapshots[0]}`,
      "version",
      `-s emulator-5554 install -r ${snapshots[1]}`,
      "version",
      `-s emulator-5554 install ${snapshots[2]}`,
    ]);
  },
);

it("requires the output directory option on pull", async () => {
  const result = await serve([
    "pull-adb-package",
    "emulator-5554",
    "com.example",
    "--json",
  ]);
  expect(result.exitCode).not.toBe(0);
});

it.skipIf(process.platform === "win32")(
  "refuses a trailing device separator through the CLI before adb or output effects",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-cli-pull-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const adb = await workspace.write(
      "adb",
      `#!/bin/sh
if [ "$1" = "version" ]; then
  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' "$0"
  exit 0
fi
: > '${workspace.path("invoked")}'
exit 0
`,
    );
    await chmod(adb, 0o755);
    const output = workspace.path("pulls");
    const result = await serve(
      [
        "pull-adb-file",
        "emulator-5554",
        "/data/local/tmp/",
        "--output-directory",
        output,
        "--json",
      ],
      { REA_ADB_PATH: adb },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "invalid_request",
    });
    await expect(readFile(workspace.path("invoked"))).rejects.toThrow();
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32")(
  "attributes pull file refusals to the device path and device state to the serial",
  async () => {
    const workspace = await createTestWorkspace("rea-adb-pull-attribute-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const remote = "/data/local/tmp/rea-attribute-sample.bin";
    const versionProbe =
      'if [ "$1" = version ]; then\n' +
      "  printf 'Android Debug Bridge version 1.0.41\\nVersion 34.0.5-cli\\nInstalled as %s\\n' \"$0\"\n" +
      "  exit 0\n" +
      "fi\n";
    const refuse = async (name: string, refusal: string) => {
      const adb = await workspace.write(
        `refuse-${name}`,
        `#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nprintf '%s\\n' "$*" >> "$root/calls-${name}"\n${versionProbe}if [ "$3" = pull ]; then\n  printf '%s' "${refusal}" >&2\n  exit 1\nfi\nexit 91\n`,
      );
      await chmod(adb, 0o755);
      return adb;
    };
    const missingAdb = await refuse(
      "missing",
      `adb: error: failed to stat remote object '${remote}': No such file or directory`,
    );
    const permissionAdb = await refuse(
      "permission",
      `adb: error: failed to open '${remote}': Permission denied`,
    );
    const offlineAdb = await refuse("offline", "error: device offline");
    const successAdb = await workspace.write(
      "success-adb",
      `#!/bin/sh\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nprintf '%s\\n' "$*" >> "$root/calls-success"\n${versionProbe}if [ "$3" = pull ]; then\n  printf 'attribute bytes\\n' > "$5"\n  exit 0\nfi\nexit 91\n`,
    );
    await chmod(successAdb, 0o755);

    const pull = (adb: string, output: string) =>
      serve(
        [
          "pull-adb-file",
          "emulator-5554",
          remote,
          "--output-directory",
          output,
          "--json",
        ],
        { REA_ADB_PATH: adb },
      );

    const previousExitCode = process.exitCode;
    const restorablePull = async (adb: string, output: string) => {
      const result = await pull(adb, output);
      const exitCode = process.exitCode;
      process.exitCode = previousExitCode;
      return { result, exitCode };
    };

    for (const [name, adb] of [
      ["missing", missingAdb],
      ["permission", permissionAdb],
      ["offline", offlineAdb],
    ] as const) {
      const { result, exitCode } = await restorablePull(
        adb,
        workspace.path(`${name}-output`),
      );
      expect(exitCode).toBe(1);
      const output = JSON.parse(result.stdout) as {
        code: string;
        message: string;
        details: { operation: string; path: string; reason: string };
      };
      expect(output.code).toBe("unsupported_target");
      expect(output.details.operation).toBe("pull_adb_file");
      expect(output.details.reason).toEqual(
        expect.stringContaining(name === "offline" ? "device offline" : remote),
      );
      expect(output.details.path).toBe(
        name === "offline" ? "emulator-5554" : remote,
      );
      expect(output.message).toContain(
        name === "offline" ? "at emulator-5554" : `at ${remote}`,
      );
      const calls = (await readFile(workspace.path(`calls-${name}`), "utf8"))
        .split("\n")
        .filter((line) => line !== "");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe("version");
      expect(calls[1]).toBe(
        `-s emulator-5554 pull ${remote} ${workspace.path(`${name}-output/rea-attribute-sample.bin`)}`,
      );
    }

    const { result: success, exitCode: successExitCode } = await restorablePull(
      successAdb,
      workspace.path("success-output"),
    );
    expect(successExitCode).toBe(previousExitCode);
    const pulled = JSON.parse(success.stdout) as {
      normalized_result: {
        serial: string;
        device_path: string;
        local_path: string;
        bytes: number;
        sha256: string;
      };
    };
    const content = "attribute bytes\n";
    expect(pulled.normalized_result).toMatchObject({
      serial: "emulator-5554",
      device_path: remote,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(await readFile(pulled.normalized_result.local_path, "utf8")).toBe(
      content,
    );
    const successCalls = (
      await readFile(workspace.path("calls-success"), "utf8")
    )
      .split("\n")
      .filter((line) => line !== "");
    expect(successCalls).toEqual([
      "version",
      `-s emulator-5554 pull ${remote} ${workspace.path("success-output/rea-attribute-sample.bin")}`,
    ]);
  },
);
