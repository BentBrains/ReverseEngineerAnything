import { expect, it } from "vitest";

import {
  analyzeJadxRequest,
  type JadxToolPort,
} from "../../../src/android/JadxAnalysis.js";
import {
  androidInputSchemas,
  androidResultSchemas,
} from "../../../src/domain/android/androidAnalysis.js";

const summary = {
  full_name: "fixture.Target",
  name: "Target",
  method_count: 2,
  field_count: 0,
  inner_class_count: 0,
  methods: [
    {
      name: "choose",
      signature: "choose(String): void",
      dex_descriptor: "(Ljava/lang/String;)V",
      is_constructor: false,
      def_pos: 0,
    },
    {
      name: "choose",
      signature: "choose(int): void",
      dex_descriptor: "(I)V",
      is_constructor: false,
      def_pos: 0,
    },
  ],
  fields: [],
  inner_classes: [],
};

const engine = {
  name: "jadx",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};

it("requires explicit direct invoke coverage state in result evidence", () => {
  const result = {
    engine,
    class_name: "fixture.Target",
    method_name: null,
    overload_index: null,
    reported_signature: null,
    dex_descriptor: null,
    total: 1,
    references: [
      {
        kind: "method",
        name: "caller",
        reported_full_name: "fixture.Other.caller",
        containing_class: "fixture.Other",
        top_class: "fixture.Other",
        source_line: null,
        dex_offset: null,
        direct_invokes: null,
      },
    ],
    coverage: "complete",
    reference_unit: "using_node",
  };
  expect(
    androidResultSchemas.trace_android_references.safeParse(result).success,
  ).toBe(false);
  expect(
    androidResultSchemas.trace_android_references.safeParse({
      ...result,
      references: [
        { ...result.references[0], direct_invokes_exhaustive: null },
      ],
    }).success,
  ).toBe(true);
});

it("publishes exact DEX prototypes instead of discarding bridge metadata", async () => {
  const tools: JadxToolPort = {
    json: () => Promise.resolve(summary),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const result = await analyzeJadxRequest(
    tools,
    {
      operation: "inspect_android_class",
      input: androidInputSchemas.inspect_android_class.parse({
        path: "/fixture.apk",
        class_name: "fixture.Target",
      }),
    },
    {} as never,
    engine,
  );
  expect(result).toMatchObject({
    methods: [
      { name: "choose", dex_descriptor: "(Ljava/lang/String;)V" },
      { name: "choose", dex_descriptor: "(I)V" },
    ],
  });
});

it("traces only the selected overloaded method and checks the producer identity", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools: JadxToolPort = {
    json: (name, input) => {
      calls.push({ name, ...input });
      if (name === "get_class_summary") return Promise.resolve(summary);
      return Promise.resolve({
        target: "fixture.Target.choose",
        overload_index: 1,
        reported_signature: "choose(int): void",
        total: 1,
        count: 1,
        resolve_line: false,
        items: [
          {
            kind: "method",
            name: "caller",
            full_name: "fixture.Other.caller",
            containing_class: "fixture.Other",
            top_class: "fixture.Other",
            def_pos: 0,
            direct_invokes: [
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 0,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 3,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
            ],
          },
        ],
      });
    },
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const request = {
    operation: "trace_android_references",
    input: androidInputSchemas.trace_android_references.parse({
      path: "/fixture.apk",
      class_name: "fixture.Target",
      method_name: "choose",
      overload_index: 1,
    }),
  } as const;
  const result = await analyzeJadxRequest(tools, request, {} as never, engine);
  expect(result).toMatchObject({
    method_name: "choose",
    overload_index: 1,
    reported_signature: "choose(int): void",
    dex_descriptor: "(I)V",
    total: 1,
    reference_unit: "using_node",
    references: [
      {
        direct_invokes: [
          { dex_code_unit_offset: 0 },
          { dex_code_unit_offset: 3 },
        ],
      },
    ],
  });
  expect(calls[1]).toMatchObject({
    name: "get_xrefs_to_method",
    overload_index: 1,
  });
});

it("rejects an ambiguous method and a producer response for a different overload", async () => {
  const xrefs = {
    target: "fixture.Target.choose",
    overload_index: 0,
    reported_signature: "choose(String): void",
    total: 0,
    count: 0,
    resolve_line: false,
    items: [],
  };
  const tools: JadxToolPort = {
    json: (name) =>
      Promise.resolve(name === "get_class_summary" ? summary : xrefs),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const input = {
    path: "/fixture.apk",
    class_name: "fixture.Target",
    method_name: "choose",
  };
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input,
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisInputError",
  });
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input: { ...input, overload_index: 1 },
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
  });
});

