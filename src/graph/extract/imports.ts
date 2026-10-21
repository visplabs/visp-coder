import { fileEntityId } from "../ids.js";
import type { Entity, Relation, UnknownRecord } from "../types.js";
import { argumentsOf, field, lineOf, named, stringValue, walkNamed } from "./nodes.js";
import type { ParsedTree, SyntaxNode } from "./parser.js";
import {
  type Resolution,
  type ResolutionContext,
  resolvePythonImport,
  resolveScriptImport,
} from "./resolve.js";
import { UnknownCollector } from "./unknowns.js";

export interface ImportExtraction {
  readonly relations: Relation[];
  readonly unknowns: UnknownRecord[];
  /**
   * Local binding name to where it came from: a repository file path, or an
   * `external:` ref. Binding externals too is what lets call resolution tell
   * "a call into a dependency we know about" apart from "no idea" — the
   * former was 86–97% of every real run's unknown noise.
   */
  readonly bindings: Map<string, string>;
  /** Names this file re-exports, to the file that actually defines them. */
  readonly reexports: Map<string, string>;
  readonly importedFiles: string[];
  readonly importedModules: string[];
}

export function extractImports(
  path: string,
  tree: ParsedTree,
  context: ResolutionContext,
  byName: ReadonlyMap<string, Entity>,
): ImportExtraction {
  const state = new ImportState(path, tree.grammar === "python", context, byName);
  walkNamed(tree.root, (node) => state.visit(node));
  return state.result();
}

