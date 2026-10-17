import * as t from "@babel/types";

import { htmlUrlText, stripQueryAndFragment } from "../artifactPathSyntax.js";
import { sanitizeEndpointCandidate } from "../browserObservation.js";
import {
  addFindingOnce,
  addLocatedFinding,
} from "./javascriptStaticAnalysisFindings.js";
import {
  STATIC_ROUTE_CALL_NAMES,
  argumentNode,
  argumentValue,
  calleeName,
  endpointArgument as endpointArgumentHelper,
  prefixedArgument,
  range,
  rangeForOffsets,
  sourceSlice,
  staticPath,
  staticPathResolutionContext,
  storageKind,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  semanticStaticPropertyName,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import type {
  JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  JavaScriptEndpointInput as EndpointInput,
  JavaScriptFindingContext as FindingContext,
  JavaScriptReferenceInput as ReferenceInput,
} from "./javascriptStaticAnalysisState.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptBindingIndex,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  isUnmodifiedGlobalReference,
  isUnmodifiedImportMetaUrl,
} from "./javascriptSemanticAmbientWrites.js";
import { evaluateSemanticExpression } from "./javascriptSemanticValues.js";
import { semanticTopLevelEffectFollowsCapture } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticFactoryLoaderMemberAt,
  semanticFactoryRequireLoaderAt,
  semanticRequireLoaderAt,
} from "./javascriptSemanticRequireOrigin.js";

type JavaScriptCallLike =
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression;

/** Inspect one call or new expression for references, endpoints, storage, and roles. */
export const inspectCall = (
  node: JavaScriptCallLike,
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { accumulator } = context;
  const name = calleeName(node.callee);
  const first = stringValue(node.arguments[0]);
  const requireCall = requireCallSpecifier(node, bindings, context);
  if (requireCall !== null)
    addReference(context, {
      node,
      kind: "require",
      specifier: requireCall.specifier,
    });
  const chunkLoad = chunkLoadSpecifier(node, bindings, context);
  if (chunkLoad !== null)
    addReference(context, {
      node,
      kind: "dynamic-import",
      specifier: chunkLoad.specifier,
    });
  const worker = t.isNewExpression(node) ? node : undefined;
  const workerConstructor =
    worker === undefined
      ? undefined
      : workerConstructorKind(worker.callee, bindings);
  if (
    workerConstructor !== undefined ||
    name === "Worker" ||
    name.endsWith(".Worker")
  )
    addReference(context, {
      node,
      kind: "worker",
      // A string path is relative to the document base URL in a browser and
      // to the process cwd in Node; the analyzed source's artifact location
      // establishes neither. Only `new URL(path, import.meta.url)` names a
      // location relative to this module.
      specifier:
        workerConstructor === undefined || worker === undefined
          ? undefined
          : moduleUrlSpecifier(worker, bindings),
    });
  // Service worker strings also use the document base URL. The complete called
  // path must retain its platform identity, including the register method.
  if (
    !t.isNewExpression(node) &&
    isUnmodifiedGlobalReference(node.callee, bindings, [
      "navigator",
      "serviceWorker",
      "register",
    ])
  )
    addReference(context, {
      node,
      kind: "service-worker",
      specifier: moduleUrlSpecifier(node, bindings),
    });
  inspectEndpointCall(node, name, first, context, bindings);
  inspectStorageCall(node, name, first, context);
  if (first === "audio" || first === "video")
    noteMediaElementPreloads(node, accumulator);
  if (
    (name === "loadFile" || name.endsWith(".loadFile")) &&
    first !== undefined
  )
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "filesystem-expression",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
  if ((name === "loadURL" || name.endsWith(".loadURL")) && first !== undefined)
    addLocatedFinding(context, {
      collection: accumulator.roles,
      key: `role\0renderer\0${first}`,
      node,
      value: {
        role: "renderer",
        path: first,
        resolution_context: "module-specifier",
        mechanism: `call:${name}`,
        module_key: null,
        location: range(node),
      },
    });
};

