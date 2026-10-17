import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  semanticWriteTargets,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import {
  isUnshadowedGlobal,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { isUnmodifiedGlobalReference } from "./javascriptSemanticAmbientWrites.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import { semanticPropertyPathKeyMatches } from "./javascriptSemanticPropertyPaths.js";

export type CommonJsExportReceiverEffect =
  | "connected"
  | "detached"
  | "uncertain";

/** A CommonJS export assignment or `Object.defineProperty` export call. */
export type CommonJsExportSite = t.AssignmentExpression | t.CallExpression;

const isCommonJsModuleExports = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): boolean =>
  (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) &&
  isUnshadowedGlobal(node.object, state, "module") &&
  semanticStaticPropertyKey(node.property, node.computed) === "exports";

/** One syntax owner for CJS export names and their receiver identities. */
export const commonJsExportName = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): string | undefined => {
  if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node))
    return undefined;
  const key = semanticStaticPropertyKey(node.property, node.computed);
  if (
    isUnshadowedGlobal(node.object, state, "exports") ||
    isCommonJsModuleExports(node.object, state)
  )
    return key === null ? "*" : key;
  return isCommonJsModuleExports(node, state) ? "default" : undefined;
};

/**
 * `Object.defineProperty(exports, key, descriptor)`, as tsc and Babel emit
 * for CommonJS re-exports, defines the same export as an assignment.
 */
export const commonJsDefinedExport = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly exportedName: string;
      readonly receiver: t.Node;
      readonly descriptor: t.Node;
    }
  | undefined => {
  if (!t.isCallExpression(node)) return undefined;
  const [target, key, descriptor] = node.arguments;
  if (
    target === undefined ||
    key === undefined ||
    descriptor === undefined ||
    t.isSpreadElement(target) ||
    t.isSpreadElement(key) ||
    t.isSpreadElement(descriptor) ||
    t.isArgumentPlaceholder(target) ||
    t.isArgumentPlaceholder(key) ||
    t.isArgumentPlaceholder(descriptor)
  )
    return undefined;
  const receiver = unwrapJavaScriptExpression(target).node;
  if (
    (!isUnshadowedGlobal(receiver, state, "exports") &&
      !isCommonJsModuleExports(receiver, state)) ||
    !isUnmodifiedGlobalReference(node.callee, state, [
      "Object",
      "defineProperty",
    ])
  )
    return undefined;
  return {
    exportedName: semanticStaticPropertyKey(key, true) ?? "*",
    receiver,
    descriptor,
  };
};

type Identity = t.Node | null;
type Execution = "ordered" | "conditional" | "deferred";

/** Pattern evaluation follows the RHS, unlike Babel's child visit order. */
const hasDestructuringEvaluationOrder = (node: t.Node): boolean => {
  const pattern = t.isAssignmentExpression(node)
    ? unwrapJavaScriptExpression(node.left).node
    : t.isVariableDeclarator(node)
      ? node.id
      : undefined;
  return t.isObjectPattern(pattern) || t.isArrayPattern(pattern);
};

/**
 * Capture receivers before their RHS, then compare with the final public
 * identity. Fresh allocations prove distinctness; explicit wrapper reads
 * preserve even opaque identities. Branches and deferred execution remain
 * uncertain, as do local aliases. Facts live for one analysis and the
 * cooperative traversal bounds work to the source tree size.
 */
export function* indexCommonJsExportReceiversSteps(
  state: JavaScriptSemanticAnalysisState,
): Generator<
  void,
  ReadonlyMap<CommonJsExportSite, CommonJsExportReceiverEffect>
