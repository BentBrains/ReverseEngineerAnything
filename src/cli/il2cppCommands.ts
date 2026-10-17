import { z } from "incur";
import { resolve } from "node:path";
import { createIl2cppMetadataService } from "../composition/il2cpp.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve caller paths and inspect IL2CPP metadata names through the shared workflow. */
export const registerIl2cppCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectIl2cppMetadata, {
    description:
      "Inventory IL2CPP global-metadata.dat images, types and methods without decryption or target execution",
    args: z.object({
      path: z
        .string()
        .describe("Local global-metadata.dat (version 29, 31 or 39)"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        const service = createIl2cppMetadataService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectIl2cppMetadata,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  // One-shot CLI runs retain no Evidence for later views.
                  { path: resolve(args.path), detail: "complete" },
                  { signal },
                ),
              service,
              "il2cpp-metadata",
              "inspect_il2cpp_metadata",
            ),
        );
      }),
  });
};
