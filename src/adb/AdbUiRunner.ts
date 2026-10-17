import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  adbClientIdentitySchema,
  adbPackageNameSchema,
} from "../domain/adb/adbIdentity.js";
import {
  adbUiObservationSchemas,
  adbUiRunnerIdentitySchema,
  type AdbUiRequest,
} from "../domain/adb/adbUiAnalysis.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { adbArguments } from "./AdbCommand.js";

const PACKAGE_ENV = "REA_ADB_UI_PACKAGE";
const DEFAULT_PACKAGE = "dev.rea.uiautomator";
const REQUEST_BYTES = 16 * 1024;
const RESPONSE_BYTES = 256 * 1024;
const CAPTURE_BYTES = 1024 * 1024;
const CLEANUP_MS = 5000;
const PROTOCOL = 2;
const envelope = z
  .strictObject({
    protocol: z.literal(PROTOCOL),
    request_id: z.string().uuid().nullable(),
    instance_id: z.string().uuid(),
    // The JSON decoder owns JSON validity; named payload schemas own its facts.
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.strictObject({ kind: z.string(), reason: z.string() }).nullable(),
  })
  .refine(
    (value) =>
      value.ok === (value.error === null) &&
      value.ok === (value.result !== null),
    "Inconsistent outcome fields",
  );
type Reply = z.infer<typeof envelope>;
type UiObservation = z.infer<
  (typeof adbUiObservationSchemas)[AdbUiRequest["operation"]]
>;
type ReplyFailure = {
  readonly kind: "unavailable" | "protocol" | "capacity";
  readonly reason: string;
};
interface RemoteRequest {
  readonly binary: string;
  readonly serial: string;
  readonly packageName: string;
  readonly instanceId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly socketPath: string;
  settled?: boolean;
  completion?: Reply;
}

/** Parse the producer's terminal record, never a substring inside Android diagnostics. */
export const parseAdbUiReply = (
  stdout: string,
  channel: "control" | "input" = "control",
): Result<Reply, ReplyFailure> => {
  const fail = (reason: string, kind: ReplyFailure["kind"] = "protocol") =>
    err({ kind, reason });
  const records =
    channel === "input"
      ? [stdout.trim()]
      : stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("Broadcast completed:"));
  if (records.length !== 1)
    return fail("Expected one completed UI runner broadcast");
  const match = (
    channel === "input"
      ? /^REA_UI_V2:([A-Za-z0-9+/]+={0,2})$/u
      : /^Broadcast completed: result=-?\d+, data="REA_UI_V2:([A-Za-z0-9+/]+={0,2})"$/u
  ).exec(records[0]!);
  if (match === null)
    return fail(
      "The selected UI runner did not answer the REA protocol",
      records[0]!.includes("REA_UI_V2:") ? "protocol" : "unavailable",
    );
  const encoded = match[1]!;
  if (encoded.length > Math.ceil(RESPONSE_BYTES / 3) * 4)
    return fail("UI response exceeds the Binder protocol budget", "capacity");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > RESPONSE_BYTES || bytes.toString("base64") !== encoded)
    return fail("UI response is not bounded canonical base64");
  try {
    const parsed = envelope.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (!parsed.success) return fail("UI response violated protocol v2");
    return ok(parsed.data);
  } catch {
    return fail("UI response is not valid UTF-8 JSON");
  }
};

