import * as t from "@babel/types";
import { collectElectronWrappedCallPaths } from "./electronWrappedCallPaths.js";
import {
  ELECTRON_IDENTITY_LIMITATION,
  ELECTRON_MODULE,
} from "./javascriptElectronMemberWrites.js";

import {
  completeSemanticSteps,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

import { inspectElectronStaticNode } from "./electronStaticAnalysis.js";
import { finishElectronBrowserWindowsSteps } from "./electronStaticAnalysisBrowser.js";
import {
  detectVendors,
  failedJavaScriptStaticAnalysis,
  registrationKey,
  sortedUnique,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  addReference,
  addSourceMapDirectives,
  finishPartialNetworkEndpoints,
  inspectCall,
  inspectRouteProperty,
  inspectRoleProperty,
  inspectRpcNode,
  finishRpcScanSteps,
} from "./javascriptStaticAnalysisCalls.js";
import {
  inspectBundlerRegistration,
  inspectBundlerBootstrap,
  inspectEsbuildWrapper,
} from "./javascriptStaticAnalysisBundler.js";
import {
  finalizeLocatedFindings,
  finalizeLocatedFindingsSteps,
} from "./javascriptStaticAnalysisFindings.js";
import {
  createJavaScriptAnalysisAccumulator,
  type JavaScriptAnalysisAccumulator as AnalysisAccumulator,
  type JavaScriptFindingContext,
} from "./javascriptStaticAnalysisState.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  indexJavaScriptElectronIdentitySteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import {
  parseJavaScriptSource,
  type ParsedJavaScriptSource,
} from "./javascriptSourceParser.js";

import { createJavaScriptRpcScan } from "./javascriptRpcEndpoints.js";
import { classifyParsedJavaScriptViteDependencySpecifiersSteps } from "./javascriptViteDependencies.js";
import {
  hasUncertainTypeOnlyModuleSideEffect,
  isTypeOnlyExportDeclaration,
  isTypeOnlyImportDeclaration,
  semanticImportEqualsSpecifier,
} from "./javascriptModuleDeclaration.js";

/** Parse one JavaScript artifact and recover static structure only. */
export const analyzeJavaScriptStaticSource = (
  source: string,
): JavaScriptStaticAnalysis => {
  const file = parseJavaScriptSource(source);
  return file === null
    ? failedJavaScriptStaticAnalysis()
    : analyzeParsedJavaScriptStaticSource(source, file);
};

/** Recover static structure from an already parsed JavaScript artifact. */
export const analyzeParsedJavaScriptStaticSource = (
  source: string,
  file: ParsedJavaScriptSource,
): JavaScriptStaticAnalysis =>
  completeSemanticSteps(analyzeParsedJavaScriptStaticSourceSteps(source, file));

/** Static analysis that yields during its source traversal; results are unchanged. */
export function* analyzeParsedJavaScriptStaticSourceSteps(
  source: string,
  file: ParsedJavaScriptSource,
): Generator<void, JavaScriptStaticAnalysis> {
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  // One definitions pass serves receiver classification and binding lookup.
  const index = yield* indexJavaScriptBindingsWithReceiversSteps(file.program);
  const { bindings, receivers } = index;
  yield* index.indexAmbientWritesSteps();
  const electronIdentity = yield* indexJavaScriptElectronIdentitySteps(
    file.program,
    bindings,
  );
  const viteDependencySpecifiers =
    yield* classifyParsedJavaScriptViteDependencySpecifiersSteps(
      file,
      bindings,
    );
  const findings: JavaScriptFindingContext = {
    source,
    accumulator,
    openReceiverFacts: receivers.openReceivers,
    electronBindings: electronIdentity.bindings,
    rpcScan: createJavaScriptRpcScan(source, receivers.rpcClientRoots, index),
  };
  const viteReferencePositions = yield* traverseStaticSourceSteps(
    file,
    findings,
    bindings,
    viteDependencySpecifiers,
  );
  yield* retainViteReferencesSteps(
    findings,
    viteDependencySpecifiers,
    viteReferencePositions,
  );
  yield* finishElectronBrowserWindowsSteps(findings, index);
  if (accumulator.pendingNetworkCalls.length > 0) {
    yield* index.indexMemberMutationFactsSteps();
    finishPartialNetworkEndpoints(findings, bindings, index);
  }
  accumulator.electronCallPaths = collectElectronWrappedCallPaths(
    file.program,
    bindings,
    source,
    accumulator,
    electronIdentity,
  );
  addSourceMapDirectives(source, file.comments ?? [], accumulator);
  const references = yield* finalizeLocatedFindingsSteps(
    accumulator.references,
    accumulator.moduleRangeIndex,
  );
  let hasElectronReference = false;
  for (const [index, { specifier }] of references.entries()) {
    if (index > 0 && index % 1024 === 0) yield;
    if (specifier !== null && ELECTRON_MODULE.test(specifier)) {
      hasElectronReference = true;
      break;
    }
  }
  return finalizeStaticAnalysis(source, file, accumulator, {
    references,
    hasElectronReference,
  });
}