const moduleUrlSpecifier = (
  call: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
): string | undefined => {
  const argumentExpression = argumentNode(call.arguments[0]);
  if (argumentExpression === undefined) return undefined;
  const node = unwrapJavaScriptExpression(argumentExpression).node;
  if (!t.isNewExpression(node)) return undefined;
  const callee = unwrapJavaScriptExpression(node.callee).node;
  if (
    !isUnmodifiedGlobalReference(callee, bindings, "URL") ||
    !isUnmodifiedImportMetaUrl(argumentNode(node.arguments[1]), bindings)
  )
    return undefined;
  const specifier = stringValue(node.arguments[0]);
  if (specifier === undefined) return undefined;
  const pathname = stripQueryAndFragment(specifier);
  // The module URL's scheme and filesystem/origin root are unavailable. Only
  // relative pathnames can establish a location within the artifact; retain
  // rooted paths and paths requiring URL text normalization as expressions.
  // Malformed percent escapes survive HTTP URL parsing but cannot be converted
  // from a file URL to a Node Worker path. Without the base scheme, keep that
  // ambiguity unknown; query and fragment bytes do not affect pathname lookup.
  return pathname.length > 0 &&
    !pathname.startsWith("/") &&
    !/%(?![0-9a-f]{2})/iu.test(pathname) &&
    stripQueryAndFragment(htmlUrlText(specifier)) === pathname
    ? specifier
    : undefined;
};

const workerConstructorKind = (
  callee: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
): "browser" | "node" | undefined => {
  const node = unwrapJavaScriptExpression(callee).node;
  const member =
    t.isMemberExpression(node) &&
    semanticStaticPropertyName(node.property, node.computed) === "Worker";
  const root = unwrapJavaScriptExpression(member ? node.object : node).node;
  if (!t.isIdentifier(root)) return undefined;
  const browserGlobal = member
    ? ["globalThis", "window", "self"].includes(root.name)
    : root.name === "Worker";
  if (browserGlobal && isUnmodifiedGlobalReference(node, bindings, "Worker"))
    return "browser";
  const binding = resolveSemanticBindingState(bindings, root, root.name);
  const [origin] = binding?.directOrigins ?? [];
  // Named ESM exports and module namespace exports are read-only. Default
  // imports and CommonJS objects can replace Worker, so their identity is unknown.
  return binding?.runtimeImport === true &&
    binding.definitions.length === 1 &&
    binding.directOrigins.length === 1 &&
    origin !== undefined &&
    (origin.specifier === "worker_threads" ||
      origin.specifier === "node:worker_threads") &&
    (member
      ? origin.importedPath.length === 0
      : origin.importedPath.length === 1 && origin.importedPath[0] === "Worker")
    ? "node"
    : undefined;
};

// Element factories such as jsx("audio", props) and createElement("video",
// props) carry the HTML media `preload` hint ("none", "metadata", "auto"),
// which never names an Electron preload script.
const noteMediaElementPreloads = (
  node: JavaScriptCallLike,
  accumulator: AnalysisAccumulator,
): void => {
  const props = node.arguments[1];
  if (!t.isObjectExpression(props)) return;
  for (const property of props.properties)
    if (
      t.isObjectProperty(property) &&
      semanticStaticPropertyName(property.key, property.computed) === "preload"
    )
      accumulator.mediaElementPreloads.add(property);
};

const requireCallSpecifier = (
  node: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
  context: FindingContext,
): { readonly specifier: string | undefined } | null => {
  const bareRequire = t.isIdentifier(node.callee, { name: "require" });
  if (bareRequire) {
    const loader = semanticRequireLoaderAt(
      node,
      bindings,
      context.accumulator.factoryRequireBindingIds,
    );
    if (loader === "local") return null;
    if (loader === "unknown") context.accumulator.unknownFindings += 1;
    return {
      specifier:
        loader === "unknown" ? undefined : argumentValue(node.arguments[0]),
    };
  }
  const factoryLoader = semanticFactoryRequireLoaderAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
  );
  if (factoryLoader === "factory-loader")
    return {
      specifier: argumentValue(
        node.arguments[
          t.isMemberExpression(unwrapJavaScriptExpression(node.callee).node) ||
          t.isOptionalMemberExpression(
            unwrapJavaScriptExpression(node.callee).node,
          )
            ? 1
            : 0
        ],
      ),
    };
  if (factoryLoader === "unknown") {
    context.accumulator.unknownFindings += 1;
    return { specifier: undefined };
  }
  return null;
};

const chunkLoadSpecifier = (
  node: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
  context: FindingContext,
): { readonly specifier: string | undefined } | null => {
  const loader = semanticFactoryLoaderMemberAt(
    node,
    bindings,
    context.accumulator.factoryRequireBindingIds,
    "e",
  );
  if (loader === undefined) return null;
  if (loader === "unknown") return { specifier: undefined };
  return { specifier: prefixedArgument("chunk:", node.arguments[0]) };
};

const inspectEndpointCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const route = STATIC_ROUTE_CALL_NAMES.some(
    (candidate) => name === candidate || name.endsWith(`.${candidate}`),
  );
  if (route && first !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value: first,
      mechanism: `call:${name}`,
    });
  if (isKnownNetworkRequest(node, bindings)) {
    const target = argumentNode(node.arguments[0]);
    if (target === undefined) return;
    const literal = stringValue(target);
    if (literal !== undefined) {
      addEndpoint(context, {
        node,
        kind: "network",
        value: literal,
        mechanism: `call:${name}`,
      });
      return;
    }
    const reference = requestReferenceNode(target);
    const unwrapped = unwrapJavaScriptExpression(reference).node;
    if (
      t.isIdentifier(unwrapped) ||
      t.isMemberExpression(unwrapped) ||
      t.isOptionalMemberExpression(unwrapped)
    ) {
      context.accumulator.pendingNetworkCalls.push({ node, name });
      return;
    }
    addPartialNetworkEndpoint(context, node, name, target);
    return;
  }
  // A local or shadowed function with a familiar network name is not a known
  // browser request API. Do not let the literal fallback turn it into one.
  if (isNetworkRequestSpelling(name)) return;
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const endpoint = endpointArgumentHelper(
    name,
    node.arguments,
    node.callee,
    receiverFact,
  );
  if (endpoint !== undefined)
    addEndpoint(context, {
      node,
      kind: "network",
      value: endpoint.value,
      mechanism: `call:${name}`,
      ...(endpoint.kind === "candidate" ? { interpretation: "candidate" } : {}),
    });
};

const isNetworkRequestSpelling = (name: string): boolean =>
  name === "fetch" ||
  name === "WebSocket" ||
  name === "EventSource" ||
  name === "sendBeacon" ||
  name === "window.fetch" ||
  name === "globalThis.fetch" ||
  name === "self.fetch" ||
  name === "navigator.sendBeacon";

