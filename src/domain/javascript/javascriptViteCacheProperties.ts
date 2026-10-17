import type { JavaScriptIntrinsicInvocation } from "./javascriptElectronMemberWrites.js";
import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import { traverseJavaScriptAstSteps } from "./javascriptSemanticTraversal.js";
import {
  semanticReadPrecedesWrite,
  semanticWritePrecedesRead,
} from "./javascriptSemanticMutationInitializers.js";
import {
  semanticObjectExpressionDefinesKeySteps,
  semanticObjectPropertyReferencesSteps,
} from "./javascriptSemanticObjectReferences.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import {
  FOREIGN,
  UNKNOWN,
  type ViteCacheAllocation,
  type ViteCacheWrite,
  type Vertex,
  type Input,
} from "./javascriptViteCacheIdentityTypes.js";

type Key = string | null;
export interface ViteCachePropertyGraph {
  readonly vertex: () => Vertex;
  readonly normalize: (node: t.Node) => Vertex;
  readonly project: (
    source: Vertex,
    path: readonly (string | number | null)[],
    read: t.Node,
  ) => Vertex;
  readonly connect: (target: Vertex, input: Input) => void;
  readonly enqueue: (vertex: Vertex) => void;
  readonly objectCall: (node: t.Node) => "create" | "assign" | undefined;
  readonly objectArguments: (
    node: t.CallExpression,
  ) => readonly t.CallExpression["arguments"][number][] | undefined;
  readonly invocation: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => JavaScriptIntrinsicInvocation | undefined;
}

/** shallow property selection and ordered snapshots share one literal owner. */
export class ViteCacheProperties {
  private readonly lateWrites = new Map<
    ViteCacheAllocation,
    Map<Key, Vertex>
  >();
  private readonly slots = new Map<ViteCacheAllocation, Map<Key, Vertex>>();
  private readonly snapshotReads = new Map<
    ViteCacheAllocation,
    Map<string, Map<t.Node, Vertex>>
  >();
  readonly writes = new Map<ViteCacheAllocation, ViteCacheWrite[]>();
  readonly escapes = new Map<ViteCacheAllocation, t.Node[]>();
  private readonly restrictions = new Map<
    ViteCacheAllocation,
    Map<Key, Set<t.Node>>
  >();
  private readonly ordinaryAllocations = new WeakMap<
    ViteCacheAllocation,
    boolean
  >();
  private readonly firstArraySpreads = new WeakMap<t.ArrayExpression, number>();
  constructor(
    private readonly state: JavaScriptSemanticAnalysisState,
    private readonly graph: ViteCachePropertyGraph,
  ) {}

  /** A source assignment is a replacement only when the property can accept it. */
  *retainRestrictionsSteps(): Generator<void> {
    const restrict = (
      allocation: ViteCacheAllocation | null | undefined,
      key: Key,
      node: t.Node,
    ): void => {
      if (allocation === undefined || allocation === null) return;
      const keys =
        this.restrictions.get(allocation) ?? new Map<Key, Set<t.Node>>();
      this.restrictions.set(allocation, keys);
      const nodes = keys.get(key) ?? new Set<t.Node>();
      keys.set(key, nodes);
      nodes.add(node);
    };
    let examined = 0;
    for (const [allocation, writes] of this.writes)
      for (const write of writes) {
        if (examined++ % 1024 === 0) yield;
        if (
          write.propertySource === undefined &&
          (write.key === null || write.key === "__proto__")
        )
          restrict(allocation, null, write.node);
      }
    const calls: {
      node: t.CallExpression | t.OptionalCallExpression;
      invocation: JavaScriptIntrinsicInvocation;
    }[] = [];
    yield* traverseJavaScriptAstSteps(this.state.program, {
      enter: (node) => {
        if (!t.isCallExpression(node) && !t.isOptionalCallExpression(node))
          return;
        const invocation = this.graph.invocation(node);
        if (
          invocation?.kind !== "known" ||
          invocation.path.length !== 3 ||
          invocation.path[0] !== "intrinsic" ||
          (invocation.path[1] !== "Object" && invocation.path[1] !== "Reflect")
        )
          return;
        const method = invocation.path[2];
        if (
          method !== "defineProperty" &&
          method !== "defineProperties" &&
          method !== "freeze" &&
          method !== "seal" &&
          method !== "preventExtensions" &&
          method !== "setPrototypeOf"
        )
          return;
        calls.push({ node, invocation });
      },
    });
    for (const { node, invocation } of calls) {
      if (examined++ % 1024 === 0) yield;
      const method = invocation.path[2];
      const target = invocation.arguments?.[0];
      if (target === undefined || t.isSpreadElement(target)) continue;
      if (
        method === "defineProperty" &&
        (yield* writableDataDescriptorSteps(invocation.arguments?.[2]))
      )
        continue;
      const keyNode = invocation.arguments?.[1];
      const key =
        method === "defineProperty" && keyNode !== undefined
          ? readExactJavaScriptLiteral(keyNode)
          : undefined;
      restrict(
        this.graph.normalize(target).fact?.allocation,
        key?.found && typeof key.value === "string" ? key.value : null,
        node,
      );
    }
  }

