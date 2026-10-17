"use strict";

const applyFunction = Reflect.apply;
const applyArguments = Function.prototype.apply;
const bindFunction = Function.prototype.bind;
const callFunction = Function.prototype.call;
const arrayFrom = Array.from;
const defineProperty = Object.defineProperty;
const ownPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const nativeFunctionPrototype = getPrototypeOf(callFunction);
const getProperty = Reflect.get;
const setProperty = Reflect.set;
const SetConstructor = Set;
const ProxyConstructor = Proxy;
const bindBuiltinMethod = (method) =>
  applyFunction(bindFunction, callFunction, [method]);
const forEachMapEntry = bindBuiltinMethod(Map.prototype.forEach);
const sliceArguments = bindBuiltinMethod(Array.prototype.slice);
const arrayLastIndexOf = bindBuiltinMethod(Array.prototype.lastIndexOf);
const arrayPush = bindBuiltinMethod(Array.prototype.push);
const arrayPop = bindBuiltinMethod(Array.prototype.pop);
const weakMapHas = bindBuiltinMethod(WeakMap.prototype.has);
const weakMapGet = bindBuiltinMethod(WeakMap.prototype.get);
const weakMapSet = bindBuiltinMethod(WeakMap.prototype.set);
const setHas = bindBuiltinMethod(Set.prototype.has);
const setAdd = bindBuiltinMethod(Set.prototype.add);
const hasOwnProperty = bindBuiltinMethod(Object.prototype.hasOwnProperty);

const { isProxy } = require("node:util").types;
const {
  createElectronActiveBoundaryPatches,
} = require("./electron-active-hook-boundaries.cjs");

const ipcEventKinds = new SetConstructor([
  "main-handler-invocation",
  "main-event-invocation",
  "utility-process-fork",
  "utility-process-message",
  "ipc-main-to-renderer",
  "ipc-utility-to-main",
  "ipc-renderer-send",
  "ipc-renderer-invoke",
  "ipc-renderer-post-message",
]);
const events = [];
// Budget serialized data and estimated retained object/array storage together.
const retentionBudgetBytes = 16 * 1024 * 1024;
const snapshotEnvelopeReserveBytes = 1024;
let estimatedRetainedBytes = 0;
let serializedBytes = 0;
let observed = 0;
let observedIpc = 0;
let observedRuntime = 0;
let dropped = 0;
let droppedIpc = 0;
let droppedRuntime = 0;
const droppedFamilies = new Map();
const droppedRoles = new Map();
let sequence = 0;
let correlationSequence = 0;

const shape = (value, depth = 0) => {
  if (depth > 2 || value === null) return value === null ? "null" : "nested";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "undefined";
    case "function":
      return "function";
    case "object":
      return "object";
    default:
      return "unknown";
  }
};

// Measure JSON strings without allocating an encoded copy of a caller value.
const jsonStringBytes = (value) => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > retentionBudgetBytes) return bytes;
  }
  return bytes;
};

const jsonScalarBytes = (value) => {
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  return String(value).length;
};

const eventFamily = (kind, processTypeValue) => {
  if (
    kind === "preload" &&
    (processTypeValue === "main" || processTypeValue === "browser")
  )
    return "preload-configuration";
  if (kind.startsWith("ipc-renderer"))
    return processTypeValue === "renderer" ? "renderer-ipc" : "ipc";
  return setHas(ipcEventKinds, kind) ? "ipc" : kind;
};

const noteDropped = (kind, processTypeValue, isIpc) => {
  dropped += 1;
  if (isIpc) droppedIpc += 1;
  else droppedRuntime += 1;
  const family = eventFamily(kind, processTypeValue);
  droppedFamilies.set(family, (droppedFamilies.get(family) ?? 0) + 1);
  if (typeof processTypeValue === "string")
    droppedRoles.set(
      processTypeValue,
      (droppedRoles.get(processTypeValue) ?? 0) + 1,
    );
  if (kind === "window-lifecycle")
    droppedRoles.set("window", (droppedRoles.get("window") ?? 0) + 1);
  if (kind === "web-contents-lifecycle" || kind === "navigation")
    droppedRoles.set(
      "web_contents",
      (droppedRoles.get("web_contents") ?? 0) + 1,
    );
  if (kind === "preload" && processTypeValue === "preload")
    droppedRoles.set("preload", (droppedRoles.get("preload") ?? 0) + 1);
};

