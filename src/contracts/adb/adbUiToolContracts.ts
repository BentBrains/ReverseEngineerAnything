import {
  adbUiInputSchemas,
  adbUiResultSchemas,
} from "../../domain/adb/adbUiAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

const scope = { serial: "emulator-5554", package: "com.example.app" };
export const ADB_UI_TOOL_CONTRACTS = [
  {
    name: "inspect_adb_ui",
    ...toolContractMetadata("inspect_adb_ui"),
    kind: "adb-provider",
    description:
      "Capture the selected Android package's accessibility hierarchy through a caller-started UI Automator runner. Returns windows, snapshot-scoped element IDs, text, descriptions, resource IDs, bounds, states and derived clickable-ancestor links. Password-marked text is excluded. Reports examined coverage and resource limits; custom-drawn and off-screen content may not be exposed. A new capture replaces the runner's previous snapshot.",
    inputSchema: adbUiInputSchemas.inspect_adb_ui,
    outputSchema: evidenceResultOf(adbUiResultSchemas.inspect_adb_ui),
    examples: [{ title: "Inspect an Android app's UI", input: scope }],
  },
  {
    name: "find_adb_ui_elements",
    ...toolContractMetadata("find_adb_ui_elements"),
    kind: "adb-provider",
    description:
      "Find matching Android UI elements by text, content description, resource ID, class, ancestor ID or observed states, with explicit examined coverage. Predicates are conjunctive; empty selector inventories the selected scope. Return candidate IDs and clickable parents instead of choosing the first match. Use snapshot_id and next_offset to page the retained observation; retained pages are labelled rather than reported as current live state.",
    inputSchema: adbUiInputSchemas.find_adb_ui_elements,
    outputSchema: evidenceResultOf(adbUiResultSchemas.find_adb_ui_elements),
    examples: [
      {
        title: "Find Sign in text and its clickable parent",
        input: {
          ...scope,
          selector: { text: { value: "Sign in", match: "exact" } },
        },
      },
      {
        title: "Find enabled clickable controls",
        input: {
          ...scope,
          selector: { clickable: true, enabled: true, visible: true },
        },
      },
    ],
  },
  {
    name: "wait_for_adb_ui",
    ...toolContractMetadata("wait_for_adb_ui"),
    kind: "adb-provider",
    description:
      "Wait within an explicit deadline for matching Android UI elements to appear or disappear. Returns the last observed snapshot, matches and timeout outcome. Absence requires complete examined coverage; UI stability or missing accessibility nodes does not establish application idleness. Uses the operator-owned UI Automator runner and replaces its retained snapshot.",
    inputSchema: adbUiInputSchemas.wait_for_adb_ui,
    outputSchema: evidenceResultOf(adbUiResultSchemas.wait_for_adb_ui),
    examples: [
      {
        title: "Wait for a confirmation label",
        input: {
          ...scope,
          selector: { text: { value: "Saved", match: "exact" } },
          condition: "present",
          timeout_ms: 10000,
        },
      },
    ],
  },
  {
    name: "perform_adb_ui_action",
    ...toolContractMetadata("perform_adb_ui_action"),
    kind: "adb-provider",
    description:
      "Perform one explicit Android UI primitive: tap, double tap, long press, set/clear text, scroll, swipe, drag or key event. Select an element from the retained snapshot; key events select its foreground package. Refresh and validate element facts before dispatch, rejecting stale or disabled targets. Reports dispatch acknowledgement separately from observed after-state. Actions can change app data and network state. Text travels over private stdin transport; caller-marked sensitive text and password-control text are excluded from recorded parameters.",
    inputSchema: adbUiInputSchemas.perform_adb_ui_action,
    outputSchema: evidenceResultOf(adbUiResultSchemas.perform_adb_ui_action),
    examples: [
      {
        title: "Tap a selected UI control",
        input: {
          ...scope,
          snapshot_id: "00000000-0000-4000-8000-000000000001",
          element_id: "3",
          action: { kind: "tap" },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
