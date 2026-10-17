import com.atxx.jhmcp.*;
import com.google.gson.*;
import io.modelcontextprotocol.kotlin.sdk.server.*;
import io.modelcontextprotocol.kotlin.sdk.types.*;
import jadx.api.*;
import jadx.api.plugins.input.data.ICodeReader;
import jadx.api.plugins.input.data.IMethodRef;
import jadx.api.plugins.input.insns.InsnIndexType;
import jadx.api.plugins.input.insns.Opcode;
import jadx.api.plugins.input.insns.custom.ISwitchPayload;
import jadx.api.plugins.input.data.IFieldRef;
import jadx.core.utils.android.AndroidResourcesMap;
import jadx.core.dex.info.MethodInfo;
import jadx.core.dex.nodes.*;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.stream.Collectors;
import kotlin.Unit;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import kotlinx.io.CoreKt;
import kotlinx.io.JvmCoreKt;
import kotlinx.serialization.json.JsonObject;

/** REA-owned metadata boundary for the unmodified jadx-headless-mcp 0.7.1 JAR. */
class ReaJadxBridge {
  private static final Gson JSON = new Gson();
  private final SessionHolder holder;
  private JadxSession indexedSession;
  private Map<String, List<ClassSnapshot>> classes = Map.of();

  private record MethodSnapshot(String name, String shortId, Map<String, Object> summary) {}
  private record ClassSnapshot(JavaClass node, List<MethodSnapshot> methods, Map<String, Object> summary) {}

  private static final class InputFailure extends IllegalArgumentException {
    final String field;
    InputFailure(String field, String message) { super(message); this.field = field; }
  }

  private ReaJadxBridge(SessionHolder holder) { this.holder = holder; }

  private static CallToolResult text(String value, boolean failed) {
    return new CallToolResult(List.of(new TextContent(value, null, null)), failed, null, null);
  }

  private static CallToolResult json(Object value) { return text(JSON.toJson(value), false); }

  private static String string(JsonObject args, String name) {
    JsonElement value = JsonParser.parseString(args.toString()).getAsJsonObject().get(name);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
      throw new IllegalArgumentException(name + " must be a string");
    return value.getAsString();
  }

  private static int integer(JsonObject args, String name, int fallback) {
    JsonElement value = JsonParser.parseString(args.toString()).getAsJsonObject().get(name);
    if (value == null) return fallback;
    if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException(name + " must be a nonnegative integer");
    try {
      int result = value.getAsBigDecimal().intValueExact();
      if (result < 0) throw new ArithmeticException();
      return result;
    } catch (ArithmeticException error) {
      throw new IllegalArgumentException(name + " must be a nonnegative integer", error);
    }
  }

  private JadxSession session() {
    JadxSession current = holder.current();
    if (current == null) throw new IllegalArgumentException("No APK loaded");
    return current;
  }