  private lateGroup(allocation: ViteCacheAllocation, key: Key): Vertex {
    const groups = this.lateWrites.get(allocation) ?? new Map<Key, Vertex>();
    this.lateWrites.set(allocation, groups);
    let group = groups.get(key);
    if (group === undefined) {
      group = this.graph.vertex();
      groups.set(key, group);
    }
    return group;
  }

  retainLateWrite(
    allocation: ViteCacheAllocation,
    write: ViteCacheWrite,
  ): void {
    const group = this.lateGroup(allocation, write.key);
    if (write.value === undefined) group.seed = UNKNOWN;
    else {
      if (write.propertySource !== undefined) group.seed = UNKNOWN;
      this.graph.connect(group, {
        kind: write.propertySource === undefined ? "alias" : "family",
        source: this.graph.normalize(write.value),
      });
    }
    this.graph.enqueue(group);
  }

  private readonly writeGroups = new Map<
    ViteCacheAllocation,
    Map<
      Key,
      { readonly writes: readonly ViteCacheWrite[]; readonly vertex: Vertex }
    >
  >();

  private *writeGroupsSteps(
    allocation: ViteCacheAllocation,
  ): Generator<
    void,
    Map<
      Key,
      { readonly writes: readonly ViteCacheWrite[]; readonly vertex: Vertex }
    >
  > {
    const previous = this.writeGroups.get(allocation);
    if (previous !== undefined) return previous;
    const groups = new Map<Key, { writes: ViteCacheWrite[]; vertex: Vertex }>();
    this.writeGroups.set(allocation, groups);
    let examined = 0;
    for (const write of this.writes.get(allocation) ?? []) {
      if (examined++ % 1024 === 0) yield;
      let group = groups.get(write.key);
      if (group === undefined) {
        group = { writes: [], vertex: this.graph.vertex() };
        groups.set(write.key, group);
      }
      group.writes.push(write);
      if (write.value === undefined) group.vertex.seed = UNKNOWN;
      else {
        if (write.propertySource !== undefined) group.vertex.seed = UNKNOWN;
        this.graph.connect(group.vertex, {
          kind: write.propertySource === undefined ? "alias" : "family",
          source: this.graph.normalize(write.value),
        });
      }
      this.graph.enqueue(group.vertex);
    }
    return groups;
  }

