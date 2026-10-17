import { z } from "incur";
import { resolve } from "node:path";
import { createUnrealPakService } from "../composition/unreal.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Resolve caller paths and inspect Unreal pak indexes through the shared workflow. */
export const registerUnrealCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectUnrealPak, {
    description:
      "Inventory an Unreal Engine .pak footer and index entries without extracting, decompressing or decrypting file data",
    args: z.object({
      path: z
        .string()
        .describe("Local Unreal Engine .pak file (version 1 to 12)"),
    }),
    run: ({ args }) =>
      withCommandCancellation(async (signal) => {
        const service = createUnrealPakService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectUnrealPak,
          async () =>
            finishAnalysisCommand(
              () =>
                service.inspect(
                  // One-shot CLI runs retain no Evidence for later views.
                  { path: resolve(args.path), detail: "complete" },
                  { signal },
                ),
              service,
              "unreal-pak",
              "inspect_unreal_pak",
            ),
        );
      }),
  });
};