  private ClassSnapshot selected(JsonObject args) {
    JadxSession current = session();
    if (indexedSession != current) {
      Map<String, List<ClassSnapshot>> index = new LinkedHashMap<>();
      if (!current.getClasses().isEmpty()) {
        JadxDecompiler decompiler = current.getClasses().get(0).getClassNode().root().getDecompiler();
        // JavaClass.getMethods/getFields/getInnerClasses all load code. Raw nodes do not.
        // Snapshot every identity before code generation can rewrite aliases or members.
        for (JavaClass cls : decompiler.getClassesWithInners()) {
          ClassNode node = cls.getClassNode();
          List<MethodNode> ordered = new ArrayList<>(node.getMethods());
          ordered.sort(Comparator.comparing(MethodNode::getAlias));
          List<MethodSnapshot> methods = ordered.stream().map(method -> {
            String name = method.getAlias();
            String shortId = method.getMethodInfo().getShortId();
            String rawName = method.getMethodInfo().getName();
            if (!shortId.startsWith(rawName + "("))
              throw new IllegalStateException("JADX method ID has no raw-name prefix: " + shortId);
            String descriptor = shortId.substring(rawName.length());
            String signature = name + "(" + method.getArgTypes().stream()
                .map(Object::toString).collect(Collectors.joining(", "))
                + "): " + method.getReturnType().toString();
            return new MethodSnapshot(name, shortId, Map.of(
                "name", name, "signature", signature,
                "dex_descriptor", descriptor,
                "is_constructor", method.isConstructor(), "def_pos", 0));
          }).toList();
          List<Map<String, Object>> fields = node.getFields().stream()
              .sorted(Comparator.comparing(FieldNode::getAlias))
              .map(field -> Map.<String, Object>of("name", field.getAlias(),
                  "type", field.getType().toString(), "def_pos", 0)).toList();
          List<String> inner = node.getInnerClasses().stream().map(ClassNode::getFullName).toList();
          Map<String, Object> summary = Map.of(
              "full_name", cls.getFullName(), "name", cls.getName(),
              "method_count", methods.size(), "field_count", fields.size(),
              "inner_class_count", inner.size(), "inner_classes", inner,
              "methods", methods.stream().map(MethodSnapshot::summary).toList(), "fields", fields);
          index.computeIfAbsent(cls.getFullName(), ignored -> new ArrayList<>())
              .add(new ClassSnapshot(cls, methods, summary));
        }
      }
      classes = Collections.unmodifiableMap(index);
      indexedSession = current;
    }
    String name = string(args, "class_name");
    List<ClassSnapshot> candidates = classes.get(name);
    if (candidates == null) throw new InputFailure("class_name", "Exact class not found: " + name
        + "; use search_android_classes to discover fully qualified names.");
    if (candidates.size() != 1) throw new InputFailure("class_name", "Ambiguous metadata class identity: " + name
        + "; raw identities: " + candidates.stream().map(candidate -> candidate.node().getRawName()).toList());
    return candidates.get(0);
  }

  private List<MethodSnapshot> methods(ClassSnapshot cls, JsonObject args) {
    String name = string(args, "method_name");
    List<MethodSnapshot> result = cls.methods().stream().filter(method -> method.name().equals(name)).toList();
    if (result.isEmpty()) throw new InputFailure("method_name", "Method not found: " + name
        + "; use inspect_android_class to discover available methods.");
    return result;
  }

  private JavaMethod method(ClassSnapshot cls, MethodSnapshot selected) {
    JavaMethod result = cls.node().searchMethodByShortId(selected.shortId());
    if (result == null) throw new IllegalArgumentException("Method identity no longer available: " + selected.shortId());
    return result;
  }

  private JadxSession.SmartCode methodBody(JadxSession current, ClassSnapshot cls,
      MethodSnapshot selected, JavaMethod method) {
    if (!selected.shortId().equals("<clinit>()V"))
      return current.getMethodBodySmart(method, current.getMaxSourceBytes(), true);
    // Java code generation can fold all or part of <clinit> into field declarations.
    // Its method text cannot establish coverage, even when a static block remains.
    JadxSession.MethodSmali smali = current.getMethodSmali(cls.node(), method.getName());
    if (!smali.getFound() || smali.getBlocks().size() != 1)
      throw new IllegalArgumentException("Static initializer disassembly requires one exact method: " + selected.shortId());
    return new JadxSession.SmartCode(
        TextUtilKt.truncateToBytes(smali.getBlocks().get(0), current.getMaxSourceBytes()),
        "smali", true, List.of("static_initializer_disassembly"));
  }