const invokeSite = {
  dex_entry: "classes.dex",
  source_raw_method_id: "fixture.Other.caller()V",
  dex_code_unit_offset: 0,
  dex_method_index: 1,
  opcode: "INVOKE_STATIC",
};
const traceWithReference = (fields: Record<string, unknown>) =>
  analyzeJadxRequest(
    {
      json: (name) =>
        Promise.resolve(
          name === "get_class_summary"
            ? summary
            : {
                target: "fixture.Target.choose",
                overload_index: 0,
                reported_signature: "choose(String): void",
                total: 1,
                count: 1,
                resolve_line: false,
                items: [
                  {
                    kind: "method",
                    name: "caller",
                    full_name: "fixture.Other.caller",
                    containing_class: "fixture.Other",
                    top_class: "fixture.Other",
                    def_pos: 0,
                    ...fields,
                  },
                ],
              },
        ),
      text: () => Promise.reject(new Error("unexpected text call")),
    },
    {
      operation: "trace_android_references",
      input: {
        path: "/fixture.apk",
        class_name: "fixture.Target",
        method_name: "choose",
        overload_index: 0,
      },
    },
    {} as never,
    engine,
  );

it.each([
  [{}, null],
  [{ direct_invokes: [] }, []],
])(
  "preserves unavailable versus observed-empty invoke sites: %j",
  async (fields, expected) => {
    const result = await traceWithReference(fields as Record<string, unknown>);
    expect(result).toMatchObject({
      references: [
        { direct_invokes: expected, direct_invokes_exhaustive: null },
      ],
    });
  },
);

it.each([
  { ...invokeSite, dex_code_unit_offset: -1 },
  {
    dex_entry: "classes.dex",
    source_raw_method_id: "fixture.Other.caller()V",
    dex_code_unit_offset: 0,
    dex_method_index: 1,
  },
])("rejects malformed direct invoke producer evidence: %j", async (site) => {
  await expect(
    traceWithReference({ direct_invokes: [site] }),
  ).rejects.toThrow();
});

it("preserves bounded instruction coverage separately from using-node coverage", async () => {
  const result = await traceWithReference({
    direct_invokes: [invokeSite],
    direct_invokes_exhaustive: false,
  });
  expect(result).toMatchObject({
    coverage: "complete",
    reference_unit: "using_node",
    references: [
      { direct_invokes: [invokeSite], direct_invokes_exhaustive: false },
    ],
  });
});

it.each([
  "not-a-dex-descriptor",
  "(Lbad(name;)V",
  "(Lbad)name;)V",
  "()Lbad(name;",
  "()Lbad)name;",
])(
  "rejects malformed DEX prototype %s at the adapter boundary",
  async (descriptor) => {
    const invalidSummary = {
      ...summary,
      methods: summary.methods.map((method) => ({
        ...method,
        dex_descriptor: descriptor,
      })),
    };
    await expect(
      analyzeJadxRequest(
        {
          json: () => Promise.resolve(invalidSummary),
          text: () => Promise.reject(new Error("unexpected text call")),
        },
        {
          operation: "inspect_android_class",
          input: { path: "/fixture.apk", class_name: "fixture.Target" },
        },
        {} as never,
        engine,
      ),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      cause: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["methods", 0, "dex_descriptor"],
          }),
        ]),
      },
    });
  },
);

const fixtureApp = {
  package: "fixture",
  version_name: "1",
  version_code: "1",
  min_sdk: "26",
  target_sdk: "33",
  permissions: [],
};