  *snapshotSteps(
    initial: Vertex,
    allocation: ViteCacheAllocation,
    key: string,
    read: t.Node,
  ): Generator<void, Vertex> {
    const byKey =
      this.snapshotReads.get(allocation) ??
      new Map<string, Map<t.Node, Vertex>>();
    this.snapshotReads.set(allocation, byKey);
    const byRead = byKey.get(key) ?? new Map<t.Node, Vertex>();
    byKey.set(key, byRead);
    const previous = byRead.get(read);
    if (previous !== undefined) return previous;
    const base = this.graph.vertex();
    byRead.set(read, base);
    for (const selection of [key, null])
      this.graph.connect(base, {
        kind: "alias",
        source: this.lateGroup(allocation, selection),
      });
    const groups = yield* this.writeGroupsSteps(allocation);
    const exact = groups.get(key);
    const latest = yield* this.latestWriteSteps(
      [exact?.writes ?? [], groups.get(null)?.writes ?? []],
      allocation,
      key,
      read,
    );
    this.graph.connect(base, {
      kind: "alias",
      source:
        latest?.propertySource !== undefined
          ? this.graph.project(
              this.graph.normalize(latest.propertySource),
              [key],
              latest.node,
            )
          : latest?.value === undefined
            ? initial
            : this.graph.normalize(latest.value),
    });
    for (const group of [exact, groups.get(null)]) {
      if (group === undefined) continue;
      for (let index = 0; index < group.writes.length; index++) {
        if (index % 1024 === 0) yield;
        const write = group.writes[index];
        if (write !== undefined && !this.inertWrite(write, latest, read)) {
          // one shared junction retains uncertain writes for every slot read.
          this.graph.connect(base, { kind: "alias", source: group.vertex });
          break;
        }
      }
    }
    let examined = 0;
    for (const escape of this.escapes.get(allocation) ?? []) {
      if (examined++ % 1024 === 0) yield;
      if (!semanticReadPrecedesWrite(read, escape, this.state.parentsByNode))
        base.seed = { allocation: null, owner: null };
    }
    this.graph.enqueue(base);
    return base;
  }

  private *latestWriteSteps(
    groups: readonly (readonly ViteCacheWrite[])[],
    allocation: ViteCacheAllocation,
    key: string,
    read: t.Node,
  ): Generator<void, ViteCacheWrite | undefined> {
    let latest: ViteCacheWrite | undefined;
    let examined = 0;
    for (const writes of groups)
      for (const write of writes) {
        if (examined++ % 1024 === 0) yield;
        const defines =
          write.propertySource === undefined
            ? write.key === key
            : yield* semanticObjectExpressionDefinesKeySteps(
                write.propertySource,
                key,
              );
        if (
          defines &&
          write.value !== undefined &&
          (yield* this.acceptsReplacementSteps(allocation, key, write)) &&
          semanticWritePrecedesRead(
            write.node,
            read,
            this.state.parentsByNode,
          ) &&
          (latest === undefined ||
            semanticWritePrecedesRead(
              latest.node,
              write.node,
              this.state.parentsByNode,
            ))
        )
          latest = write;
      }
    return latest;
  }

  private *acceptsReplacementSteps(
    allocation: ViteCacheAllocation,
    key: string,
    write: ViteCacheWrite,
  ): Generator<void, boolean> {
    // Descriptor definitions have different success rules and default omitted
    // writable/configurable fields to false. Retain their value as a possible
    // alias, without treating them as successful ordinary assignments.
    if (
      !t.isAssignmentExpression(write.node, { operator: "=" }) &&
      write.propertySource === undefined
    )
      return false;
    if (!(yield* this.ordinaryAllocationSteps(allocation))) return false;
    const receivers = [{ allocation, inherited: false }];
    if (
      t.isCallExpression(allocation.node) &&
      this.graph.objectCall(allocation.node) === "create"
    ) {
      const prototype = this.graph.objectArguments(allocation.node)?.[0];
      if (prototype !== undefined && !t.isSpreadElement(prototype)) {
        const inherited = this.graph.normalize(prototype).fact?.allocation;
        if (inherited != null)
          receivers.push({ allocation: inherited, inherited: true });
      }
    }
    let examined = 0;
    for (const receiver of receivers) {
      const restrictions = this.restrictions.get(receiver.allocation);
      for (const selection of [key, null])
        for (const restriction of restrictions?.get(selection) ?? []) {
          if (examined++ % 1024 === 0) yield;
          if (
            t.isCallExpression(restriction) ||
            t.isOptionalCallExpression(restriction)
          ) {
            const method = this.graph.invocation(restriction)?.path.at(-1);
            if (
              (method === "seal" || method === "preventExtensions") &&
              (receiver.inherited ||
                (t.isObjectExpression(receiver.allocation.node) &&
                  (yield* semanticObjectExpressionDefinesKeySteps(
                    receiver.allocation.node,
                    key,
                  ))))
            )
              continue;
          }
          if (
            !semanticReadPrecedesWrite(
              write.node,
              restriction,
              this.state.parentsByNode,
            )
          )
            return false;
        }
    }

    return true;
  }