/** Confirm that the call resolves to a built-in network API at this source site. */
const isKnownNetworkRequest = (
  node: JavaScriptCallLike,
  bindings: JavaScriptSemanticAnalysisState,
): boolean => {
  if (
    (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
    isUnmodifiedGlobalReference(node.callee, bindings, "fetch")
  )
    return true;
  if (
    t.isNewExpression(node) &&
    (isUnmodifiedGlobalReference(node.callee, bindings, "WebSocket") ||
      isUnmodifiedGlobalReference(node.callee, bindings, "EventSource"))
  )
    return true;
  return (
    (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
    isUnmodifiedGlobalReference(node.callee, bindings, [
      "navigator",
      "sendBeacon",
    ])
  );
};

/** Finish queued targets after shared member-mutation facts are indexed. */
export const finishPartialNetworkEndpoints = (
  context: FindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  index: JavaScriptBindingIndex,
): void => {
  for (const { node, name } of context.accumulator.pendingNetworkCalls) {
    const target = argumentNode(node.arguments[0]);
    if (target === undefined) continue;
    const resolved = resolvedRequestTarget(target, node, bindings, index);
    if (resolved !== undefined)
      addEndpoint(context, {
        node,
        kind: "network",
        value: resolved,
        mechanism: `call:${name}`,
      });
    else addPartialNetworkEndpoint(context, node, name, target);
  }
  context.accumulator.pendingNetworkCalls.length = 0;
  context.accumulator.endpoints.sort(
    (left, right) => left.offset - right.offset,
  );
};

const addPartialNetworkEndpoint = (
  context: FindingContext,
  node: JavaScriptCallLike,
  name: string,
  target: t.Node,
): void =>
  addEndpoint(context, {
    node,
    kind: "network",
    // Partial values preserve the original expression text, byte for byte.
    value: sourceSlice(context.source, target),
    mechanism: `call:${name}`,
    resolution: "partial",
  });

const resolvedRequestTarget = (
  node: t.Node,
  site: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index: JavaScriptBindingIndex,
): string | undefined => {
  const reference = requestReferenceNode(node);
  // A toString result is selected before the enclosing request invocation.
  const expression = unwrapJavaScriptExpression(node).node;
  const capture = reference === expression ? site : expression;
  if (index.referenceMayHaveChangedAt(capture, reference)) return undefined;
  if (!requestInitializerPrecedesSite(reference, capture, bindings, index))
    return undefined;
  const evaluated = evaluateSemanticExpression(node, bindings);
  if (evaluated.status === "literal" && typeof evaluated.value === "string")
    return evaluated.value;
  return urlObjectRequestTarget(node, capture, bindings, index);
};

const requestInitializerPrecedesSite = (
  reference: t.Node,
  site: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index: JavaScriptBindingIndex,
): boolean => {
  const binding = index.bindingForReferenceAt(reference);
  const initializer = semanticStableInitializer(binding, bindings);
  return (
    initializer !== undefined &&
    semanticTopLevelEffectFollowsCapture(
      initializer.node,
      site,
      bindings.parentsByNode,
    )
  );
};

const requestReferenceNode = (node: t.Node): t.Node => {
  const target = unwrapJavaScriptExpression(node).node;
  if (
    (t.isCallExpression(target) || t.isOptionalCallExpression(target)) &&
    target.arguments.length === 0
  ) {
    const callee = unwrapJavaScriptExpression(target.callee).node;
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      semanticStaticPropertyName(callee.property, callee.computed) ===
        "toString"
    )
      return unwrapJavaScriptExpression(callee.object).node;
  }
  return target;
};

/** Resolve an immutable URL object or alias only while shared effects say it is unchanged. */
const urlObjectRequestTarget = (
  node: t.Node,
  site: t.Node,
  bindings: JavaScriptSemanticAnalysisState,
  index: JavaScriptBindingIndex,
  seen = new Set<string>(),
): string | undefined => {
  let target = unwrapJavaScriptExpression(node).node;
  if (
    (t.isCallExpression(target) || t.isOptionalCallExpression(target)) &&
    target.arguments.length === 0
  ) {
    const callee = unwrapJavaScriptExpression(target.callee).node;
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      semanticStaticPropertyName(callee.property, callee.computed) ===
        "toString"
    )
      target = unwrapJavaScriptExpression(callee.object).node;
  }
  if (!t.isIdentifier(target) || index.referenceMayHaveChangedAt(site, target))
    return undefined;
  const binding = index.bindingForReferenceAt(target);
  if (binding === undefined || seen.has(binding.bindingId)) return undefined;
  seen.add(binding.bindingId);
  const stable = semanticStableInitializer(binding, bindings);
  if (
    stable === undefined ||
    !semanticTopLevelEffectFollowsCapture(
      stable.node,
      site,
      bindings.parentsByNode,
    )
  )
    return undefined;
  const initializer = stable.node;
  if (initializer === undefined) return undefined;
  const initialized = unwrapJavaScriptExpression(initializer).node;
  if (t.isIdentifier(initialized))
    return urlObjectRequestTarget(initialized, site, bindings, index, seen);
  if (!t.isNewExpression(initialized)) return undefined;
  if (!isUnmodifiedGlobalReference(initialized.callee, bindings, "URL"))
    return undefined;
  if (
    ["URL", "Object"].some((owner) =>
      ["toString", "valueOf"].some((method) =>
        bindings.ambientWrites.covers(["global", owner, "prototype", method]),
      ),
    )
  )
    return undefined;
  const input = stringValue(initialized.arguments[0]);
  if (input === undefined) return undefined;
  if (initialized.arguments.length === 1) {
    try {
      return new URL(input).href;
    } catch {
      return undefined;
    }
  }
  if (initialized.arguments.length !== 2) return undefined;
  const base = stringValue(initialized.arguments[1]);
  if (base === undefined) return undefined;
  try {
    return new URL(input, base).href;
  } catch {
    return undefined;
  }
};

/** Record tRPC procedures, tRPC link URLs and named GraphQL operations. */
export const inspectRpcNode = (node: t.Node, context: FindingContext): void => {
  const rpc = context.rpcScan.inspect(node);
  if (rpc !== undefined)
    addEndpoint(context, { node, kind: "network", ...rpc });
};

/** Resolve deferred Source bodies after their document owners have been seen. */
export function* finishRpcScanSteps(
  context: FindingContext,
): Generator<void, void> {
  for (const rpc of context.rpcScan.finish()) {
    if (rpc !== undefined) addEndpoint(context, { kind: "network", ...rpc });
    yield;
  }
}

export const inspectRouteProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  const key = semanticStaticPropertyName(node.key, node.computed);
  const value = stringValue(node.value);
  if ((key === "path" || key === "route") && value !== undefined)
    addEndpoint(context, {
      node,
      kind: "route",
      value,
      mechanism: `property:${key}`,
    });
};

export const inspectRoleProperty = (
  node: t.ObjectProperty,
  context: FindingContext,
): void => {
  if (semanticStaticPropertyName(node.key, node.computed) !== "preload") return;
  if (context.accumulator.mediaElementPreloads.has(node)) return;
  const path = staticPath(node.value);
  if (path === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.roles,
    key: `role\0preload\0${path}`,
    node,
    value: {
      role: "preload",
      path,
      resolution_context: staticPathResolutionContext(node.value),
      mechanism: "property:preload",
      module_key: null,
      location: range(node),
    },
  });
};

