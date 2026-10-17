import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
} from "../../../src/domain/residualUnknown.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

/** One record plus two residual-unknown revisions of the same unknown. */
const revisionBundle = () => {
  const records = ["open", "investigate"].map((operation) =>
    createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation, parameters: {}, result: { observed: operation } },
    ),
  );
  const [opened, investigated] = records;
  if (opened === undefined || investigated === undefined)
    throw new Error("Missing mutation Evidence");
  const details = {
    severity: "high" as const,
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: null,
    required_confidence: "observed" as const,
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const initial = createResidualUnknown(
    { question: "How is this input handled?", domain: "protocol", ...details },
    opened.evidence_id,
    null,
  );
  const revised = updateResidualUnknown(
    initial,
    {
      unknown_id: initial.unknown_id,
      expected_revision: initial.revision,
      status: "investigating",
      ...details,
      resolution: null,
    },
    investigated.evidence_id,
  );
  return createEvidenceBundle(records, [initial, revised]);
};

const exportThroughCli = async (
  cli: TestCli,
  root: string,
  bundle: ReturnType<typeof createEvidenceBundle>,
) => {
  const source = join(root, "source.json");
  const output = join(root, "output.json");
  await writeFile(source, JSON.stringify(bundle));
  const result = await cli.run({
    arguments: ["evidence-export", source, output, "--json"],
  });
  expect(result.exitCode).toBe(0);
  // The CLI exposes the session tool's unwrapped result, so wrap it back into
  // the named session contract before validating against that single owner
  // instead of restating the shape by hand.
  const parsed = toolContract("export_evidence_bundle").outputSchema.parse({
    result: result.json,
  });
  return { output, parsed: parsed.result };
};

cliTest(
  "emits a contract-complete evidence-export result with the residual-unknown count",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-export-contract-");
    const bundle = revisionBundle();
    const { output, parsed } = await exportThroughCli(cli, root, bundle);

    expect(parsed.unknowns).toBe(bundle.unknowns.length);
    expect(parsed.unknowns).toBe(2);
    expect(parsed.records).toBe(bundle.records.length);
    expect(parsed.bytes).toBeGreaterThan(0);

    // The result still describes the canonical bundle actually written.
    const exported = JSON.parse(await readFile(output, "utf8")) as {
      records: unknown[];
      unknowns: unknown[];
    };
    expect(exported.records).toHaveLength(bundle.records.length);
    expect(exported.unknowns).toHaveLength(bundle.unknowns.length);
  },
);

cliTest(
  "reports zero residual unknowns for a bundle without unknown revisions",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-evidence-export-no-unknowns-",
    );
    const bundle = createEvidenceBundle([
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        { operation: "open", parameters: {}, result: { observed: "open" } },
      ),
    ]);
    const { parsed } = await exportThroughCli(cli, root, bundle);

    expect(parsed.unknowns).toBe(0);
    expect(parsed.records).toBe(1);
  },
);

cliTest(
  "keeps the CLI and MCP export results on the same contract shape",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-export-parity-");
    const bundle = revisionBundle();
    const { parsed: cliResult } = await exportThroughCli(cli, root, bundle);

    // An in-process MCP session against the real server registration: the CLI
    // and MCP adapters consume the same shared projection even though only the
    // session-kind MCP result is wrapped in the contract's `result` envelope.
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const imported = session.importEvidenceBundle(bundle);
    if (!imported.ok) throw imported.error;
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "evidence-export-parity", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const exported = await client.callTool({
        name: "export_evidence_bundle",
        arguments: { path: join(root, "mcp-output.json") },
      });
      expect(exported.isError).not.toBe(true);
      const mcpResult = toolContract(
        "export_evidence_bundle",
      ).outputSchema.parse(exported.structuredContent).result;

      expect(mcpResult.records).toBe(cliResult.records);
      expect(mcpResult.unknowns).toBe(cliResult.unknowns);
      expect(mcpResult.unknowns).toBe(bundle.unknowns.length);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
);
