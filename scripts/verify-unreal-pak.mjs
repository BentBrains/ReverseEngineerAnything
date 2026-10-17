import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolContract } from "../dist/contracts/toolContracts.js";
import { analysisViewResultSchema } from "../dist/domain/analysisView/analysisView.js";
import { ArtifactResourceScope } from "../dist/artifacts/ArtifactResourceScope.js";
import { mcpTextValue } from "./lib/mcp-verifier-results.mjs";
import { closeVerifierResources } from "./lib/verifier-cleanup.mjs";
import { hashVerifierFile } from "./lib/verifier-file-resources.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: npm run verify:unreal:pak -- [--pak PATH]\nPATH is a caller-owned Unreal Engine .pak file (versions 1 to 12). Without --pak, only the advertised contract is verified.",
  );
  process.exit(0);
}
if (!(args.length === 0 || (args.length === 2 && args[0] === "--pak")))
  throw new Error("Expected --pak PATH");
const path = args[1] === undefined ? null : resolve(args[1]);
const operation = "inspect_unreal_pak";
const contract = toolContract(operation);
const entrypoint = resolve("scripts/rea.mjs");
const execute = promisify(execFile);
const client = new Client({ name: "unreal-pak-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => typeof value === "string",
    ),
  ),
  stderr: "pipe",
});
transport.stderr?.resume();
const call = async (name, input) => {
  const response = await client.callTool(
    { name, arguments: input },
    { timeout: 120_000 },
  );
  assert.notEqual(response.isError, true, mcpTextValue(response));
  return JSON.parse(mcpTextValue(response));
};
const resources = new ArtifactResourceScope();
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some((tool) => tool.name === operation));
  if (path === null)
    console.log("[unverified] Pak inspection: no --pak was supplied");
  else {
    const identity = await hashVerifierFile(path, resources);
    const started = performance.now();
    const { stdout } = await execute(
      process.execPath,
      [entrypoint, "inspect-unreal-pak", path, "--json"],
      { timeout: 300_000, maxBuffer: 256 * 1024 * 1024 },
    );
    const cliMs = Math.round(performance.now() - started);
    const cli = contract.outputSchema.parse(JSON.parse(stdout));
    const report = cli.normalized_result;
    assert.equal(report.artifact.path, path);
    assert.equal(report.artifact.sha256, identity.sha256);
    const complete = await client.callTool(
      { name: operation, arguments: { path, detail: "complete" } },
      { timeout: 300_000 },
    );
    if (complete.isError === true) {
      // Large indexes exceed the stdio budget; the result must stay
      // retained and addressable rather than truncated.
      const { error } = JSON.parse(mcpTextValue(complete));
      assert.equal(error.code, "resource_constraint");
      assert.equal(error.details.reported_limits.boundary, "mcp-response");
      console.log(
        "[ok] MCP complete delivery refused at the stdio budget with retained Evidence",
      );
    } else {
      const mcp = contract.outputSchema.parse(
        JSON.parse(mcpTextValue(complete)),
      );
      assert.deepEqual(mcp.normalized_result, report);
      console.log("[ok] CLI/MCP complete Evidence parity");
    }
    if (report.index.state === "decoded") {
      assert.equal(report.entries.length, report.index.entry_count);
      for (const entry of report.entries)
        assert.ok(
          entry.offset + entry.size <= report.footer.index.offset ||
            entry.size === 0,
          `entry ${entry.path} reaches past the data area`,
        );
      console.log(
        "[ok] entry count matches the index and every entry lies in the data area",
      );
    }
    const summary = contract.outputSchema.parse(
      await call(operation, { path, detail: "summary" }),
    ).normalized_result;
    assert.equal(summary.summary.counts.entries, report.entries.length);
    const page = analysisViewResultSchema.parse(
      (
        await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: summary.parent_evidence_id,
          },
          view: { kind: "unreal-pak", collection: "entries", limit: 16 },
        })
      ).normalized_result,
    );
    assert.deepEqual(page.items, report.entries.slice(0, 16));
    assert.deepEqual(
      await hashVerifierFile(path, resources),
      identity,
      "Input pak must remain unchanged",
    );
    console.log(
      `[ok] summary and page parity; pak layout ${report.footer.layout}, ${report.entries.length} entries; complete Evidence ${Buffer.byteLength(stdout)} bytes, summary ${Buffer.byteLength(JSON.stringify(summary))} bytes; CLI ${cliMs} ms`,
    );
  }
} finally {
  await closeVerifierResources([
    () => client.close(),
    () => transport.close(),
    () => resources.close(),
  ]);
}
console.log("All asserted Unreal pak CLI/MCP checks passed");