/** Own host commands and request cancellation; the instrumentation process belongs to the operator. */
export class AdbUiRunner {
  readonly #pending = new Map<string, RemoteRequest>();
  readonly #commands = new Map<ProviderProcessSupervisor, string>();
  readonly #cleanupErrors = new Set<WeakRef<AnalysisError>>();
  #cleanup: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly environment: Readonly<Record<string, string | undefined>>,
    /** Launch adapters must preserve the launch-state observations owned by this boundary. */
    private readonly launcher = spawnOwnedProviderProcess,
  ) {}

  get pendingResources(): readonly string[] {
    return [
      ...this.#commands.values(),
      ...[...this.#pending.values()].map(
        (request) =>
          `adb-ui:${request.serial}:${request.packageName}:${request.instanceId}:${request.requestId}`,
      ),
    ];
  }

  #trackCleanupError(error: AnalysisError): void {
    for (const reference of this.#cleanupErrors)
      if (reference.deref() === undefined)
        this.#cleanupErrors.delete(reference);
    this.#cleanupErrors.add(new WeakRef(error));
  }

  async #settleCommands(): Promise<void> {
    const failures = [];
    for (const [owner, resource] of this.#commands) {
      try {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete" || stopped.status === "not-owned")
          failures.push({ resource, ...stopped });
        else this.#commands.delete(owner);
      } catch (cause) {
        failures.push({
          resource,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (failures.length) {
      const error = new ProviderCleanupError(
        "adb",
        [...this.#commands.values()],
        jsonObjectSchema.parse({ failures }),
      );
      this.#trackCleanupError(error);
      throw error;
    }
  }

  async #send(
    binary: string,
    serial: string,
    packageName: string,
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal,
    submission?: RemoteRequest,
    socketPath?: string,
  ): Promise<Reply> {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json) > REQUEST_BYTES)
      throw new AnalysisResourceConstraintError(
        operation,
        "transport",
        "UI request exceeds the 16 KiB retained-request protocol budget",
        { max_request_bytes: REQUEST_BYTES },
      );
    if (socketPath === undefined && "input" in payload)
      throw new AnalysisProtocolError(
        "UI request bodies require the private stdin channel",
      );
    const encoded = Buffer.from(json).toString("base64");
    const runId = randomUUID();
    try {
      const result = await runOwnedCommand(
        {
          command: binary,
          arguments: adbArguments(
            serial,
            socketPath === undefined
              ? [
                  "shell",
                  "am",
                  "broadcast",
                  "--receiver-foreground",
                  "--user",
                  "0",
                  "-a",
                  `${packageName}.REQUEST`,
                  "-p",
                  packageName,
                  "--es",
                  "request",
                  encoded,
                ]
              : [
                  "shell",
                  "-T",
                  "run-as",
                  packageName,
                  "--user",
                  "0",
                  "/system/bin/toybox",
                  "nc",
                  "-U",
                  "-w",
                  "5",
                  "-W",
                  "10",
                  socketPath,
                ],
          ),
          ...(socketPath === undefined ? {} : { stdin: "pipe" as const }),
          runId,
          expectedCommand: null,
          hostEnvironment: this.environment,
          onLaunchState: (state) => {
            if (submission === undefined) return;
            if (state === "attempting")
              this.#pending.set(submission.requestId, submission);
            else this.#pending.delete(submission.requestId);
          },
        },
        { timeoutMs, diagnosticBytes: CAPTURE_BYTES },
        {
          ...(signal === undefined ? {} : { signal }),
          retainCleanup: (owner) => {
            this.#commands.set(owner, runId);
          },
          launcher: this.launcher,
          ...(socketPath === undefined ? {} : { input: `${encoded}\n` }),
        },
      );
      await this.#settleCommands();
      const parsed = parseAdbUiReply(
        result.stdout.text,
        socketPath === undefined ? "control" : "input",
      );
      if (!parsed.ok) {
        const options = {
          capturedOutput: {
            stdout: result.stdout.text,
            stderr: result.stderr.text,
            truncated: false,
          },
        };
        if (parsed.error.kind === "unavailable")
          throw new AnalysisCapabilityUnavailableError(
            "adb",
            operation,
            `${parsed.error.reason}. Install and start the UI Automator runner on ${serial}; see docs/adb-ui-automation.md.`,
            options,
          );
        if (parsed.error.kind === "capacity")
          throw new AnalysisResourceConstraintError(
            operation,
            "transport",
            parsed.error.reason,
            { max_response_bytes: RESPONSE_BYTES },
            options,
          );
        throw new AnalysisProtocolError(parsed.error.reason, options);
      }
      if (parsed.value.request_id !== payload.request_id)
        throw new AnalysisProtocolError(
          "UI reply belongs to a different request",
        );
      return parsed.value;
    } catch (cause) {
      if (cause instanceof AnalysisError) throw cause;
      const capturedOutput =
        cause instanceof OwnedCommandFailure && cause.snapshot !== null
          ? {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated:
                cause.snapshot.stdout.bytes <
                  cause.snapshot.stdout.observedBytes ||
                cause.snapshot.stderr.bytes <
                  cause.snapshot.stderr.observedBytes,
            }
          : undefined;
      const options = {
        cause,
        ...(capturedOutput === undefined ? {} : { capturedOutput }),
      };
      if (
        (signal?.aborted && cause === signal.reason) ||
        (cause instanceof OwnedCommandFailure && cause.reason === "cancelled")
      )
        throw new AnalysisCancelledError(operation, {
          ...options,
          cause: signal?.aborted ? signal.reason : cause,
        });
      if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
        throw new AnalysisTimeoutError(operation, timeoutMs, options);
      if (
        cause instanceof OwnedCommandFailure &&
        cause.reason === "output-limit"
      )
        throw new AnalysisResourceConstraintError(
          operation,
          "transport",
          "ADB UI output exceeded its complete-capture budget",
          { max_output_bytes: CAPTURE_BYTES },
          options,
        );
      throw new AnalysisProtocolError("ADB UI transport failed", options);
    }
  }

  /** Host commands settle first so a late broadcast cannot outlive reconciliation. */
  async close(): Promise<void> {
    await this.#tail;
    await this.#retryCleanup();
  }

  #retryCleanup(): Promise<void> {
    this.#cleanup ??= this.#close().finally(() => {
      this.#cleanup = undefined;
    });
    return this.#cleanup;
  }

  async #close(): Promise<void> {
    await this.#settleCommands();
    const failures = [];
    for (const request of this.#pending.values()) {
      try {
        const signal = AbortSignal.timeout(CLEANUP_MS);
        for (;;) {
          signal.throwIfAborted();
          const reply = await this.#send(
            request.binary,
            request.serial,
            request.packageName,
            request.operation,
            {
              protocol: PROTOCOL,
              operation: "cancel",
              request_id: randomUUID(),
              instance_id: request.instanceId,
              cancel_request_id: request.requestId,
            },
            CLEANUP_MS,
            signal,
          );
          if (reply.instance_id !== request.instanceId || !reply.ok)
            throw new Error(
              reply.error?.reason ??
                "Runner identity changed during cancellation",
            );
          const result = z
            .strictObject({
              state: z.enum(["cancelling", "settled", "missing"]),
              response: envelope.nullable(),
            })
            .parse(reply.result);
          if (result.state === "missing" && !request.settled)
            throw new AnalysisProtocolError(
              "Runner has not observed the request; a delayed submission may still arrive",
            );
          if (result.state === "settled" || result.state === "missing") {
            request.settled = true;
            if (result.response !== null)
              this.#rememberCompletion(request, result.response);
            await this.#forget(request, signal);
            break;
          }
          await delay(50, undefined, { signal });
        }
      } catch (cause) {
        failures.push({
          request_id: request.requestId,
          serial: request.serial,
          runner_package: request.packageName,
          runner_instance: request.instanceId,
          runner_user: 0,
          socket_path: request.socketPath,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (failures.length) {
      const error = new ProviderCleanupError("adb", this.pendingResources, {
        failures,
      });
      this.#trackCleanupError(error);
      throw error;
    }
    for (const reference of this.#cleanupErrors)
      reference.deref()?.resolveCleanup();
    this.#cleanupErrors.clear();
  }

  #rememberCompletion(request: RemoteRequest, reply: Reply): void {
    if (
      reply.request_id !== request.requestId ||
      reply.instance_id !== request.instanceId
    )
      throw new AnalysisProtocolError(
        "Completed UI result belongs to a different request or runner",
      );
    request.completion = reply;
    request.settled = true;
  }

  async #forget(request: RemoteRequest, signal?: AbortSignal): Promise<void> {
    const reply = await this.#send(
      request.binary,
      request.serial,
      request.packageName,
      request.operation,
      {
        protocol: PROTOCOL,
        operation: "forget",
        request_id: randomUUID(),
        instance_id: request.instanceId,
        target_request_id: request.requestId,
      },
      CLEANUP_MS,
      signal,
    );
    if (reply.instance_id !== request.instanceId || !reply.ok)
      throw new AnalysisProtocolError(
        "Could not release the completed UI request",
      );
    z.strictObject({ state: z.literal("forgotten") }).parse(reply.result);
    this.#pending.delete(request.requestId);
  }

  async execute(
    request: AdbUiRequest,
    binary: string,
    client: z.infer<typeof adbClientIdentitySchema>,
    provider: ProviderIdentity,
    signal?: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const predecessor = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(
            new AnalysisCancelledError(request.operation, {
              cause: signal?.reason,
            }),
          );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        void predecessor.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
    } catch (cause) {
      void predecessor.then(release);
      return err(
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCancelledError(request.operation, { cause }),
      );
    }
    try {
      return await this.#execute(request, binary, client, provider, signal);
    } finally {
      release();
    }
  }

  async #execute(
    request: AdbUiRequest,
    binary: string,
    client: z.infer<typeof adbClientIdentitySchema>,
    provider: ProviderIdentity,
    signal?: AbortSignal,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let primary: AnalysisError;
    let owned: RemoteRequest | undefined;
    let observed: UiObservation | undefined;
    try {
      await this.#retryCleanup();
      if (signal?.aborted)
        throw new AnalysisCancelledError(request.operation, {
          cause: signal.reason,
        });
      const selected = this.environment[PACKAGE_ENV];
      const parsedPackage = adbPackageNameSchema.safeParse(
        selected === undefined || selected === "" ? DEFAULT_PACKAGE : selected,
      );
      if (!parsedPackage.success)
        throw new AnalysisInputError(request.operation, {
          userMessage: `${PACKAGE_ENV} must name the installed runner package`,
        });
      const packageName = parsedPackage.data;
      const { serial } = request.input;
      const ping = await this.#send(
        binary,
        serial,
        packageName,
        request.operation,
        { protocol: PROTOCOL, request_id: randomUUID(), operation: "ping" },
        10000,
        signal,
      );
      if (!ping.ok)
        throw new AnalysisCapabilityUnavailableError(
          "adb",
          request.operation,
          ping.error!.reason,
        );
      const hello = z
        .strictObject({
          runner: adbUiRunnerIdentitySchema,
          socket_path: z.string(),
        })
        .safeParse(ping.result);
      if (!hello.success)
        throw new AnalysisCapabilityUnavailableError(
          "adb",
          request.operation,
          "Rebuild and start the matching debug UI runner with protocol v2 private stdin transport.",
        );
      const identity = hello.data.runner;
      if (
        hello.data.socket_path !== `files/rea-ui-${identity.instance_id}.sock`
      )
        throw new AnalysisProtocolError(
          "UI runner socket does not belong to its reported instance",
        );
      if (
        identity.package_name !== packageName ||
        identity.instance_id !== ping.instance_id
      )
        throw new AnalysisProtocolError(
          "UI runner identity does not match the selected endpoint",
        );
      owned = {
        binary,
        serial,
        packageName,
        instanceId: identity.instance_id,
        requestId: randomUUID(),
        operation: request.operation,
        socketPath: hello.data.socket_path,
      };
      const payload = {
        protocol: PROTOCOL,
        request_id: owned.requestId,
        instance_id: owned.instanceId,
        operation: request.operation,
        input: request.input,
      };
      // No remote authority is retained for requests refused before transport.
      if (Buffer.byteLength(JSON.stringify(payload)) > REQUEST_BYTES)
        throw new AnalysisResourceConstraintError(
          request.operation,
          "transport",
          "UI request exceeds the 16 KiB protocol budget",
          { max_request_bytes: REQUEST_BYTES },
        );
      let reply = await this.#send(
        binary,
        serial,
        packageName,
        request.operation,
        {
          protocol: PROTOCOL,
          request_id: owned.requestId,
          instance_id: owned.instanceId,
          operation: "prepare",
          target_operation: request.operation,
        },
        10000,
        signal,
        owned,
      );
      if (reply.instance_id !== owned.instanceId)
        throw new AnalysisProtocolError(
          "UI runner changed during request preparation",
        );
      if (!reply.ok) this.#pending.delete(owned.requestId);
      else {
        z.strictObject({ state: z.literal("prepared") }).parse(reply.result);
        reply = await this.#send(
          binary,
          serial,
          packageName,
          request.operation,
          payload,
          10000,
          signal,
          undefined,
          owned.socketPath,
        );
      }
      if (reply.instance_id !== owned.instanceId)
        throw new AnalysisProtocolError(
          "UI runner restarted while a request was outstanding",
        );
      if (reply.ok) {
        z.strictObject({ state: z.literal("accepted") }).parse(reply.result);
        const deadline = AbortSignal.timeout(request.input.timeout_ms + 10000);
        const pollSignal =
          signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
        try {
          for (;;) {
            const status = await this.#send(
              binary,
              serial,
              packageName,
              request.operation,
              {
                protocol: PROTOCOL,
                operation: "status",
                request_id: randomUUID(),
                instance_id: owned.instanceId,
                target_request_id: owned.requestId,
              },
              10000,
              pollSignal,
            );
            if (
              status.instance_id === owned.instanceId &&
              status.error?.kind === "capacity"
            )
              throw new AnalysisResourceConstraintError(
                request.operation,
                "transport",
                status.error.reason,
                { max_response_bytes: RESPONSE_BYTES },
              );
            if (status.instance_id !== owned.instanceId || !status.ok)
              throw new AnalysisProtocolError(
                status.error?.reason ??
                  "UI runner changed while awaiting completion",
              );
            const progress = z
              .strictObject({
                state: z.enum(["running", "settled", "missing"]),
                response: envelope.nullable(),
              })
              .parse(status.result);
            if (progress.state === "missing")
              throw new AnalysisProtocolError(
                "UI runner lost an unacknowledged request",
              );
            if (progress.state === "settled") {
              if (progress.response === null)
                throw new AnalysisProtocolError(
                  "Completed UI request has no result",
                );
              this.#rememberCompletion(owned, progress.response);
              reply = progress.response;
              // Validate the report before acknowledgement/finalization can be
              // interrupted, and retain the parsed facts through that phase.
              observed = this.#validateObservation(
                request,
                owned,
                reply,
                signal,
              );
              await this.#forget(owned, pollSignal);
              break;
            }
            await delay(50, undefined, { signal: pollSignal });
          }
        } catch (cause) {
          if (deadline.aborted && !signal?.aborted)
            throw new AnalysisTimeoutError(
              request.operation,
              request.input.timeout_ms,
              { cause },
            );
          throw cause;
        }
      }
      observed ??= this.#validateObservation(request, owned, reply, signal);
      if (signal?.aborted)
        throw new AnalysisCancelledError(request.operation, {
          cause: signal.reason,
        });
      return ok(
        createAnalysisExecution({ client, serial, ...observed }, provider, {
          limitations: [
            "UI Automator observes accessibility-exposed nodes; off-screen, custom-drawn and inaccessible content can be missing.",
            "Snapshots and input dispatch are sequential observations, not an atomic UI transaction. A returned action is not proof of the intended application outcome.",
            "Runner version and instance identity are reported by the operator-owned instrumentation process; REA does not install, start or stop that process implicitly.",
          ],
        }),
      );
    } catch (cause) {
      primary =
        signal?.aborted &&
        (cause === signal.reason ||
          (cause instanceof Error && cause.name === "AbortError"))
          ? new AnalysisCancelledError(request.operation, {
              cause: signal.reason,
            })
          : cause instanceof AnalysisError
            ? cause
            : new AnalysisOutputError(
                request.operation,
                "Invalid UI runner response",
                { cause },
              );
    }
    const retainCompleted = () => {
      if (!owned?.completion?.ok) return;
      try {
        observed ??= this.#validateObservation(
          request,
          owned,
          owned.completion,
          signal,
        );
      } catch (cause) {
        if (
          primary instanceof AnalysisCancelledError &&
          cause instanceof AnalysisError
        ) {
          const cancellation = primary;
          primary = cause;
          primary.retainSecondaryFailure(cancellation, {});
        }
        return;
      }
      primary.retainPartialObservation({
        provider_id: "adb",
        operation: request.operation,
        result: { client, serial: request.input.serial, ...observed },
      });
    };
    try {
      await this.#retryCleanup();
    } catch (cause) {
      retainCompleted();
      const cleanup =
        cause instanceof ProviderCleanupError
          ? cause
          : new ProviderCleanupError(
              "adb",
              this.pendingResources,
              {},
              { cause },
            );
      const combined = analysisErrorWithCleanupFailure(
        primary,
        cleanup,
        request.operation,
      ).bindCleanupDependencies([primary, cleanup]);
      this.#trackCleanupError(combined);
      return err(combined);
    }
    retainCompleted();
    return err(primary);
  }

  #validateObservation(
    request: AdbUiRequest,
    owned: RemoteRequest,
    reply: Reply,
    signal?: AbortSignal,
  ): UiObservation {
    if (!reply.ok) {
      const failure = reply.error!;
      if (failure.kind === "timeout")
        throw new AnalysisTimeoutError(
          request.operation,
          request.input.timeout_ms,
        );
      if (failure.kind === "cancelled")
        throw new AnalysisCancelledError(request.operation, {
          cause: signal?.aborted ? signal.reason : failure.reason,
        });
      if (failure.kind === "busy" || failure.kind === "capacity")
        throw new AnalysisResourceConstraintError(
          request.operation,
          "capacity",
          failure.reason,
          null,
        );
      throw new AnalysisOutputError(request.operation, failure.kind, {
        userMessage: failure.reason,
        diagnostics: {
          runner_failure: failure.kind,
          runner_instance: owned.instanceId,
        },
        remediationAction:
          "Inspect or find the current UI again, then select an enabled, visible element from that snapshot.",
      });
    }
    const parsed = adbUiObservationSchemas[request.operation].safeParse(
      reply.result,
    );
    if (!parsed.success)
      throw new AnalysisOutputError(
        request.operation,
        "Invalid UI runner response",
        { cause: parsed.error },
      );
    const observation = parsed.data;
    const snapshot =
      "before" in observation ? observation.before : observation.snapshot;
    if (
      observation.runner.instance_id !== owned.instanceId ||
      snapshot.package_name !== request.input.package ||
      snapshot.display_id !== request.input.display_id ||
      snapshot.window_id_filter !== (request.input.window_id ?? null)
    )
      throw new AnalysisProtocolError(
        "UI observation does not match the requested scope",
      );
    return observation;
  }
}