  private *ordinaryAllocationSteps(
    allocation: ViteCacheAllocation,
  ): Generator<void, boolean> {
    const previous = this.ordinaryAllocations.get(allocation);
    if (previous !== undefined) return previous;
    let ordinary = true;
    if (allocation.kind === "container" && allocation.copy === undefined) {
      const node = allocation.node;
      ordinary =
        t.isObjectExpression(node) ||
        t.isArrayExpression(node) ||
        allocation.helperResult !== undefined;
      if (
        t.isCallExpression(node) &&
        this.graph.objectCall(node) === "create"
      ) {
        const arguments_ = this.graph.objectArguments(node);
        const prototype = arguments_?.[0];
        ordinary =
          arguments_?.length === 1 &&
          prototype !== undefined &&
          !t.isSpreadElement(prototype) &&
          this.graph.normalize(prototype).fact?.allocation?.kind === "helper";
      }
      if (t.isObjectExpression(node)) {
        let examined = 0;
        for (const property of node.properties) {
          if (examined++ % 1024 === 0) yield;
          if (t.isSpreadElement(property)) continue;
          const key = semanticStaticPropertyKey(
            property.key,
            property.computed,
          );
          if (
            key === null ||
            key === "__proto__" ||
            (t.isObjectMethod(property) && property.kind !== "method")
          ) {
            ordinary = false;
            break;
          }
        }
      }
    }
    this.ordinaryAllocations.set(allocation, ordinary);
    return ordinary;
  }

  private inertWrite(
    write: ViteCacheWrite,
    latest: ViteCacheWrite | undefined,
    read: t.Node,
  ): boolean {
    return (
      write === latest ||
      // Updates and compound assignments read their old LHS value before
      // storing the result. Their own write cannot change that snapshot.
      (t.isUpdateExpression(write.node) && write.node.argument === read) ||
      (t.isAssignmentExpression(write.node) &&
        write.node.operator !== "=" &&
        write.node.left === read) ||
      semanticReadPrecedesWrite(read, write.node, this.state.parentsByNode) ||
      (latest !== undefined &&
        semanticWritePrecedesRead(
          write.node,
          latest.node,
          this.state.parentsByNode,
        ))
    );
  }