it("maps UI resource ids to unsigned IDs and bounded code sites", async () => {
  const calls: unknown[] = [];
  const site = {
    kind: "const_literal",
    class_name: "fixture.Home",
    raw_class_name: "fixture.Home",
    top_class: "fixture.Home",
    method_name: "initSearch",
    raw_method_id: "Lfixture/Home;->initSearch()V",
    dex_entry: "classes.dex",
    dex_code_unit_offset: 4,
    opcode: "CONST",
  };
  const scan = {
    classes_scanned: 3,
    methods_scanned: 9,
    app_resource_names: 2,
    max_sites: 1,
    resources: [
      {
        requested: "fixture:id/search",
        package: "fixture",
        type: "id",
        name: "search",
        table: "app",
        ids: [0x7f0c0523],
        total_r_fields: 1,
        r_fields: [
          {
            class_name: "fixture.R$id",
            field_name: "search",
            origin: "jadx_generated",
          },
        ],
        total_sites: 2,
        sites: [site],
      },
      {
        requested: "android:id/title",
        package: "android",
        type: "id",
        name: "title",
        table: "framework",
        ids: [0x01020016],
        total_r_fields: 1,
        r_fields: [],
        total_sites: 0,
        sites: [],
      },
      {
        requested: "other.app:id/search",
        package: "other.app",
        type: "id",
        name: "search",
        table: "app",
        ids: [0x7f0c0523],
        total_r_fields: 1,
        r_fields: [],
        total_sites: 2,
        sites: [site],
      },
      {
        requested: "id/missing",
        package: "",
        type: "id",
        name: "missing",
        table: "app",
        ids: [],
        total_r_fields: 0,
        r_fields: [],
        total_sites: 0,
        sites: [],
      },
    ],
  };
  const tools: JadxToolPort = {
    json: (name, input) => {
      calls.push([name, input]);
      return Promise.resolve(name === "get_app_info" ? fixtureApp : scan);
    },
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const request = {
    operation: "trace_android_resource_references" as const,
    input: androidInputSchemas.trace_android_resource_references.parse({
      path: "/fixture.apk",
      resource_ids: [
        "fixture:id/search",
        "android:id/title",
        "other.app:id/search",
        "id/missing",
      ],
      max_sites_per_resource: 1,
    }),
  };
  const result = await analyzeJadxRequest(tools, request, {} as never, engine);
  expect(calls).toEqual([
    [
      "rea_resource_references",
      {
        resources: [
          "fixture:id/search",
          "android:id/title",
          "other.app:id/search",
          "id/missing",
        ],
        max_sites: 1,
      },
    ],
    ["get_app_info", {}],
  ]);
  expect(result).toMatchObject({
    scan_unit: "dex_instruction",
    resources: [
      {
        package_name: "fixture",
        resolution: "resolved",
        ids: ["0x7f0c0523"],
        total_sites: 2,
        coverage: "partial",
        sites: [site],
      },
      // A declaration dropped by the transport budget still makes coverage partial.
      { table: "framework", ids: ["0x01020016"], coverage: "partial" },
      // Another app's qualifier never borrows this APK's code sites.
      {
        package_name: "other.app",
        resolution: "unresolved",
        ids: [],
        total_sites: 0,
        sites: [],
      },
      { package_name: null, resolution: "unresolved", ids: [] },
    ],
  });

  // A producer answering another request is not attributed to the caller.
  await expect(
    analyzeJadxRequest(
      {
        json: () =>
          Promise.resolve({
            ...scan,
            resources: [...scan.resources].reverse(),
          }),
        text: () => Promise.reject(new Error("unexpected text call")),
      },
      request,
      {} as never,
      engine,
    ),
  ).rejects.toThrow("another request");
});

it("admits uiautomator resource-id spellings only", () => {
  const schema = androidInputSchemas.trace_android_resource_references;
  for (const resource of [
    "com.example.app:id/login",
    "android:id/title",
    "id/login",
  ])
    expect(
      schema.safeParse({ path: "/a.apk", resource_ids: [resource] }).success,
      resource,
    ).toBe(true);
  for (const resource of ["login", "com.example:/login", "id/", ":id/x"])
    expect(
      schema.safeParse({ path: "/a.apk", resource_ids: [resource] }).success,
      resource,
    ).toBe(false);
});