const inspectStorageCall = (
  node: JavaScriptCallLike,
  name: string,
  first: string | undefined,
  context: FindingContext,
): void => {
  const receiverFact = context.openReceiverFacts?.get(node.start ?? -1);
  const storage =
    receiverFact === "local" ||
    receiverFact === "local-indexed-db" ||
    receiverFact === "local-cache-storage"
      ? undefined
      : receiverFact === "indexed-db"
        ? "indexed-db"
        : receiverFact === "cache-storage"
          ? "cache-storage"
          : storageKind(name);
  if (storage === undefined) return;
  addLocatedFinding(context, {
    collection: context.accumulator.storage,
    key: `storage\0${storage}\0${first ?? ""}`,
    node,
    value: {
      kind: storage,
      name: first ?? null,
      mechanism: `call:${name}`,
      module_key: null,
      location: range(node),
    },
  });
};

export const addReference = (
  context: FindingContext,
  input: ReferenceInput,
): void => {
  const specifier = input.specifier ?? null;
  const reference =
    specifier === null
      ? {
          specifier: null,
          expression: sourceSlice(context.source, input.node),
        }
      : { specifier, expression: null };
  addLocatedFinding(context, {
    collection: context.accumulator.references,
    key: `reference\0${input.kind}\0${reference.specifier ?? reference.expression}`,
    node: input.node,
    value: {
      kind: input.kind,
      ...reference,
      module_key: null,
      location: range(input.node),
    },
  });
};

const addEndpoint = (context: FindingContext, input: EndpointInput): void =>
  addLocatedFinding(context, {
    collection: context.accumulator.endpoints,
    key: `endpoint\0${input.kind}\0${input.interpretation ?? "literal"}\0${input.resolution ?? "exact"}\0${input.value}`,
    node: input.node,
    value: {
      kind: input.kind,
      value:
        input.resolution === "partial"
          ? input.value
          : sanitizeEndpointCandidate(input.value),
      mechanism: input.mechanism,
      ...(input.interpretation === undefined
        ? {}
        : { interpretation: input.interpretation }),
      ...(input.resolution === undefined
        ? {}
        : { resolution: input.resolution }),
      module_key: null,
      location: range(input.node),
    },
  });

export const addSourceMapDirectives = (
  source: string,
  comments: readonly t.Comment[],
  accumulator: AnalysisAccumulator,
): void => {
  // Read real comment tokens only; quoted text can contain identical markers.
  // Keep both current/legacy line annotations and minifier block annotations.
  for (const comment of comments) {
    const start = comment.start;
    const end = comment.end;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null
    )
      continue;
    // The parser owns comment boundaries. Exclude only the closing block
    // delimiter; an asterisk elsewhere remains part of the declared URL.
    const commentSource = source.slice(
      start,
      comment.type === "CommentBlock" ? end - 2 : end,
    );
    if (
      !(commentSource.startsWith("//") || commentSource.startsWith("/*")) ||
      !(commentSource[2] === "#" || commentSource[2] === "@")
    )
      continue;
    // Single-class searches avoid regex backtracking over unbounded whitespace
    // or inline URLs, which can exhaust the engine stack on two-byte strings.
    const nameOffset = commentSource.slice(3).search(/\S/u);
    if (nameOffset === -1) continue;
    const nameStart = 3 + nameOffset;
    if (!commentSource.startsWith("sourceMappingURL", nameStart)) continue;
    const nameEnd = nameStart + "sourceMappingURL".length;
    const equalsOffset = commentSource.slice(nameEnd).search(/\S/u);
    if (equalsOffset === -1) continue;
    const equalsStart = nameEnd + equalsOffset;
    if (!commentSource.startsWith("=", equalsStart)) continue;
    const urlOffset = commentSource.slice(equalsStart + 1).search(/\S/u);
    if (urlOffset === -1) continue;
    const declaredStart = equalsStart + 1 + urlOffset;
    const terminator = commentSource.slice(declaredStart).search(/\s/u);
    const declaredEnd =
      terminator === -1 ? commentSource.length : declaredStart + terminator;
    if (declaredEnd === declaredStart) continue;
    const declared = commentSource.slice(declaredStart, declaredEnd);
    const location = rangeForOffsets(source, start, start + declaredEnd);
    addFindingOnce(accumulator, `source-map\0${declared}`, () =>
      accumulator.sourceMaps.push({ declared_url: declared, location }),
    );
  }
};