> {
  const initial = state.program;
  let publicIdentity: Identity = initial;
  let exportsIdentity: Identity = initial;
  let moduleIntact = true;
  let deferredReplacement = false;
  const fresh = new WeakSet<t.Node>([initial]);
  const values = new WeakMap<t.Node, Identity>();
  const captures = new Map<CommonJsExportSite, Identity>();
  const execution: Execution[] = [];
  const publicCallWrites = new WeakSet<t.Node>();
  // Consume the shared write owner's resolved aliases, intrinsic invocation
  // and keyed mutator facts instead of reinterpreting call names here.
  for (const { node, path } of state.ambientWriteEffects) {
    if (
      (t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
      path[0] === "commonjs-module" &&
      path.length <= 2 &&
      (path.length === 1 ||
        semanticPropertyPathKeyMatches(path[1] ?? null, "exports"))
    )
      publicCallWrites.add(node);
  }
  const valueOf = (node: t.Node): Identity => {
    const value = unwrapJavaScriptExpression(node).node;
    // An opaque result may alias another object, but reading the current
    // module.exports and explicitly reconnecting exports preserves that result.
    return values.has(value) ? (values.get(value) ?? null) : value;
  };

  const write = (target: t.Node, identity: Identity, mode: Execution): void => {
    target = unwrapJavaScriptExpression(target).node;
    const possiblePublicWrite =
      (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) &&
      isUnshadowedGlobal(target.object, state, "module") &&
      semanticStaticPropertyKey(target.property, target.computed) === null;
    const publicWrite =
      isCommonJsModuleExports(target, state) || possiblePublicWrite;
    const exportsWrite = isUnshadowedGlobal(target, state, "exports");
    const moduleWrite = isUnshadowedGlobal(target, state, "module");
    if (!publicWrite && !exportsWrite && !moduleWrite) return;
    if (mode === "deferred") {
      // A source offset cannot order an invocation against module completion.
      deferredReplacement = true;
      return;
    }
    const selected =
      mode === "ordered" && !possiblePublicWrite ? identity : null;
    if (moduleWrite) moduleIntact = false;
    if (publicWrite || moduleWrite)
      publicIdentity = moduleIntact ? selected : null;
    if (exportsWrite) exportsIdentity = selected;
  };

  yield* traverseJavaScriptAstSteps(state.program, {
    enter: (node, parent) => {
      const outer = execution.at(-1) ?? "ordered";
      const mode: Execution =
        outer === "deferred" || t.isFunction(node) || t.isClass(node)
          ? "deferred"
          : outer === "conditional" ||
              // Mark the whole operation: a later tree-visited RHS must not
              // restore certainty after an earlier tree-visited pattern write.
              hasDestructuringEvaluationOrder(node) ||
              t.isIfStatement(node) ||
              t.isSwitchStatement(node) ||
              t.isLoop(node) ||
              t.isTryStatement(node) ||
              t.isObjectPattern(node) ||
              t.isArrayPattern(node) ||
              (t.isLogicalExpression(parent) && parent.right === node) ||
              (t.isAssignmentPattern(parent) && parent.right === node) ||
              (t.isAssignmentExpression(parent) &&
                ["&&=", "||=", "??="].includes(parent.operator) &&
                parent.right === node) ||
              t.isOptionalCallExpression(parent) ||
              (t.isOptionalMemberExpression(parent) &&
                parent.property === node) ||
              (t.isConditionalExpression(parent) && parent.test !== node)
            ? "conditional"
            : "ordered";
      execution.push(mode);
      if (
        t.isAssignmentExpression(node) &&
        commonJsExportName(node.left, state) !== undefined &&
        !isCommonJsModuleExports(node.left, state)
      ) {
        const receiver =
          t.isMemberExpression(node.left) ||
          t.isOptionalMemberExpression(node.left)
            ? node.left.object
            : null;
        captures.set(
          node,
          mode !== "ordered"
            ? null
            : receiver !== null &&
                isUnshadowedGlobal(receiver, state, "exports")
              ? exportsIdentity
              : publicIdentity,
        );
      }
      const defined = commonJsDefinedExport(node, state);
      if (defined !== undefined && t.isCallExpression(node))
        captures.set(
          node,
          mode !== "ordered"
            ? null
            : isUnshadowedGlobal(defined.receiver, state, "exports")
              ? exportsIdentity
              : publicIdentity,
        );
    },
    exit: (node) => {
      const mode = execution.pop() ?? "conditional";
      if (publicCallWrites.has(node)) {
        if (mode === "deferred") deferredReplacement = true;
        else publicIdentity = null;
      }
      if (t.isAssignmentExpression(node)) {
        const left = unwrapJavaScriptExpression(node.left).node;
        const identity =
          node.operator === "=" &&
          (t.isIdentifier(left) ||
            t.isMemberExpression(left) ||
            t.isOptionalMemberExpression(left))
            ? valueOf(node.right)
            : null;
        for (const target of semanticWriteTargets(node.left))
          write(target, identity, mode);
        values.set(node, identity);
      } else if (t.isVariableDeclarator(node) && node.init != null) {
        for (const target of semanticWriteTargets(node.id))
          write(
            target,
            t.isIdentifier(node.id) ? valueOf(node.init) : null,
            mode,
          );
      } else if (t.isForOfStatement(node) || t.isForInStatement(node)) {
        if (!t.isVariableDeclaration(node.left))
          for (const target of semanticWriteTargets(node.left))
            write(target, null, mode);
      } else if (
        t.isUpdateExpression(node) ||
        t.isUnaryExpression(node, { operator: "delete" })
      ) {
        write(node.argument, null, mode);
      } else if (isUnshadowedGlobal(node, state, "exports")) {
        values.set(node, exportsIdentity);
      } else if (isCommonJsModuleExports(node, state)) {
        values.set(node, publicIdentity);
      } else if (
        t.isObjectExpression(node) ||
        t.isArrayExpression(node) ||
        t.isFunctionExpression(node) ||
        t.isArrowFunctionExpression(node) ||
        t.isClassExpression(node)
      ) {
        values.set(node, node);
        fresh.add(node);
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        values.set(node, last === undefined ? null : valueOf(last));
      }
    },
  });
  const effects = new Map<CommonJsExportSite, CommonJsExportReceiverEffect>();
  for (const [node, receiver] of captures) {
    effects.set(
      node,
      deferredReplacement || receiver === null || publicIdentity === null
        ? "uncertain"
        : receiver === publicIdentity
          ? "connected"
          : fresh.has(receiver) && fresh.has(publicIdentity)
            ? "detached"
            : "uncertain",
    );
  }
  return effects;
}