function* traverseStaticSourceSteps(
  file: ParsedJavaScriptSource,
  findings: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
  viteCalls: ReadonlyMap<
    t.CallExpression | t.OptionalCallExpression,
    readonly (string | undefined)[]
  >,
): Generator<
  void,
  ReadonlyMap<t.CallExpression | t.OptionalCallExpression, number>
> {
  const positions = new Map<
    t.CallExpression | t.OptionalCallExpression,
    number
  >();
  yield* traverseJavaScriptAstSteps(file, {
    enter: (node) => {
      findings.accumulator.visitedNodes += 1;
      inspectNode(node, findings, bindings);
      if (
        (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
        viteCalls.has(node)
      )
        positions.set(node, findings.accumulator.references.length);
      return undefined;
    },
  });
  yield* finishRpcScanSteps(findings);
  return positions;
}

/** merge normalized Vite values in batches without changing discovery order. */
function* retainViteReferencesSteps(
  findings: JavaScriptFindingContext,
  calls: ReadonlyMap<
    t.CallExpression | t.OptionalCallExpression,
    readonly (string | undefined)[]
  >,
  positions: ReadonlyMap<t.CallExpression | t.OptionalCallExpression, number>,
): Generator<void> {
  if (calls.size === 0) return;
  const { accumulator } = findings;
  const genericCount = accumulator.references.length;
  const ordered: typeof accumulator.references = [];
  let genericIndex = 0;
  let examined = 0;
  for (const [node, specifiers] of calls) {
    const position = positions.get(node);
    if (examined++ % 1024 === 0) yield;
    if (position === undefined) continue;
    while (genericIndex < position) {
      if (examined++ % 1024 === 0) yield;
      const reference = accumulator.references[genericIndex++];
      if (reference !== undefined) ordered.push(reference);
    }
    for (const specifier of specifiers) {
      if (examined++ % 1024 === 0) yield;
      const before = accumulator.references.length;
      if (specifier === undefined) accumulator.unknownFindings += 1;
      addReference(findings, { node, kind: "dynamic-import", specifier });
      const reference = accumulator.references[before];
      if (reference !== undefined) ordered.push(reference);
    }
  }
  while (genericIndex < genericCount) {
    if (examined++ % 1024 === 0) yield;
    const reference = accumulator.references[genericIndex++];
    if (reference !== undefined) ordered.push(reference);
  }
  for (const [index, reference] of ordered.entries()) {
    if (index % 1024 === 0) yield;
    accumulator.references[index] = reference;
  }
  accumulator.references.length = ordered.length;
}

const finalizeStaticAnalysis = (
  source: string,
  file: ParsedJavaScriptSource,
  accumulator: AnalysisAccumulator,
  referenceFacts: {
    readonly references: JavaScriptStaticAnalysis["references"];
    readonly hasElectronReference: boolean;
  },
): JavaScriptStaticAnalysis => {
  const { references, hasElectronReference } = referenceFacts;
  const parserErrors = file.errors.length;
  const limitations = [
    ...(accumulator.electronCallPaths?.length
      ? [
          "Bundled Electron call paths use static argument and closure substitutions. Conditions, ambient helper overrides, runtime reachability and arbitrary side effects remain unproven.",
        ]
      : []),
    ...(accumulator.electronCallPathLimitReached
      ? [
          "Electron wrapper expansion reached its resource budget (1000000 visits/substitutions or depth 128); additional paths remain unknown.",
        ]
      : []),
    ...(parserErrors === 0
      ? []
      : [
          "The parser recovered from syntax errors; affected facts are partial.",
        ]),
    ...(accumulator.unknownFindings === 0
      ? []
      : [
          "One or more static keys, expressions, or Electron boundary values were dynamic and remain unknown.",
        ]),
    ...(hasUncertainTypeOnlyModuleSideEffect(file.program)
      ? [
          "Compiler options are unavailable; inline type-only imports or re-exports may preserve a module side-effect dependency.",
        ]
      : []),
    ...(hasElectronReference ? [ELECTRON_IDENTITY_LIMITATION] : []),
    "JavaScript syntax was parsed as data and was never evaluated.",
  ];
  return {
    parse_status:
      parserErrors > 0 || accumulator.unknownFindings > 0
        ? "partial"
        : "complete",
    parse_error_count: parserErrors,
    visited_ast_nodes: accumulator.visitedNodes,
    references,
    endpoints: finalizeLocatedFindings(
      accumulator.endpoints,
      accumulator.moduleRangeIndex,
    ),
    storage: finalizeLocatedFindings(
      accumulator.storage,
      accumulator.moduleRangeIndex,
    ),
    bundler_registrations: sortedUnique(
      accumulator.registrations,
      registrationKey,
    ),
    role_paths: finalizeLocatedFindings(
      accumulator.roles,
      accumulator.moduleRangeIndex,
    ),
    source_map_urls: accumulator.sourceMaps,
    vendors: detectVendors(source),
    electron: {
      ...(accumulator.electronCallPaths?.length
        ? { call_paths: accumulator.electronCallPaths }
        : {}),
      browser_windows: finalizeLocatedFindings(
        accumulator.browserWindows,
        accumulator.moduleRangeIndex,
      ),
      context_bridge_apis: finalizeLocatedFindings(
        accumulator.contextBridgeApis,
        accumulator.moduleRangeIndex,
      ),
      ipc: finalizeLocatedFindings(
        accumulator.ipc,
        accumulator.moduleRangeIndex,
      ),
      sender_validations: finalizeLocatedFindings(
        accumulator.senderValidations,
        accumulator.moduleRangeIndex,
      ),
      utility_processes: finalizeLocatedFindings(
        accumulator.utilityProcesses,
        accumulator.moduleRangeIndex,
      ),
      native_addon_bindings: finalizeLocatedFindings(
        accumulator.nativeAddonBindings,
        accumulator.moduleRangeIndex,
      ),
    },
    limitations,
  };
};

const inspectNode = (
  node: t.Node,
  findings: JavaScriptFindingContext,
  bindings: JavaScriptSemanticAnalysisState,
): void => {
  const { source, accumulator } = findings;
  inspectElectronStaticNode(node, findings);
  if (t.isCallExpression(node)) {
    inspectBundlerBootstrap(source, node, accumulator, bindings);
    inspectBundlerRegistration(source, node, accumulator, bindings);
    inspectEsbuildWrapper(source, node, accumulator, bindings);
    inspectCall(node, findings, bindings);
  } else if (t.isOptionalCallExpression(node)) {
    inspectCall(node, findings, bindings);
  } else if (t.isNewExpression(node)) inspectCall(node, findings, bindings);
  if (t.isTSImportEqualsDeclaration(node)) {
    const specifier = semanticImportEqualsSpecifier(node);
    if (specifier !== null)
      addReference(findings, { node, kind: "require", specifier });
  } else if (
    (t.isImportDeclaration(node) || t.isExportAllDeclaration(node)) &&
    node.source !== undefined &&
    !(t.isImportDeclaration(node) && isTypeOnlyImportDeclaration(node)) &&
    !(t.isExportAllDeclaration(node) && isTypeOnlyExportDeclaration(node))
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (
    t.isExportNamedDeclaration(node) &&
    node.source != null &&
    !isTypeOnlyExportDeclaration(node)
  )
    addReference(findings, {
      node,
      kind: "static-import",
      specifier: node.source.value,
    });
  else if (t.isImportExpression(node))
    addReference(findings, {
      node,
      kind: "dynamic-import",
      specifier: stringValue(node.source),
    });
  if (t.isObjectProperty(node)) {
    inspectRouteProperty(node, findings);
    inspectRoleProperty(node, findings);
  }
  inspectRpcNode(node, findings);
};