  *slotSteps(
    allocation: ViteCacheAllocation,
    key: string,
  ): Generator<void, Vertex> {
    const slots = this.slots.get(allocation) ?? new Map<Key, Vertex>();
    this.slots.set(allocation, slots);
    const previous = slots.get(key);
    if (previous !== undefined) return previous;
    const slot = this.graph.vertex();
    slots.set(key, slot);
    if (allocation.helperResult !== undefined) {
      const mapped = allocation.helperResult;
      const index = semanticArrayIndex(key);
      if (index === null) slot.seed = FOREIGN;
      else {
        const uncertain =
          mapped.unknownFrom !== undefined && index >= mapped.unknownFrom;
        const tableKey = mapped.keys[index];
        if (!uncertain && tableKey === undefined) slot.seed = FOREIGN;
        else if (!uncertain && typeof tableKey === "string")
          this.graph.connect(slot, {
            kind: "select",
            source: mapped.cache,
            key: tableKey,
            read: mapped.read,
          });
        else {
          slot.seed = UNKNOWN;
          this.graph.connect(slot, { kind: "family", source: mapped.family });
        }
      }
      this.graph.enqueue(slot);
      return slot;
    }
    if (allocation.copy !== undefined) {
      this.copySlot(slot, allocation.copy, key);
      this.graph.enqueue(slot);
      return slot;
    }
    const node = allocation.node;
    if (t.isObjectExpression(node)) {
      for (const reference of yield* semanticObjectPropertyReferencesSteps(
        node,
        [key],
        this.state,
      )) {
        const path = reference.path.map((segment) =>
          typeof segment === "object" ? null : segment,
        );
        this.graph.connect(slot, {
          kind: "alias",
          source: this.graph.project(
            this.graph.normalize(reference.node),
            path,
            node,
          ),
        });
      }
    } else if (t.isArrayExpression(node)) {
      yield* this.arraySlotSteps(slot, node, key);
    } else if (t.isCallExpression(node)) {
      yield* this.callSlotSteps(slot, node, key);
    }
    if (slot.inputs.length === 0 && slot.seed === undefined)
      slot.seed = FOREIGN;
    this.graph.enqueue(slot);
    return slot;
  }
  private copySlot(
    slot: Vertex,
    copy: NonNullable<ViteCacheAllocation["copy"]>,
    key: string,
  ): void {
    const initializer = copy.initializer;
    if (
      initializer.copyKind === "object-rest" &&
      !semanticPropertyPathKeyMatches(
        { excludedKeys: initializer.copyExcludedKeys ?? [] },
        key,
      )
    )
      slot.seed = FOREIGN;
    else {
      const selected =
        initializer.copyKind === "array-rest" &&
        semanticArrayIndex(key) !== null
          ? String(Number(key) + (initializer.copyStartIndex ?? 0))
          : key;
      this.graph.connect(slot, {
        kind: "select",
        source: copy.source,
        key: selected,
        read: initializer.node,
      });
    }
  }
  private *arraySlotSteps(
    slot: Vertex,
    node: t.ArrayExpression,
    key: string,
  ): Generator<void> {
    const index = semanticArrayIndex(key);
    if (index === null) return;
    let firstSpread = this.firstArraySpreads.get(node);
    if (firstSpread === undefined) {
      firstSpread = -1;
      for (let cursor = 0; cursor < node.elements.length; cursor++) {
        if (cursor % 1024 === 0) yield;
        if (t.isSpreadElement(node.elements[cursor])) {
          firstSpread = cursor;
          break;
        }
      }
      this.firstArraySpreads.set(node, firstSpread);
    }
    if (firstSpread >= 0 && index >= firstSpread) slot.seed = UNKNOWN;
    else {
      const element = node.elements[index];
      if (element !== null && element !== undefined)
        this.graph.connect(slot, {
          kind: "alias",
          source: this.graph.normalize(element),
        });
    }
  }
  private *callSlotSteps(
    slot: Vertex,
    node: t.CallExpression,
    key: string,
  ): Generator<void> {
    const method = this.graph.objectCall(node);
    const arguments_ =
      method === "create"
        ? (this.graph.objectArguments(node)?.slice(0, 1) ?? [])
        : (this.graph.objectArguments(node) ?? []);
    for (let index = arguments_.length - 1; index >= 0; index--) {
      if (index % 1024 === 0) yield;
      const argument = arguments_[index];
      if (argument === undefined || t.isSpreadElement(argument))
        slot.seed = UNKNOWN;
      else
        this.graph.connect(slot, {
          kind: "select",
          source: this.graph.normalize(argument),
          key,
          read: node,
        });
    }
  }
}

/** Explicit writable data descriptors preserve subsequent ordinary assignment. */
function* writableDataDescriptorSteps(
  node: t.Node | undefined,
): Generator<void, boolean> {
  if (!t.isObjectExpression(node)) return false;
  let writable = false;
  let examined = 0;
  for (const property of node.properties) {
    if (examined++ % 1024 === 0) yield;
    if (!t.isObjectProperty(property)) return false;
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== "value" &&
      key !== "writable" &&
      key !== "enumerable" &&
      key !== "configurable"
    )
      return false;
    if (key === "writable")
      writable = t.isBooleanLiteral(property.value, { value: true });
  }
  return writable;
}

export const viteCacheObjectOperation = (
  node: t.Node,
  invocation: (
    node: t.CallExpression | t.OptionalCallExpression,
  ) => JavaScriptIntrinsicInvocation | undefined,
): "create" | "assign" | undefined => {
  if (!t.isCallExpression(node)) return undefined;
  const parsed = invocation(node);
  if (
    parsed?.kind !== "known" ||
    parsed.path.length !== 3 ||
    parsed.path[0] !== "intrinsic" ||
    parsed.path[1] !== "Object"
  )
    return undefined;
  const key = parsed.path[2];
  return key === "create" || key === "assign" ? key : undefined;
};