  // The local transport admits 8 MiB frames. Reserve 1 KiB for the fixed
  // JSON-RPC/CallToolResult envelope and generated numeric request id, and
  // account for JSON text being escaped again inside TextContent.
  private static final int MAX_XREF_TEXT_BYTES = 8 * 1024 * 1024 - 1024;
  // A resource scan reaches the client about four times over: raw_result keeps the
  // escaped reply, the normalized result repeats every site, and MCP sends both
  // structured content and text. 2 MiB keeps that frame under the 10 MiB default.
  private static final int MAX_RESOURCE_SCAN_BYTES = 2 * 1024 * 1024;
  private static int escapedJsonBytes(Object value) {
    return JSON.toJson(JSON.toJson(value)).getBytes(StandardCharsets.UTF_8).length;
  }
  private static final class InvokeBudget {
    long remaining;
    InvokeBudget(long remaining) { this.remaining = Math.max(0, remaining); }
    boolean admit(Map<String, Object> site) {
      // Check a conservative two-layer escape bound before serialization.
      long bound = 256;
      for (Object value : site.values())
        if (value instanceof String text) bound += 12L * text.length();
      if (bound > remaining) return false;
      long bytes = escapedJsonBytes(site) - 2L + 1L;
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    }
  }
  private record DirectInvokes(List<Map<String, Object>> sites, boolean exhaustive) {}

  /** Raw DEX invokes within one JADX using method; offsets are code units from its code start. */
  private static DirectInvokes directInvokes(JavaMethod source, MethodInfo target, InvokeBudget budget) {
    MethodNode node = source.getMethodNode();
    ICodeReader code = node.getCodeReader();
    if (code == null) return null;
    List<Map<String, Object>> sites = new ArrayList<>();
    boolean[] exhaustive = {true};
    code.visitInstructions(insn -> {
      insn.decode();
      if (insn.getIndexType() != InsnIndexType.METHOD_REF) return;
      Opcode opcode = insn.getOpcode();
      if (!opcode.name().startsWith("INVOKE_")) return;
      IMethodRef ref = insn.getIndexAsMethod();
      ref.load();
      if (!MethodInfo.fromRef(node.root(), ref).getRawFullId().equals(target.getRawFullId())) return;
      Map<String, Object> site = Map.of(
          "dex_entry", node.getInputFileName(),
          "source_raw_method_id", node.getMethodInfo().getRawFullId(),
          "dex_code_unit_offset", insn.getOffset(),
          "dex_method_index", insn.getIndex(),
          "opcode", opcode.name());
      if (budget.admit(site)) sites.add(site);
      else exhaustive[0] = false;
    });
    return new DirectInvokes(sites, exhaustive[0]);
  }

  private record ResourceRequest(String requested, String pkg, String type, String name,
      boolean framework, List<Integer> ids) {}

  private static Map<String, List<Integer>> byName(Map<Integer, String> names) {
    Map<String, List<Integer>> result = new HashMap<>();
    for (Map.Entry<Integer, String> entry : names.entrySet())
      result.computeIfAbsent(entry.getValue(), ignored -> new ArrayList<>()).add(entry.getKey());
    result.values().forEach(Collections::sort);
    return result;
  }

  private static Map<String, Object> resourceSite(String kind, ClassNode cls, MethodNode method,
      int offset, Opcode opcode) {
    Map<String, Object> site = new LinkedHashMap<>();
    site.put("kind", kind);
    // class_name is the lookup name inspect_android_method accepts; JADX may alias it.
    site.put("class_name", cls.getFullName());
    site.put("raw_class_name", cls.getRawName());
    site.put("top_class", cls.getTopParentClass().getFullName());
    site.put("method_name", method.getAlias());
    site.put("raw_method_id", method.getMethodInfo().getRawFullId());
    site.put("dex_entry", method.getInputFileName());
    site.put("dex_code_unit_offset", offset);
    site.put("opcode", opcode.name());
    return site;
  }