const isAllowedNavigation = (value) => {
  if (typeof value !== "string") return true;
  try {
    const parsed = new URL(value);
    if (["file:", "data:", "about:"].includes(parsed.protocol)) return true;
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

const processType = () =>
  typeof process.type === "string" && process.type.length > 0
    ? process.type
    : "main";

const identity = (value, prefix) => {
  if (value === null || value === undefined) return null;
  const id = value.id;
  const processId = value.pid;
  return typeof id === "string" || typeof id === "number"
    ? `${prefix}:${String(id)}`
    : typeof processId === "number"
      ? `${prefix}:pid:${String(processId)}`
      : null;
};

const frameIdentity = (event) => {
  const frame = event?.senderFrame ?? event?.frame;
  const id = frame?.frameTreeNodeId ?? frame?.routingId ?? frame?.id;
  return typeof id === "string" || typeof id === "number"
    ? `frame:${String(id)}`
    : null;
};

const record = (event) => {
  observed += 1;
  const isIpc = setHas(ipcEventKinds, event.kind);
  if (isIpc) observedIpc += 1;
  else observedRuntime += 1;
  const raw = {
    sequence: ++sequence,
    correlation_id:
      typeof event.correlation_id === "string"
        ? event.correlation_id
        : `capture:${process.pid}:${++correlationSequence}`,
    event: null,
    phase: "observed",
    channel: null,
    direction: null,
    sender: null,
    receiver: null,
    frame: null,
    target: null,
    argument_shapes: [],
    result_shape: null,
    process_type: processType(),
    source: "electron-active-hook",
    capture_method: "api-wrapper",
    artifact_path: null,
    artifact_sha256: null,
    error: false,
    ...event,
  };
  const shapeGroups = Array.isArray(raw.argument_shape_value_groups)
    ? raw.argument_shape_value_groups
    : Array.isArray(raw.argument_shape_values)
      ? [raw.argument_shape_values]
      : [];
  const existingShapes = Array.isArray(raw.argument_shapes)
    ? raw.argument_shapes
    : [];
  const retainedEvent = {
    ...raw,
    correlation_id: raw.correlation_id,
    event: typeof raw.event === "string" ? raw.event : null,
    channel: typeof raw.channel === "string" ? raw.channel : null,
    sender: typeof raw.sender === "string" ? raw.sender : null,
    receiver: typeof raw.receiver === "string" ? raw.receiver : null,
    frame: typeof raw.frame === "string" ? raw.frame : null,
    target: typeof raw.target === "string" ? raw.target : null,
    argument_shapes: [],
    result_shape:
      typeof raw.result_shape === "string" ? raw.result_shape : null,
    process_type:
      typeof raw.process_type === "string" ? raw.process_type : null,
    artifact_path:
      typeof raw.artifact_path === "string" ? raw.artifact_path : null,
    artifact_sha256:
      typeof raw.artifact_sha256 === "string" ? raw.artifact_sha256 : null,
  };
  delete retainedEvent.argument_shape_values;
  delete retainedEvent.argument_shape_value_groups;

  // All event values are JSON scalars except argument_shapes. Measure them
  // incrementally so large channels, paths, or shape lists never require a
  // full JSON.stringify temporary allocation before the budget decision.
  let eventBytes = 2;
  let argumentShapeCount = 0;
  const eventKeys = Object.keys(retainedEvent);
  for (let index = 0; index < eventKeys.length; index += 1) {
    const key = eventKeys[index];
    const value = retainedEvent[key];
    if (index > 0) eventBytes += 1;
    eventBytes += jsonStringBytes(key) + 1;
    if (key === "argument_shapes") {
      eventBytes += 2;
      let shapeOverflow = false;
      const countShape = (argument) => {
        const encodedShapeBytes = jsonStringBytes(shape(argument));
        eventBytes += encodedShapeBytes + (argumentShapeCount === 0 ? 0 : 1);
        argumentShapeCount += 1;
        shapeOverflow =
          eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
          retentionBudgetBytes;
      };
      for (const group of shapeGroups) {
        if (!Array.isArray(group)) continue;
        for (const argument of group) {
          countShape(argument);
          if (shapeOverflow) break;
        }
      }
      if (shapeOverflow) {
        noteDropped(raw.kind, retainedEvent.process_type, isIpc);
        return null;
      }
      for (const valueShape of existingShapes)
        if (!shapeOverflow) {
          eventBytes +=
            jsonStringBytes(
              typeof valueShape === "string" ? valueShape : "unknown",
            ) + (argumentShapeCount++ === 0 ? 0 : 1);
          shapeOverflow =
            eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
            retentionBudgetBytes;
        }
      if (shapeOverflow) {
        noteDropped(raw.kind, retainedEvent.process_type, isIpc);
        return null;
      }
    } else eventBytes += jsonScalarBytes(value);
    if (
      eventBytes + estimatedRetainedBytes + snapshotEnvelopeReserveBytes >
      retentionBudgetBytes
    ) {
      noteDropped(raw.kind, retainedEvent.process_type, isIpc);
      return null;
    }
  }
  // Reserve room for the only fields mutated after recording: result_shape and
  // error. The shape vocabulary's longest value is "undefined".
  const reservedMutationBytes = retainedEvent.result_shape === null ? 7 : 0;
  // Include one byte for the event-array separator and reserve space for the
  // snapshot's counters and JSON delimiters.
  // One retained event, one defensive snapshot copy, and up to two serialized
  // result views (timeline plus IPC), with per-object and per-array-slot costs.
  const eventEstimateBytes = eventBytes * 3 + 512 + argumentShapeCount * 16;
  const retainedEventBytes = eventEstimateBytes + reservedMutationBytes + 1;
  if (
    estimatedRetainedBytes + retainedEventBytes + snapshotEnvelopeReserveBytes >
    retentionBudgetBytes
  ) {
    noteDropped(raw.kind, retainedEvent.process_type, isIpc);
    return null;
  }
  for (const group of shapeGroups) {
    if (!Array.isArray(group)) continue;
    for (const argument of group)
      retainedEvent.argument_shapes.push(shape(argument));
  }
  for (const valueShape of existingShapes)
    retainedEvent.argument_shapes.push(
      typeof valueShape === "string" ? valueShape : "unknown",
    );
  events.push(retainedEvent);
  estimatedRetainedBytes += retainedEventBytes;
  serializedBytes += eventBytes + reservedMutationBytes + 1;
  return retainedEvent;
};

const recordRuntime = (kind, event, phase, details = {}) =>
  record({ kind, event, phase, ...details });

const recordIpc = (kind, channel, args, details = {}) =>
  (() => {
    const values = Array.isArray(args) ? args : [];
    return record({
      kind,
      channel: typeof channel === "string" ? channel : null,
      argument_shape_values: values,
      ...details,
    });
  })();

const recordIpcObservationGap = (channel, event, error = false) =>
  recordRuntime("ipc-observation-gap", event, error ? "failed" : "observed", {
    channel,
    target: "ipcMain.on",
    process_type: "main",
    error,
  });

const patchEmitter = (emitter, observeEvent) => {
  if (emitter === null || emitter === undefined) return;
  const original = emitter.emit;
  if (typeof original !== "function") return;
  if (emitter.__reaElectronActiveEmitPatched === true) return;
  try {
    emitter.__reaElectronActiveEmitPatched = true;
    emitter.emit = function patchedEmit(event, ...args) {
      if (typeof event === "string") observeEvent.call(this, event, args);
      return original.call(this, event, ...args);
    };
  } catch {
    globalThis.__reaElectronActiveHookError = true;
  }
};

const recordInvocation = (kind, channel, event, args) =>
  recordIpc(kind, channel, args, {
    direction: "renderer-to-main",
    sender: identity(event?.sender, "webContents"),
    receiver: "main",
    frame: frameIdentity(event),
    process_type: "main",
    error: false,
  });

const invokeObservedEventListener = (thisArg, channel, listener, args) => {
  // Recording slices an actual invocation frame, avoiding Array species;
  // callback dispatch keeps its native Array/Arguments representation.
  const recorded = recordInvocation(
    "main-event-invocation",
    channel,
    args[0],
    sliceArguments(args, 1),
  );
  try {
    return applyFunction(listener, thisArg, args);
  } catch (cause) {
    if (recorded !== null) recorded.error = true;
    throw cause;
  }
};

// Recording wrappers follow EventEmitter's own wrapper convention: `.listener`
// names the caller's function so native removal can match it. Node retains
// ownership of listener traversal and meta-events; hook-created "on" entries
// are translated before calling the application's removal method/decorators.
// Only hook-created wrappers are tracked, by the registration they stand in
// for: they already record, so patched on() registers them as is. An "on"
// wrapper stands in for the caller's raw function and a "once" wrapper for
// EventEmitter's once wrapper, which removeAllListeners reports accordingly.
// The value is the native removal argument: the app function for an "on"
// wrapper, or the wrapper itself for "once". Public .listener is mutable;
// it is not the authority for the original function's identity.
const hookListenerRemovalTargets = new WeakMap();
const MAX_LISTENER_CHAIN_HOPS = 16;

// Parse native property lookup without invoking application getters or Proxy
// traps. Undefined means absent; null means the lookup is unknown.
const lookupPropertyDescriptor = (listener, key) => {
  let candidate = listener;
  for (
    let hops = 0;
    hops <= MAX_LISTENER_CHAIN_HOPS && candidate !== null;
    hops += 1
  ) {
    if (isProxy(candidate)) return null;
    const descriptor = ownPropertyDescriptor(candidate, key);
    if (descriptor !== undefined) return descriptor;
    candidate = getPrototypeOf(candidate);
  }
  return candidate === null ? undefined : null;
};

const listenerDataDescriptor = (listener) => {
  const descriptor = lookupPropertyDescriptor(listener, "listener");
  if (descriptor === null || descriptor === undefined) return descriptor;
  if (hasOwnProperty(descriptor, "value")) return descriptor;
  // A setter-only property shadows ancestors with a known undefined read.
  return descriptor.get === undefined ? undefined : null;
};

// A decorator that wraps once's hook wrapper and names it through `.listener`
// already records through that wrapper. Registering the decorator as is keeps
// native self-removal working: the once wrapper removes itself by identity, and
// removeListener matches the decorator through its `.listener`.
const classifyHookListenerWrapper = (listener) => {
  const visited = new SetConstructor();
  let candidate = listener;
  for (
    let hops = 0;
    hops <= MAX_LISTENER_CHAIN_HOPS && typeof candidate === "function";
    hops += 1
  ) {
    if (weakMapHas(hookListenerRemovalTargets, candidate)) return "owned";
    if (setHas(visited, candidate)) return "unowned";
    setAdd(visited, candidate);
    const descriptor = listenerDataDescriptor(candidate);
    if (descriptor === null) return "unknown";
    candidate = descriptor?.value;
  }
  return typeof candidate === "function" ? "unknown" : "unowned";
};

const createObservedOnceCallback = (target, channel, listener, receiver) => {
  // A private callable target avoids Proxy get invariants on an app's
  // non-configurable, read-only call/apply properties. It never escapes
  // through the native once wrapper's public listener link.
  const callback = new ProxyConstructor(
    function observedOnceListener() {
      return invokeObservedEventListener(
        this === receiver ? target : this,
        channel,
        listener,
        arguments,
      );
    },
    {
      get: (_callable, key) => {
        let value;
        try {
          value = getProperty(listener, key, listener);
        } catch (cause) {
          if (key === "call" || key === "apply")
            recordIpcObservationGap(channel, `custom-${key}`, true);
          throw cause;
        }
        if (key !== "call" && key !== "apply") return value;
        if (typeof value !== "function") {
          recordIpcObservationGap(channel, `custom-${key}`, true);
          return value;
        }
        if (value === callFunction || value === applyArguments) return value;
        // A runtime that selects an application method must preserve that
        // method's receiver and original argument-list object. Its body may
        // bypass the callable Proxy, so retain a gap rather than an invocation.
        return new ProxyConstructor(value, {
          apply: (method, thisArg, args) => {
            const gap = recordIpcObservationGap(channel, `custom-${key}`);
            if (args[0] === receiver) args[0] = target;
            try {
              return applyFunction(
                method,
                thisArg === callback ? listener : thisArg,
                args,
              );
            } catch (cause) {
              if (gap !== null) {
                gap.error = true;
                gap.phase = "failed";
              }
              throw cause;
            }
          },
        });
      },
    },
  );
  return callback;
};

const patchIpcMain = (ipcMain) => {
  if (ipcMain === null || ipcMain === undefined) return;
  // Wrapper removals whose translated call is still running. Each flight
  // names the channel and wrapper a removeAllListeners traversal is
  // removing and whether that same wrapper was re-registered on that
  // channel during the call.
  const listenerRemovalFlights = [];
  const { handle, on, once, removeAllListeners } = ipcMain;
  let unobservedOnceScope = null;
  if (typeof handle === "function")
    ipcMain.handle = function patchedIpcMainHandle(channel, listener) {
      if (typeof listener !== "function")
        return handle.call(this, channel, listener);
      return handle.call(
        this,
        channel,
        async function wrappedHandler(event, ...args) {
          const recorded = recordInvocation(
            "main-handler-invocation",
            channel,
            event,
            args,
          );
          try {
            const result = await applyFunction(listener, this, arguments);
            if (recorded !== null) recorded.result_shape = shape(result);
            return result;
          } catch (cause) {
            if (recorded !== null) recorded.error = true;
            throw cause;
          }
        },
      );
    };
  if (typeof on !== "function") return;
  ipcMain.on = function patchedIpcMainOn(channel, listener) {
    if (typeof listener !== "function") return on.call(this, channel, listener);
    if (unobservedOnceScope !== null) {
      const scope = unobservedOnceScope;
      const result = on.call(this, channel, listener);
      recordIpcObservationGap(channel, "once-metadata");
      if (scope.channel === channel) scope.gapRecorded = true;
      return result;
    }
    const wrapperStatus = classifyHookListenerWrapper(listener);
    if (wrapperStatus !== "unowned") {
      // Registering a wrapper whose translated removal is still in
      // flight (an observer restoring a saved raw entry) adds a NEW
      // registration, not the one being removed. Identity can no longer
      // name the original registration, so every in-flight completion
      // for that wrapper on the SAME channel must stand down instead of
      // deleting the restore; registering it on another channel is a
      // separate registration and leaves the original completion armed.
      if (listenerRemovalFlights.length !== 0) {
        for (
          let index = listenerRemovalFlights.length - 1;
          index >= 0;
          index -= 1
        ) {
          const flight = listenerRemovalFlights[index];
          if (flight.entry === listener && flight.channel === channel)
            flight.reregistered = true;
        }
      }
      const result = on.call(this, channel, listener);
      if (wrapperStatus === "unknown")
        recordIpcObservationGap(channel, "listener-chain");
      return result;
    }
    const wrapped = function wrappedEventListener() {
      return invokeObservedEventListener(this, channel, listener, arguments);
    };
    // Native single-listener dispatch reads .apply; array dispatch invokes the
    // function directly. Let Node select that path without inspecting or
    // copying the emitter's listener storage, including during reentrant emits.
    defineProperty(wrapped, "apply", {
      configurable: true,
      writable: true,
      value: function nativeApply(...methodArgs) {
        let applicationApply;
        try {
          applicationApply = listener.apply;
        } catch (cause) {
          recordIpcObservationGap(channel, "custom-apply", true);
          throw cause;
        }
        if (applicationApply !== applyArguments) {
          // Custom apply owns the original list's interpretation. Forward it
          // unchanged rather than executing getters to invent callback facts.
          const gap = recordIpcObservationGap(channel, "custom-apply");
          try {
            return applyFunction(
              applicationApply,
              this === wrapped ? listener : this,
              methodArgs,
            );
          } catch (cause) {
            if (gap !== null) {
              gap.error = true;
              gap.phase = "failed";
            }
            throw cause;
          }
        }
        // Native Function.apply performs its own list conversion before the
        // recording wrapper observes an actual invocation frame.
        // Borrowing the exposed method keeps its dynamic receiver.
        return applyFunction(applyArguments, this, methodArgs);
      },
    });
    defineProperty(wrapped, "listener", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: listener,
    });
    weakMapSet(hookListenerRemovalTargets, wrapped, listener);
    return on.call(this, channel, wrapped);
  };
  // Native once owns firing, removal and callback dispatch. Node versions
  // differ in whether they read callback.call/apply. Observe actual invocation
  // through a private callable Proxy instead of copying either implementation.
  if (typeof once === "function")
    ipcMain.once = function patchedIpcMainOnce(channel, listener) {
      if (
        typeof listener !== "function" ||
        this === null ||
        (typeof this !== "object" && typeof this !== "function")
      )
        return once.call(this, channel, listener);
      const target = this;
      const metadata = lookupPropertyDescriptor(
        nativeFunctionPrototype,
        "listener",
      );
      const onMetadata = lookupPropertyDescriptor(target, "on");
      if (
        metadata === null ||
        (metadata !== undefined && !hasOwnProperty(metadata, "value")) ||
        onMetadata === null ||
        (onMetadata !== undefined && !hasOwnProperty(onMetadata, "value"))
      ) {
        // Native wrapper creation can expose its callback through an inherited
        // setter/Proxy, including one installed by an on getter. Pass the exact
        // app callback; registrations in this synchronous scope stay unwrapped.
        const previousScope = unobservedOnceScope;
        const scope = { channel, gapRecorded: false };
        let failed = true;
        unobservedOnceScope = scope;
        try {
          const result = applyFunction(once, target, [channel, listener]);
          failed = false;
          return result;
        } finally {
          unobservedOnceScope = previousScope;
          // An app decorator can register through an unhooked alias and then
          // throw. Preserve a gap for either outcome, not proof of registration.
          if (!scope.gapRecorded)
            recordIpcObservationGap(channel, "once-metadata", failed);
        }
      }
      const receiver = new ProxyConstructor(
        { __proto__: null },
        {
          get: (_target, key) => {
            const value = getProperty(target, key, target);
            if (
              (key !== "on" && key !== "removeListener") ||
              typeof value !== "function"
            )
              return value;
            return function forwardOnceOperation(...args) {
              if (key === "on") {
                const wrapped = args[1];
                defineProperty(wrapped, "listener", {
                  ...ownPropertyDescriptor(wrapped, "listener"),
                  value: listener,
                });
                weakMapSet(hookListenerRemovalTargets, wrapped, wrapped);
              }
              return applyFunction(value, target, args);
            };
          },
          set: (_target, key, value) => setProperty(target, key, value, target),
        },
      );
      const callback = createObservedOnceCallback(
        target,
        channel,
        listener,
        receiver,
      );
      const result = applyFunction(once, receiver, [channel, callback]);
      return result === receiver ? target : result;
    };
  if (typeof removeAllListeners !== "function") return;
  const nativeRemoveListener = ipcMain.removeListener;
  const nativeRawListeners = ipcMain.rawListeners;
  const completionAvailable =
    typeof nativeRemoveListener === "function" &&
    typeof nativeRawListeners === "function";
  // Observed forwarding, not end-state inference: removeListener is patched
  // like the registration methods so an in-flight translated removal can
  // prove what the application's decorator chain did. The patch is a pure
  // pass-through for every direct call — unchanged arguments and receiver,
  // no metadata reads — so direct removal semantics stay byte-identical to
  // plain EventEmitter. Its only addition serves a translated removal in
  // flight: when the listener argument equals that flight's translated
  // target, the application forwarded the removal (a decorator that
  // swallows never reaches the instance's removeListener), and the live
  // list is walked — without executing application getters — for the last
  // registration the forwarded native call can match: the argument itself,
  // or an entry whose data `.listener` names it. Native removeListener
  // always removes its last match, so finding one proves the forwarded
  // call removes a registration and this request is already satisfied;
  // accessor metadata is unpredictable rather than read. Applications that
  // captured removeListener before the hook loaded bypass this marker, the
  // same trust boundary as the other patched methods: the hook loads
  // through -r before application code.
  if (completionAvailable)
    ipcMain.removeListener = function patchedIpcMainRemoveListener(...args) {
      if (listenerRemovalFlights.length === 0)
        return applyFunction(nativeRemoveListener, this, args);
      const channel = args[0];
      const removalTarget = args[1];
      let forwarded = false;
      for (
        let index = listenerRemovalFlights.length - 1;
        index >= 0;
        index -= 1
      ) {
        const flight = listenerRemovalFlights[index];
        if (
          flight.channel === channel &&
          flight.removalTarget === removalTarget
        ) {
          flight.forwarded = true;
          forwarded = true;
        }
      }
      if (forwarded) {
        const registrations = nativeRawListeners.call(this, channel);
        let satisfied = false;
        for (let index = registrations.length - 1; index >= 0; index -= 1) {
          const entry = registrations[index];
          if (entry === removalTarget) {
            satisfied = true;
            break;
          }
          const descriptor = listenerDataDescriptor(entry);
          if (descriptor != null && descriptor.value === removalTarget) {
            satisfied = true;
            break;
          }
        }
        if (satisfied)
          for (
            let index = listenerRemovalFlights.length - 1;
            index >= 0;
            index -= 1
          ) {
            const flight = listenerRemovalFlights[index];
            if (
              flight.channel === channel &&
              flight.removalTarget === removalTarget
            )
              flight.satisfiedByNative = true;
          }
      }
      return applyFunction(nativeRemoveListener, this, args);
    };
  // Node owns its live-array traversal. A forwarding receiver translates only
  // our "on" entries before calling the current application removal method,
  // including decorators installed/replaced during traversal. Application
  // getters and methods always receive the real emitter; its public methods
  // are never temporarily replaced. Native once entries remain unchanged.
  // The registry stays authoritative when the application mutates or
  // replaces the public `.listener` metadata: a translated removal that
  // leaves the wrapper registered — mutated metadata defeats the
  // application's own native match — is completed by wrapper identity
  // through the native removal captured here, scoped to the removal it
  // translates. Completion is observed through the patched
  // ipcMain.removeListener above, never inferred from end state: a listener
  // count or metadata observed after the decorator returns cannot show what
  // the application's own call matched, because a decorator can remove
  // another callback on the same channel during the flight, or forward
  // while the metadata is mutated and restore it before returning. Public
  // metadata is never temporarily restored, and the ordinary path does no
  // listener-list work: no count is captured, and the only list reads are
  // the patched method's forwarding check and the completion check below.
  ipcMain.removeAllListeners = function patchedIpcMainRemoveAllListeners(
    ...args
  ) {
    const emitter = this;
    // A separate empty target also permits forwarding a non-writable app
    // method; a Proxy of the emitter itself would violate get invariants.
    const receiver = new ProxyConstructor(
      { __proto__: null },
      {
        get(_target, key) {
          const value = getProperty(emitter, key, emitter);
          if (
            (key !== "removeListener" && key !== "removeAllListeners") ||
            typeof value !== "function"
          )
            return value;
          return (...methodArgs) => {
            if (key === "removeListener") {
              const entry = methodArgs[1];
              const removalTarget = weakMapGet(
                hookListenerRemovalTargets,
                entry,
              );
              // Translate by registry identity whenever the data link is a
              // data property, whatever value mutation left on it. Accessor
              // metadata stays untranslated: the application's own native
              // removal owns when that getter executes, preserving plain
              // EventEmitter parity for throwing accessors.
              if (
                removalTarget !== undefined &&
                removalTarget !== entry &&
                listenerDataDescriptor(entry) != null
              ) {
                const channel = methodArgs[0];
                const flight = {
                  channel,
                  entry,
                  forwarded: false,
                  reregistered: false,
                  removalTarget,
                  satisfiedByNative: false,
                };
                arrayPush(listenerRemovalFlights, flight);
                methodArgs[1] = removalTarget;
                let result;
                try {
                  result = applyFunction(value, emitter, methodArgs);
                } finally {
                  arrayPop(listenerRemovalFlights);
                }
                // Complete only on observed forwarding: the patched
                // ipcMain.removeListener proved the application's chain
                // passed the translated target to a native removal, and
                // that call had no registration it could match — so this
                // request removed nothing, and a matched sibling stands
                // down, keeping one removal per request. A wrapper
                // re-registered on this channel during the call is a
                // deliberate restore. The wrapper still registered by
                // identity on a re-read of the live list (shift-proof
                // under prepends) completes the removal the application's
                // own native match missed.
                if (
                  completionAvailable &&
                  flight.forwarded &&
                  !flight.satisfiedByNative &&
                  !flight.reregistered &&
                  arrayLastIndexOf(
                    nativeRawListeners.call(emitter, channel),
                    entry,
                  ) >= 0
                )
                  nativeRemoveListener.call(emitter, channel, entry);
                return result;
              }
            }
            return applyFunction(value, emitter, methodArgs);
          };
        },
        set: (_target, key, value) => setProperty(emitter, key, value, emitter),
      },
    );
    const result = applyFunction(removeAllListeners, receiver, args);
    return result === receiver ? emitter : result;
  };
};

const patchNavigationMethods = (webContents, contentsId) => {
  for (const method of ["loadURL", "loadFile", "loadDataURL"]) {
    const original = webContents[method];
    if (typeof original !== "function") continue;
    webContents[method] = function patchedNavigation(...args) {
      recordRuntime("navigation", method, "attempted", {
        target: contentsId,
        argument_shape_values: args,
      });
      if (method === "loadURL" && !isAllowedNavigation(args[0])) {
        recordRuntime("navigation", method, "blocked", {
          target: contentsId,
          error: true,
        });
        return Promise.reject(new Error("External navigation is blocked"));
      }
      try {
        const result = original.apply(this, args);
        if (result !== null && typeof result?.then === "function")
          return result.then(
            (value) => {
              recordRuntime("navigation", method, "completed", {
                target: contentsId,
              });
              return value;
            },
            (cause) => {
              recordRuntime("navigation", method, "failed", {
                target: contentsId,
                error: true,
              });
              throw cause;
            },
          );
        recordRuntime("navigation", method, "completed", {
          target: contentsId,
        });
        return result;
      } catch (cause) {
        recordRuntime("navigation", method, "failed", {
          target: contentsId,
          error: true,
        });
        throw cause;
      }
    };
  }
};

const patchWebContentsIpc = (webContents, contentsId) => {
  const originalSend = webContents.send;
  if (typeof originalSend === "function")
    webContents.send = function patchedSend(channel, ...args) {
      const recorded = recordIpc("ipc-main-to-renderer", channel, args, {
        direction: "main-to-renderer",
        sender: "main",
        receiver: contentsId,
        target: contentsId,
        process_type: "main",
        error: false,
      });
      try {
        const result = originalSend.call(this, channel, ...args);
        if (recorded !== null) recorded.result_shape = shape(result);
        return result;
      } catch (cause) {
        if (recorded !== null) recorded.error = true;
        throw cause;
      }
    };
  const originalPostMessage = webContents.postMessage;
  if (typeof originalPostMessage === "function")
    webContents.postMessage = function patchedPostMessage(
      channel,
      message,
      transfer,
    ) {
      const recorded = recordIpc(
        "ipc-main-to-renderer",
        channel,
        [message, transfer],
        {
          direction: "main-to-renderer",
          sender: "main",
          receiver: contentsId,
          target: contentsId,
          process_type: "main",
          error: false,
        },
      );
      try {
        const result = originalPostMessage.call(
          this,
          channel,
          message,
          transfer,
        );
        if (recorded !== null) recorded.result_shape = shape(result);
        return result;
      } catch (cause) {
        if (recorded !== null) recorded.error = true;
        throw cause;
      }
    };
};

const patchWebContents = (webContents, windowId) => {
  if (webContents === null || webContents === undefined) return;
  const contentsId = identity(webContents, "webContents");
  patchEmitter(webContents, (event, args) => {
    const navigation = [
      "did-start-loading",
      "did-stop-loading",
      "did-finish-load",
      "did-fail-load",
      "did-frame-finish-load",
      "will-navigate",
      "will-redirect",
    ].includes(event);
    const kind = navigation
      ? "navigation"
      : [
            "console-message",
            "render-process-gone",
            "crashed",
            "unresponsive",
            "responsive",
          ].includes(event)
        ? "error"
        : event === "did-create-window"
          ? "popup-attempt"
          : "web-contents-lifecycle";
    if (event === "will-navigate" || event === "will-redirect") {
      if (!isAllowedNavigation(args[1])) {
        const preventDefault = args[0]?.preventDefault;
        if (typeof preventDefault === "function") preventDefault.call(args[0]);
        recordRuntime("navigation", event, "blocked", {
          target: contentsId,
          sender: windowId,
          argument_shape_values: args,
          error: true,
        });
        return;
      }
    }
    recordRuntime(kind, event, "observed", {
      target: contentsId,
      sender: windowId,
      argument_shape_values: args,
      error: kind === "error",
    });
    if (event === "did-create-window") {
      const childWindow = args[0];
      patchWebContents(
        childWindow?.webContents,
        identity(childWindow, "window"),
      );
    }
  });
  patchNavigationMethods(webContents, contentsId);
  patchWebContentsIpc(webContents, contentsId);
  boundaries.patchWindowOpenHandler(webContents, contentsId);
};

const patchWindows = (app) => {
  if (app === null || app === undefined) return;
  app.on("browser-window-created", (_event, window) => {
    const targetId = identity(window, "window");
    recordRuntime("window-lifecycle", "created", "completed", {
      target: targetId,
      capture_method: "event-emitter",
    });
    try {
      // Electron 44 separates the preload descriptor from WebPreferences.
      // Read the engine's descriptor, never infer a path from application code.
      const preferences = window.webContents.getLastWebPreferences?.();
      const preload =
        typeof preferences?.preload === "string"
          ? preferences.preload
          : window.webContents._getPreloadScript?.()?.filePath;
      if (typeof preload === "string")
        recordRuntime("preload", "configured", "completed", {
          target: targetId,
          artifact_path: preload,
        });
    } catch (cause) {
      recordRuntime(
        "error",
        cause instanceof Error ? cause.message : String(cause),
        "failed",
        {
          target: targetId,
          error: true,
        },
      );
    }
    patchEmitter(window, (event) =>
      recordRuntime("window-lifecycle", event, "observed", {
        target: targetId,
      }),
    );
    patchWebContents(window.webContents, targetId);
  });
};

const boundaries = createElectronActiveBoundaryPatches({
  identity,
  patchEmitter,
  processType,
  recordIpc,
  recordRuntime,
  shape,
});

try {
  const electron = require("electron");
  patchEmitter(electron.app, (event, args) =>
    recordRuntime(
      event === "open-url" || event === "second-instance"
        ? "protocol"
        : "app-lifecycle",
      event,
      "observed",
      {
        target: "app",
        argument_shape_values: args,
        process_type: "main",
      },
    ),
  );
  patchIpcMain(electron.ipcMain);
  boundaries.patchIpcRenderer(electron.ipcRenderer);
  boundaries.patchContextBridge(electron.contextBridge);
  patchWindows(electron.app);
  boundaries.patchUtilityProcess(electron.utilityProcess);
  boundaries.patchShell(electron.shell);
  boundaries.patchSessionManager(electron.session, electron.app);
  boundaries.patchApplicationEffects(electron.app);
  boundaries.patchNativeAddonLoading();
  boundaries.patchChildProcess();
  process.once("uncaughtException", (cause, origin) => {
    recordRuntime("process-lifecycle", "uncaught-exception", "observed", {
      argument_shape_values: [cause, origin],
      error: true,
    });
    throw cause;
  });
  process.once("unhandledRejection", (reason, promise) => {
    recordRuntime("process-lifecycle", "unhandled-rejection", "observed", {
      argument_shape_values: [reason, promise],
      error: true,
    });
    throw reason;
  });
} catch (cause) {
  globalThis.__reaElectronActiveHookError = true;
  recordRuntime(
    "error",
    cause instanceof Error ? cause.message : String(cause),
    "failed",
    {
      target: "active-hook-installation",
      error: true,
    },
  );
}

// Never expose retained buffers to application iterators or array constructors.
const snapshotArray = (values, project) =>
  arrayFrom({ __proto__: null, length: values.length }, (_unused, index) =>
    project === undefined ? values[index] : project(values[index]),
  );

const snapshotCounts = (counts, field) => {
  const values = { __proto__: null, length: 0 };
  forEachMapEntry(counts, (count, value) => {
    values[values.length++] = { [field]: value, count };
  });
  return arrayFrom(values);
};

globalThis.__reaElectronActiveSnapshot = () => ({
  events: snapshotArray(events, (event) => ({
    ...event,
    argument_shapes: snapshotArray(event.argument_shapes),
  })),
  retention_budget_bytes: retentionBudgetBytes,
  estimated_retained_bytes: estimatedRetainedBytes,
  event_serialized_byte_upper_bound: serializedBytes,
  retained: events.length,
  dropped,
  dropped_ipc: droppedIpc,
  dropped_runtime: droppedRuntime,
  dropped_event_families: snapshotCounts(droppedFamilies, "family"),
  dropped_event_roles: snapshotCounts(droppedRoles, "role"),
  observed,
  observed_ipc: observedIpc,
  observed_runtime: observedRuntime,
  hook_error: globalThis.__reaElectronActiveHookError === true,
});
