import { access, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";

import { expect, it, onTestFinished } from "vitest";

import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { waitForExit } from "../../../support/process/processFixture.js";
import { HopperFixtureLauncher } from "./hopperClient.fixture.js";

// The GUI app is a sibling owned by the test; REA only owns the launcher
// helper, mirroring macOS where every Hopper launch is external-application.
class ExternalAppLauncher implements BridgeLauncher {
  readonly fixture = new HopperFixtureLauncher(undefined, "quiet", "ready");
  readonly sessions: BridgeSession[] = [];
  readonly helpers: ChildProcess[] = [];

  async launch(session: BridgeSession) {
    this.sessions.push(session);
    await this.fixture.launch(session);
    const helper = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    this.helpers.push(helper);
    return ok({
      process: helper,
      ownsProcessLifetime: false as const,
      providerLifetime: "external-application" as const,
      shutdownMode: "bridge-request" as const,
    });
  }
}

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await waitForExit(child, 10_000);
};

it("recovers the session after the external Hopper app exits", async () => {
  const launcher = new ExternalAppLauncher();
  const client = new HopperClient({ launcher, startupTimeoutMs: 5_000 });
  onTestFinished(async () => {
    await client.close().catch(() => undefined);
    await Promise.all([
      ...launcher.helpers.map(stop),
      ...launcher.fixture.processes.map(stop),
    ]);
    await Promise.all(
      launcher.sessions.map(({ directory }) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  const started = await client.start();
  if (!started.ok) throw started.error;

  // The Hopper app exits (SIGKILL here; the issue used SIGTERM and the demo
  // OK button). The bridge dies with it, so no shutdown acknowledgement can
  // ever arrive.
  const app = launcher.fixture.processes.at(-1);
  if (app === undefined) throw new Error("Fixture app did not launch");
  app.kill("SIGKILL");
  expect(await waitForExit(app, 10_000)).toBe(true);

  const before = Date.now();
  const closed = await client.close();
  const elapsedMs = Date.now() - before;
  // The verified exit confirms cleanup: no cleanup_incomplete, no wedge.
  if (!closed.ok) throw closed.error;

  // The 30s bridge reconnect is skipped once the exit is confirmed.
  expect(elapsedMs).toBeLessThan(10_000);

  // The private runtime directory is released.
  const session = launcher.sessions[0];
  if (session === undefined) throw new Error("Fixture did not launch");
  await expect(access(session.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });

  // Nobody was asked to shut down a document: there was no one left to ask.
  expect(
    launcher.fixture.requests.some(
      ({ method }) => method === "shutdown_document",
    ),
  ).toBe(false);
}, 60_000);