  /**
   * Resolve resource names to integer IDs through the APK resource table, or JADX's bundled
   * framework map for the android package, then scan every method's raw DEX instructions once
   * for constant loads, switch keys, and R-field reads of those resources.
   */
  private CallToolResult resourceReferences(JsonObject args) {
    JadxSession current = session();
    com.google.gson.JsonObject parsed = JsonParser.parseString(args.toString()).getAsJsonObject();
    JsonElement listed = parsed.get("resources");
    if (listed == null || !listed.isJsonArray() || listed.getAsJsonArray().isEmpty())
      throw new IllegalArgumentException("resources must be a non-empty array of strings");
    int maxSites = integer(args, "max_sites", 100);
    RootNode root = current.getClasses().isEmpty() ? null
        : current.getClasses().get(0).getClassNode().root();
    Map<String, List<Integer>> app = root == null ? Map.of()
        : byName(root.getConstValues().getResourcesNames());
    Map<String, List<Integer>> framework = byName(AndroidResourcesMap.getMap());
    List<ResourceRequest> requests = new ArrayList<>();
    for (JsonElement element : listed.getAsJsonArray()) {
      if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString())
        throw new IllegalArgumentException("resources must contain strings");
      String requested = element.getAsString();
      int colon = requested.indexOf(':');
      String pkg = colon < 0 ? null : requested.substring(0, colon);
      String rest = colon < 0 ? requested : requested.substring(colon + 1);
      int slash = rest.indexOf('/');
      if (slash <= 0 || slash == rest.length() - 1)
        throw new IllegalArgumentException("Resource must be [package:]type/name: " + requested);
      String type = rest.substring(0, slash);
      String name = rest.substring(slash + 1);
      boolean isFramework = "android".equals(pkg);
      List<Integer> ids = (isFramework ? framework : app).getOrDefault(type + "/" + name, List.of());
      requests.add(new ResourceRequest(requested, pkg, type, name, isFramework, ids));
    }
    Map<Long, List<Integer>> literals = new HashMap<>();
    Map<String, List<Integer>> fieldReads = new HashMap<>();
    List<List<Map<String, Object>>> sites = new ArrayList<>();
    List<List<Map<String, Object>>> declarations = new ArrayList<>();
    int[] totals = new int[requests.size()];
    int[] fieldTotals = new int[requests.size()];
    for (int index = 0; index < requests.size(); index++) {
      ResourceRequest request = requests.get(index);
      for (int id : request.ids())
        literals.computeIfAbsent((long) id, ignored -> new ArrayList<>()).add(index);
      fieldReads.computeIfAbsent(request.type() + "/" + request.name(), ignored -> new ArrayList<>())
          .add(index);
      sites.add(new ArrayList<>());
      declarations.add(new ArrayList<>());
    }
    int[] scanned = {0};
    List<ClassNode> classNodes = root == null ? List.of() : root.getClasses();
    // Sites and declarations share the transport budget left after the fixed
    // response; matches past it are still counted so coverage stays partial.
    InvokeBudget budget = new InvokeBudget(MAX_RESOURCE_SCAN_BYTES
        - escapedJsonBytes(resourceResponse(requests, maxSites, Integer.MAX_VALUE,
            Integer.MAX_VALUE, Integer.MAX_VALUE, null, null, null, null)));
    for (ClassNode cls : classNodes) {
      String rawName = cls.getRawName();
      int marker = rawName.lastIndexOf(".R$");
      if (marker >= 0) {
        String type = rawName.substring(marker + 3);
        boolean frameworkClass = rawName.equals("android.R$" + type);
        for (FieldNode field : cls.getFields()) {
          String fieldName = field.getFieldInfo().getName();
          List<Integer> matches = fieldReads.get(type + "/" + fieldName);
          if (matches == null) continue;
          for (int index : matches) {
            if (requests.get(index).framework() != frameworkClass) continue;
            fieldTotals[index]++;
            Map<String, Object> declaration = Map.of("class_name", rawName, "field_name", fieldName,
                // JADX synthesizes an app R class from the resource table when the APK lacks one.
                "origin", cls.getClsData() == null ? "jadx_generated" : "dex");
            if (budget.admit(declaration)) declarations.get(index).add(declaration);
          }
        }
      }
      for (MethodNode method : cls.getMethods()) {
        ICodeReader code = method.getCodeReader();
        if (code == null) continue;
        scanned[0]++;
        code.visitInstructions(insn -> {
          insn.decode();
          Opcode opcode = insn.getOpcode();
          Set<Integer> matched = new LinkedHashSet<>();
          String kind = null;
          if (opcode == Opcode.CONST || opcode == Opcode.CONST_WIDE) {
            List<Integer> hit = literals.get(insn.getLiteral());
            if (hit != null) matched.addAll(hit);
            kind = "const_literal";
          } else if (opcode == Opcode.PACKED_SWITCH_PAYLOAD || opcode == Opcode.SPARSE_SWITCH_PAYLOAD) {
            if (insn.getPayload() instanceof ISwitchPayload payload)
              for (int key : payload.getKeys()) {
                List<Integer> hit = literals.get((long) key);
                if (hit != null) matched.addAll(hit);
              }
            kind = "switch_case";
          } else if (insn.getIndexType() == InsnIndexType.FIELD_REF && opcode.name().startsWith("SGET")) {
            IFieldRef field = insn.getIndexAsField();
            String parent = field.getParentClassType();
            int rMarker = parent.lastIndexOf("/R$");
            if (rMarker >= 0 && parent.endsWith(";")) {
              String type = parent.substring(rMarker + 3, parent.length() - 1);
              boolean frameworkParent = parent.equals("Landroid/R$" + type + ";");
              List<Integer> hit = fieldReads.get(type + "/" + field.getName());
              if (hit != null)
                for (int index : hit)
                  if (requests.get(index).framework() == frameworkParent) matched.add(index);
              kind = "r_field_read";
            }
          }
          for (int index : matched) {
            totals[index]++;
            if (sites.get(index).size() >= maxSites) continue;
            Map<String, Object> site = resourceSite(kind, cls, method, insn.getOffset(), opcode);
            if (budget.admit(site)) sites.get(index).add(site);
          }
        });
      }
    }
    return json(resourceResponse(requests, maxSites, classNodes.size(), scanned[0], app.size(),
        totals, fieldTotals, sites, declarations));
  }

  /** Response shape; null lists produce the empty, maximal-count skeleton used for budgeting. */
  private static Map<String, Object> resourceResponse(List<ResourceRequest> requests, int maxSites,
      int classes, int methods, int appNames, int[] totals, int[] fieldTotals,
      List<List<Map<String, Object>>> sites, List<List<Map<String, Object>>> declarations) {
    List<Map<String, Object>> results = new ArrayList<>();
    for (int index = 0; index < requests.size(); index++) {
      ResourceRequest request = requests.get(index);
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("requested", request.requested());
      result.put("package", request.pkg() == null ? "" : request.pkg());
      result.put("type", request.type());
      result.put("name", request.name());
      result.put("table", request.framework() ? "framework" : "app");
      result.put("ids", request.ids());
      result.put("total_r_fields", fieldTotals == null ? Integer.MAX_VALUE : fieldTotals[index]);
      result.put("r_fields", declarations == null ? List.of() : declarations.get(index));
      result.put("total_sites", totals == null ? Integer.MAX_VALUE : totals[index]);
      result.put("sites", sites == null ? List.of() : sites.get(index));
      results.add(result);
    }
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("classes_scanned", classes);
    response.put("methods_scanned", methods);
    response.put("app_resource_names", appNames);
    response.put("max_sites", maxSites);
    response.put("resources", results);
    return response;
  }

  private CallToolResult handle(String name, JsonObject args) {
    if (name.equals("rea_jvm_status")) return json(Map.of(
        "engine_reported_version", BuildInfo.VERSION,
        "max_heap_bytes", Runtime.getRuntime().maxMemory(),
        "available_processors", Runtime.getRuntime().availableProcessors(),
        "java_version", System.getProperty("java.version"),
        "metadata_scope", "parsed_members"));
    if (name.equals("rea_resource_references")) return resourceReferences(args);
    JadxSession current = session();
    if (name.equals("list_classes")) {
      List<String> names = current.getClassFqns();
      int offset = integer(args, "offset", 0);
      int limit = integer(args, "limit", 200);
      int start = Math.min(offset, names.size());
      int end = (int) Math.min((long) start + limit, names.size());
      return json(Map.of("total", names.size(), "offset", offset, "limit", limit,
          "items", names.subList(start, end)));
    }
    ClassSnapshot cls = selected(args);
    if (name.equals("get_class_summary")) return json(cls.summary());
    if (name.equals("get_method_body")) {
      List<MethodSnapshot> overloads = methods(cls, args);
      int index = integer(args, "overload_index", 0);
      if (index >= overloads.size()) throw new InputFailure("overload_index", "overload_index out of range: " + index);
      JavaMethod method = method(cls, overloads.get(index));
      JadxSession.SmartCode code = methodBody(current, cls, overloads.get(index), method);
      return json(Map.of("class_name", cls.summary().get("full_name"),
          "method_name", overloads.get(index).name(), "full_name", method.getFullName(),
          "overload_index", index, "overload_count", overloads.size(),
          "mode", code.getKind(), "fell_back", code.getFellBack(),
          "markers", code.getMarkers(), "body", code.getText()));
    }
    List<JavaNode> uses;
    String target = string(args, "class_name");
    MethodSnapshot selectedMethod = null;
    int overloadIndex = 0;
    if (name.equals("get_xrefs_to_class")) uses = cls.node().getUseIn();
    else {
      List<MethodSnapshot> overloads = methods(cls, args);
      if (overloads.size() != 1 && !args.containsKey("overload_index"))
        throw new InputFailure("overload_index", "Select one of " + overloads.size() + " method overloads");
      overloadIndex = integer(args, "overload_index", 0);
      if (overloadIndex >= overloads.size())
        throw new InputFailure("overload_index", "overload_index out of range: " + overloadIndex);
      selectedMethod = overloads.get(overloadIndex);
      target += "." + selectedMethod.name();
      uses = method(cls, selectedMethod).getUseIn();
    }
    // REA consumes all references without materializing source line information.
    MethodInfo targetInfo = selectedMethod == null ? null : method(cls, selectedMethod).getMethodNode().getMethodInfo();
    List<Map<String, Object>> items = uses.stream().map(node -> {
      Map<String, Object> item = new LinkedHashMap<>(current.describeUsage(node, false));
      if (targetInfo != null && node instanceof JavaMethod) {
        item.put("direct_invokes", List.of());
        item.put("direct_invokes_exhaustive", false);
      }
      return item;
    }).toList();
    Map<String, Object> result = new LinkedHashMap<>(Map.of("target", target,
        "total", uses.size(), "count", items.size(), "resolve_line", false, "items", items));
    if (selectedMethod != null) {
      result.put("overload_index", overloadIndex);
      result.put("reported_signature", selectedMethod.summary().get("signature"));
    }
    if (targetInfo != null) {
      InvokeBudget budget = new InvokeBudget(MAX_XREF_TEXT_BYTES - escapedJsonBytes(result));
      for (int index = 0; index < uses.size(); index++) {
        if (!(uses.get(index) instanceof JavaMethod source)) continue;
        DirectInvokes invokes = directInvokes(source, targetInfo, budget);
        Map<String, Object> item = items.get(index);
        if (invokes == null) {
          item.remove("direct_invokes");
          item.remove("direct_invokes_exhaustive");
        } else {
          item.put("direct_invokes", invokes.sites());
          item.put("direct_invokes_exhaustive", invokes.exhaustive());
        }
      }
    }
    return json(result);
  }

  public static void main(String[] args) throws Exception {
    PrintStream protocolOut = System.out;
    System.setOut(System.err);
    SessionHolder holder = new SessionHolder(new SessionConfig(
        1048576, 0, 90000L, 1, List.of(), List.of(), 64, ResourceMode.FULL));
    ServerCapabilities capabilities = new ServerCapabilities(
        new ServerCapabilities.Tools(null), null, null, null, null, null, null, Map.of());
    Server server = new Server(new Implementation("rea-jadx-bridge", "1", null, null, null),
        new ServerOptions(capabilities), "", ignored -> Unit.INSTANCE);
    SessionToolsKt.registerSessionTools(server, holder);
    ManifestToolsKt.registerManifestTools(server, holder);
    ClassToolsKt.registerClassTools(server, holder);
    MethodToolsKt.registerMethodTools(server, holder);
    XrefToolsKt.registerXrefTools(server, holder);
    ReaJadxBridge bridge = new ReaJadxBridge(holder);
    Set<String> consumed = Set.of("load_apk", "get_app_info", "get_android_manifest",
        "list_classes", "get_class_summary", "get_method_body",
        "get_xrefs_to_class", "get_xrefs_to_method");
    for (String name : new ArrayList<>(server.getTools().keySet()))
      if (!consumed.contains(name)) server.removeTool(name);
    Tool diagnostics = new Tool("rea_jvm_status",
        new ToolSchema(null, new JsonObject(Map.of()), List.of(), null),
        "Observed worker JVM and metadata scope", null, null, null, null, null, null);
    server.addTool(diagnostics, (connection, request, continuation) -> bridge.handle("rea_jvm_status", request.getArguments()));
    Tool resources = new Tool("rea_resource_references",
        new ToolSchema(null, new JsonObject(Map.of()), List.of(), null),
        "Resolve [package:]type/name resources to IDs and list raw DEX constant, switch, and R-field uses",
        null, null, null, null, null, null);
    server.addTool(resources, (connection, request, continuation) -> {
      try { return bridge.handle("rea_resource_references", request.getArguments()); }
      catch (IllegalArgumentException error) { return text(error.getMessage(), true); }
    });
    for (String name : List.of("list_classes", "get_class_summary",
        "get_method_body", "get_xrefs_to_class", "get_xrefs_to_method")) {
      Tool tool = server.getTools().get(name).getTool();
      server.removeTool(name);
      List<String> fields = switch (name) {
        case "list_classes" -> List.of("offset", "limit");
        case "get_method_body" -> List.of("class_name", "method_name", "overload_index");
        case "get_xrefs_to_method" -> List.of("class_name", "method_name", "overload_index");
        default -> List.of("class_name");
      };
      Map<String, kotlinx.serialization.json.JsonElement> properties = new LinkedHashMap<>();
      for (String field : fields) properties.put(field, tool.getInputSchema().getProperties().get(field));
      String description = switch (name) {
        case "list_classes" -> "Indexed pages of all top-level class names, with offset and limit.";
        case "get_class_summary" -> "Parsed member metadata for one exact class name; no source generation.";
        case "get_method_body" -> "Source for an exact class and stable same-name overload index; static initializers use smali to preserve folded field initialization.";
        default -> "Complete static using-node inventory for an exact class or selected method overload; one node may contain multiple invoke instructions, and source lines are unresolved.";
      };
      Tool narrowed = new Tool(name, new ToolSchema(null, new JsonObject(properties),
          tool.getInputSchema().getRequired(), null), description, null, null, null, null, null, null);
      server.addTool(narrowed, (connection, request, continuation) -> {
        try { return bridge.handle(name, request.getArguments()); }
        catch (InputFailure error) { return text(JSON.toJson(Map.of(
            "kind", "invalid-input", "field", error.field, "message", error.getMessage())), true); }
        catch (IllegalArgumentException error) { return text(error.getMessage(), true); }
      });
    }
    CountDownLatch done = new CountDownLatch(1);
    server.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    StdioServerTransport transport = new StdioServerTransport(
        CoreKt.buffered(JvmCoreKt.asSource(System.in)),
        CoreKt.buffered(JvmCoreKt.asSink(protocolOut)));
    transport.onClose(() -> { done.countDown(); return Unit.INSTANCE; });
    ServerSession connection = null;
    try {
      connection = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
          (scope, continuation) -> server.createSession(transport, continuation));
      done.await();
    } finally {
      try {
        if (connection != null) {
          ServerSession connected = connection;
          // Unsubscribe the connection before the SDK joins its notification service.
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> connected.close(continuation));
        }
      } finally {
        try {
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> server.close(continuation));
        } finally {
          BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
              (scope, continuation) -> holder.unload(continuation));
        }
      }
    }
  }
}
