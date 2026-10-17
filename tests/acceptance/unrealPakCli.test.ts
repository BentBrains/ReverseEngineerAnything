import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  unrealPakSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { unrealPakSchema } from "../../src/domain/unreal/unrealPak.js";
import { createPakFixture } from "../fixtures/unreal/pak.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "returns identical complete pak indexes through CLI and MCP and pages a retained summary after removal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-");
    const path = join(root, "Game-Mac.pak");
    const { bytes, files } = createPakFixture({ layout: "v12" });
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-unreal-pak", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_unreal_pak").outputSchema.parse(
      result.json,
    );
    const report = unrealPakSchema.parse(evidence.normalized_result);
    expect(report.artifact).toEqual({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(report.footer.layout).toBe("v12");
    expect(report.entries.map((entry) => entry.path)).toEqual(
      files.map((file) => file.path),
    );
    expect(evidence.parameters).toEqual({ path });

    const { client, call } = await connectLocalToolsMcp();
    // Omitted detail delivers every entry, like the other inspection tools.
    const complete = await call("inspect_unreal_pak", { path });
    expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
    expect(parseEvidence(complete.structuredContent).normalized_result).toEqual(
      report,
    );

    const summarized = await call("inspect_unreal_pak", {
      path,
      detail: "summary",
    });
    expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
    const view = unrealPakSummaryViewResultSchema.parse(
      parseEvidence(summarized.structuredContent).normalized_result,
    );
    expect(view.summary.counts).toEqual({
      entries: 3,
      encoded_records: 3,
      full_records: 0,
      compressed: 1,
      encrypted: 0,
      deleted: 0,
      without_path: 0,
    });
    expect(view.summary.footer).toEqual(report.footer);

    // Pages come from retained Evidence, not the file.
    await unlink(path);
    const rows: unknown[] = [];
    let offset = 0;
    do {
      const page = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: { kind: "unreal-pak", collection: "entries", offset, limit: 2 },
      });
      expect(page.isError, JSON.stringify(page)).not.toBe(true);
      const projected = analysisViewResultSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      );
      if (projected.kind !== "unreal-pak")
        throw new Error("Wrong pak page kind");
      expect(projected.counts).toEqual(view.summary.counts);
      rows.push(...projected.items);
      offset = projected.coverage.next_offset ?? report.entries.length;
    } while (offset < report.entries.length);
    expect(rows).toEqual(report.entries);
    await client.ping();
  },
  30000,
);

cliTest(
  "distinguishes unsupported, corrupt and encrypted paks through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unreal-pak-fail-");
    const { client, call } = await connectLocalToolsMcp();
    const frozen = createPakFixture({ layout: "v9", frozenIndex: true }).bytes;
    const duplicate = createPakFixture({
      layout: "v8b",
      files: [
        { path: "A/x", size: 1 },
        { path: "A/x", size: 1 },
      ],
    }).bytes;
    for (const [name, bytes, expected] of [
      [
        "frozen.pak",
        frozen,
        {
          code: "unsupported_target",
          details: { operation: "inspect_unreal_pak" },
          message: expect.stringContaining("frozen-index"),
        },
      ],
      [
        "duplicate.pak",
        duplicate,
        {
          code: "invalid_request",
          details: {
            operation: "inspect_unreal_pak",
            issues: [
              {
                path: ["path"],
                reason: "invalid_format",
                message: expect.stringContaining("duplicate-path"),
              },
            ],
          },
        },
      ],
    ] as const) {
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: ["inspect-unreal-pak", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(expected);
      const response = await call("inspect_unreal_pak", { path });
      expect(parseMcpToolError(response).error).toMatchObject(expected);
    }

    // An encrypted index is a successful report with footer facts only.
    const encryptedPath = join(root, "encrypted.pak");
    await writeFile(
      encryptedPath,
      createPakFixture({ layout: "v11", encryptedIndex: true }).bytes,
    );
    const encrypted = await cli.run({
      arguments: ["inspect-unreal-pak", encryptedPath, "--json"],
    });
    expect(encrypted.exitCode, encrypted.stderr).toBe(0);
    expect(
      unrealPakSchema.parse(
        toolContract("inspect_unreal_pak").outputSchema.parse(encrypted.json)
          .normalized_result,
      ),
    ).toMatchObject({
      footer: { index_encrypted: true },
      index: { state: "encrypted" },
      entries: [],
    });
    await client.ping();
  },
  30000,
);