class ImportState {
  private readonly relations: Relation[] = [];
  private readonly unknowns = new UnknownCollector();
  readonly bindings = new Map<string, string>();
  readonly reexports = new Map<string, string>();
  private readonly importedFiles = new Set<string>();
  private readonly importedModules = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly python: boolean,
    private readonly context: ResolutionContext,
    private readonly byName: ReadonlyMap<string, Entity>,
  ) {}

  result(): ImportExtraction {
    return {
      relations: this.relations,
      unknowns: this.unknowns.toArray(),
      bindings: this.bindings,
      reexports: this.reexports,
      importedFiles: [...this.importedFiles].sort(),
      importedModules: [...this.importedModules].sort(),
    };
  }

  visit(node: SyntaxNode): boolean {
    if (this.python) return this.visitPython(node);
    return this.visitScript(node);
  }

  private visitScript(node: SyntaxNode): boolean {
    if (node.type === "import_statement") return this.scriptImport(node);
    if (node.type === "export_statement") return this.scriptExport(node);
    if (node.type === "call_expression") return this.scriptCall(node);
    return true;
  }

  private scriptImport(node: SyntaxNode): boolean {
    const source = stringValue(field(node, "source"));
    if (source === undefined) {
      this.unknowns.record("unresolved_import", this.path, node.text.slice(0, 120));
      return false;
    }
    const resolution = this.record(node, source);
    this.bindScript(node, resolution);
    return false;
  }

  private scriptExport(node: SyntaxNode): boolean {
    const sourceNode = field(node, "source");
    if (sourceNode) return this.scriptReexport(node, sourceNode);
    this.exportLocalNames(node);
    return true;
  }

  private scriptReexport(node: SyntaxNode, sourceNode: SyntaxNode): false {
    const source = stringValue(sourceNode);
    if (source === undefined) return false;

    const resolution = this.record(node, source);
    if (resolution.kind !== "file") return false;

    this.push(fileEntityId(resolution.path), "exports", lineOf(node));
    this.recordReexportedNames(node, resolution.path);
    return false;
  }

  private recordReexportedNames(node: SyntaxNode, targetPath: string): void {
    // The names travelling through, so a call bound to this barrel can be
    // chased one hop to the file that actually defines them.
    for (const specifier of node.descendantsOfType("export_specifier")) {
      if (!specifier) continue;
      const exported = field(specifier, "alias")?.text ?? field(specifier, "name")?.text;
      if (exported) this.reexports.set(exported, targetPath);
    }
  }

  private exportLocalNames(node: SyntaxNode): void {
    for (const specifier of node.descendantsOfType("export_specifier")) {
      if (!specifier) continue;
      const name = field(specifier, "name")?.text;
      const entity = name ? this.byName.get(name) : undefined;
      if (entity) this.push(entity.id, "exports", lineOf(specifier));
    }
    for (const child of named(node)) {
      const name = field(child, "name")?.text;
      const entity = name ? this.byName.get(name) : undefined;
      if (entity) this.push(entity.id, "exports", lineOf(child));
    }
  }

  private scriptCall(node: SyntaxNode): boolean {
    const callee = field(node, "function")?.text;
    if (callee !== "import" && callee !== "require") return true;

    const first = argumentsOf(node)[0];
    const source = stringValue(first);
    if (source === undefined) {
      this.unknowns.record("dynamic_import", this.path, node.text.slice(0, 120));
      return true;
    }
    const resolution = this.record(node, source);

    // `const x = require("./y")` binds like an import; without this, every
    // call through a required module was an unresolved_call.
    const target = bindingTarget(resolution);
    const declarator = node.parent;
    if (target !== undefined && declarator?.type === "variable_declarator") {
      const name = field(declarator, "name");
      if (name?.type === "identifier") this.bindings.set(name.text, target);
    }
    return true;
  }

  private visitPython(node: SyntaxNode): boolean {
    if (node.type === "import_statement") return this.pythonImportStatement(node);
    if (node.type === "import_from_statement") {
      const moduleNode = field(node, "module_name");
      const resolution = this.pythonModule(node, moduleNode?.text);
      this.bindPython(node, resolution);
      if (moduleNode) this.pythonSubmodules(node, moduleNode);
      return false;
    }
    return true;
  }

  private pythonImportStatement(node: SyntaxNode): false {
    for (const child of named(node)) {
      const specifier = moduleText(child);
      const resolution = this.pythonModule(node, specifier);
      const target = resolution ? bindingTarget(resolution) : undefined;
      const alias = child.type === "aliased_import" ? field(child, "alias")?.text : undefined;
      const binding = alias ?? specifier?.split(".")[0];
      if (target && binding) this.bindings.set(binding, target);
      if (target && specifier && !alias) this.bindings.set(specifier, target);
    }
    return false;
  }

  /**
   * `from package import name` imports the submodule `package/name.py` when one exists, as
   * Python does: the importer depends on it, and a test written this way tests it. A name that
   * is not a module file adds nothing.
   */
  private pythonSubmodules(node: SyntaxNode, moduleNode: SyntaxNode): void {
    const base = moduleNode.text;
    for (const child of named(node)) {
      // Tree-sitter returns a fresh wrapper per access: the module name is told apart by position.
      if (
        child.startPosition.row === moduleNode.startPosition.row &&
        child.startPosition.column === moduleNode.startPosition.column
      )
        continue;
      const imported = child.type === "aliased_import" ? field(child, "name") : child;
      if (imported?.type !== "dotted_name") continue;
      const specifier = /^\.+$/.test(base) ? `${base}${imported.text}` : `${base}.${imported.text}`;
      const resolution = resolvePythonImport(this.context, this.path, specifier);
      if (resolution.kind !== "file" || this.importedFiles.has(resolution.path)) continue;
      this.importedFiles.add(resolution.path);
      this.push(fileEntityId(resolution.path), "imports", lineOf(node));
      const name = child.type === "aliased_import" ? field(child, "alias")?.text : imported.text;
      if (name) this.bindings.set(name, resolution.path);
    }
  }

  private pythonModule(node: SyntaxNode, specifier: string | undefined): Resolution | undefined {
    if (specifier === undefined || specifier === "") return undefined;
    return this.record(node, specifier);
  }

  private record(node: SyntaxNode, specifier: string): Resolution {
    const resolution = this.python
      ? resolvePythonImport(this.context, this.path, specifier)
      : resolveScriptImport(this.context, this.path, specifier);
    const line = lineOf(node);

    if (resolution.kind === "file") {
      this.importedFiles.add(resolution.path);
      this.push(fileEntityId(resolution.path), "imports", line);
    } else if (resolution.kind === "external") {
      this.importedModules.add(specifier);
      this.push(resolution.ref, "external", line);
    } else {
      this.unknowns.record("unresolved_import", this.path, specifier);
    }
    return resolution;
  }

  private bindScript(node: SyntaxNode, resolution: Resolution): void {
    const target = bindingTarget(resolution);
    if (target === undefined) return;
    for (const type of ["import_specifier", "namespace_import"]) {
      for (const specifier of node.descendantsOfType(type)) {
        if (!specifier) continue;
        const local = field(specifier, "alias")?.text ?? field(specifier, "name")?.text;
        const fallback = local ?? named(specifier)[0]?.text;
        if (fallback) this.bindings.set(fallback, target);
      }
    }
    const clause = named(node).find((child) => child.type === "import_clause");
    const defaultName = clause ? named(clause).find((c) => c.type === "identifier") : undefined;
    if (defaultName) this.bindings.set(defaultName.text, target);
  }

  private bindPython(node: SyntaxNode, resolution: Resolution | undefined): void {
    const target = resolution ? bindingTarget(resolution) : undefined;
    if (target === undefined) return;
    const moduleNode = field(node, "module_name");
    for (const child of named(node)) {
      if (child === moduleNode) continue;
      const name = child.type === "aliased_import" ? field(child, "alias")?.text : child.text;
      // `import *` binds the literal star, which no call site could ever name.
      if (name && name !== "*") this.bindings.set(name, target);
    }
  }

  private push(target: string, kind: Relation["kind"], line: number): void {
    this.relations.push({ source: fileEntityId(this.path), target, kind, path: this.path, line });
  }
}

/** A repository path or an `external:` ref; unresolved imports bind nothing. */
function bindingTarget(resolution: Resolution): string | undefined {
  if (resolution.kind === "file") return resolution.path;
  if (resolution.kind === "external") return resolution.ref;
  return undefined;
}

function moduleText(node: SyntaxNode): string | undefined {
  if (node.type === "dotted_name") return node.text;
  if (node.type === "aliased_import") return field(node, "name")?.text;
  return undefined;
}
