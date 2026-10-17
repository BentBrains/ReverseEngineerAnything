import type * as t from "@babel/types";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";

type Initializer =
  JavaScriptSemanticBindingState["referenceInitializers"][number];
type Key = string | null;
export type VertexKey = t.Node | string | object;

export interface ViteCacheAllocation {
  readonly kind: "helper" | "cache" | "container" | "foreign";
  readonly owner?: string;
  readonly node?: t.Node;
  readonly copy?: {
    readonly source: Vertex;
    readonly initializer: Initializer;
  };
  readonly helperResult?: {
    readonly cache: Vertex;
    readonly keys: readonly (string | null | undefined)[];
    readonly unknownFrom: number | undefined;
    readonly read: t.Node;
    readonly family: Vertex;
  };
}

/** a single identity and a finite join of reachable cache owners. */
export interface ViteCacheIdentity {
  readonly allocation: ViteCacheAllocation | null;
  readonly owner: string | null | undefined;
  /** reachable children exclude the allocation itself, including cache roots. */
  readonly children?: string | null | undefined;
}

export interface Vertex {
  readonly key: VertexKey;
  readonly inputs: Input[];
  readonly listeners: Set<Vertex>;
  seed?: ViteCacheIdentity;
  fact?: ViteCacheIdentity;
}

export type Input =
  | {
      readonly kind: "helper-result";
      readonly source: Vertex;
      readonly call: t.CallExpression | t.OptionalCallExpression;
    }
  | {
      readonly kind: "alias" | "family" | "copy-family";
      readonly source: Vertex;
    }
  | {
      readonly kind: "select";
      readonly source: Vertex;
      readonly key: Key;
      readonly read: t.Node;
    };

export interface ViteCacheWrite {
  readonly node: t.Node;
  readonly receiver: t.Node;
  readonly key: Key;
  readonly value?: t.Node;
  readonly propertySource?: t.ObjectExpression;
}

export const FOREIGN: ViteCacheIdentity = {
  allocation: { kind: "foreign" },
  owner: undefined,
};
export const UNKNOWN: ViteCacheIdentity = {
  allocation: null,
  owner: undefined,
};
