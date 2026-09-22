import ts from "typescript";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { findConfigFile, loadConfig } from "../../config/load.ts";
import { ConfigSchema, type Config } from "../../types.ts";
import { canonical } from "../../lib/canonical.ts";

export const revisionOf = (source: string) => createHash("sha256").update(source).digest("hex");
const unsupported =
  "This configuration is computed in code. Edit the file directly; the dashboard can safely update exported object literals and const objects.";
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
function configObject(source: ts.SourceFile): ts.ObjectLiteralExpression {
  const exported = source.statements.find(
    (n): n is ts.ExportAssignment => ts.isExportAssignment(n) && !n.isExportEquals,
  );
  if (!exported) throw new Error(unsupported);
  let expression = unwrap(exported.expression);
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    const declaration = source.statements
      .flatMap((n) =>
        ts.isVariableStatement(n) && n.declarationList.flags & ts.NodeFlags.Const
          ? [...n.declarationList.declarations]
          : [],
      )
      .find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (!declaration?.initializer) throw new Error(unsupported);
    expression = unwrap(declaration.initializer);
  }
  if (!ts.isObjectLiteralExpression(expression)) throw new Error(unsupported);
  return expression;
}
function properties(object: ts.ObjectLiteralExpression) {
  const found = new Map<string, ts.PropertyAssignment | ts.ShorthandPropertyAssignment>();
  for (const member of object.properties) {
    if (
      (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) ||
      !member.name ||
      (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))
    )
      throw new Error(unsupported);
    if (found.has(member.name.text))
      throw new Error("Duplicate configuration fields must be resolved in the file before saving here.");
    found.set(member.name.text, member);
  }
  return found;
}
function parse(source: string) {
  const file = ts.createSourceFile("agentdiff.config.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors = (file as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  if (errors.length) throw new Error("The config file has a syntax error. Fix it before saving from the dashboard.");
  return file;
}
export function configEditability(source: string): { editable: boolean; editReason?: string } {
  try {
    properties(configObject(parse(source)));
    return { editable: true };
  } catch (error) {
    return { editable: false, editReason: (error as Error).message };
  }
}

/** Surgical edits to AST ranges keep all untouched source, comments and imports. */
export function editConfigSource(source: string, current: Config, requested: Config): string {
  const next = ConfigSchema.parse(requested);
  const file = parse(source),
    root = configObject(file);
  const edits: { start: number; end: number; text: string }[] = [];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  function update(object: ts.ObjectLiteralExpression, before: Record<string, unknown>, after: Record<string, unknown>) {
    const members = properties(object);
    const baseIndent =
      source.slice(source.lastIndexOf("\n", object.getStart(file)) + 1, object.getStart(file)).match(/^\s*/)?.[0] ?? "";
    const indent = baseIndent + "  ";
    const additions: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (canonical(before[key]) === canonical(after[key])) continue;
      const member = members.get(key),
        value = after[key];
      if (value === undefined) {
        if (!member) continue;
        const end = member.end;
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
        scanner.setTextPos(end);
        const comma = scanner.scan() === ts.SyntaxKind.CommaToken ? scanner.getTokenPos() : -1;
        edits.push({ start: member.getStart(file), end, text: "" });
        if (comma >= 0) edits.push({ start: comma, end: comma + 1, text: "" });
      } else if (
        member &&
        ts.isPropertyAssignment(member) &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        before[key] &&
        typeof before[key] === "object" &&
        !Array.isArray(before[key])
      ) {
        const nested = unwrap(member.initializer);
        if (!ts.isObjectLiteralExpression(nested))
          throw new Error(`The ${key} settings are computed in code. Edit that section in the config file.`);
        update(nested, before[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        const literal = JSON.stringify(value, null, 2).replace(/\n/g, newline + indent);
        if (member && ts.isPropertyAssignment(member))
          edits.push({ start: member.initializer.getStart(file), end: member.initializer.end, text: literal });
        else if (member) edits.push({ start: member.getStart(file), end: member.end, text: `${key}: ${literal}` });
        else additions.push(`${indent}${key}: ${literal},`);
      }
    }
    if (additions.length) {
      const last = object.properties.at(-1);
      const close = object.end - 1;
      const lastRemoved =
        last && edits.some((e) => e.start === last.getStart(file) && e.end === last.end && e.text === "");
      // A comma after an existing property is harmless even when edits remove it;
      // only add one for the last retained member when the original omitted it.
      const retained = [...object.properties]
        .reverse()
        .find((m) => !edits.some((e) => e.start === m.getStart(file) && e.end === m.end && e.text === ""));
      if (last && retained === last && !lastRemoved && !object.properties.hasTrailingComma && last.end < close)
        edits.push({ start: last.end, end: last.end, text: "," });
      const prefix = last && retained === last && !object.properties.hasTrailingComma && last.end === close ? "," : "";
      edits.push({
        start: close,
        end: close,
        text: `${prefix}${newline}${additions.join(newline)}${newline}${baseIndent}`,
      });
    }
  }
  update(root, current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  const output = edits
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), source);
  parse(output);
  return output;
}

export async function configDocument() {
  // Read around the import so the revision always describes the evaluated file.
  const file = await findConfigFile();
  if (!file)
    throw new Error(
      "No agentdiff config file found in this project. Create agentdiff.config.ts before using Project settings.",
    );
  const source = await fs.readFile(file, "utf8");
  const loaded = await loadConfig(file);
  if ((await fs.readFile(file, "utf8")) !== source)
    throw new Error("The config changed while loading. Reload the project.");
  const editability = (await fs.lstat(file)).isSymbolicLink()
    ? {
        editable: false,
        editReason: "This config is a symbolic link. Edit its source file directly to preserve the link.",
      }
    : configEditability(source);
  return { ...loaded, file, source, revision: revisionOf(source), ...editability };
}

export async function saveProjectConfig(revision: string, config: Config) {
  const current = await configDocument();
  if (revision !== current.revision)
    throw new Error("The config changed on disk. Reload the project before saving your edits.");
  if (!current.editable) throw new Error(current.editReason);
  const next = ConfigSchema.parse(config);
  const output = editConfigSource(current.source, current.config, next);
  if (output === current.source) return { config: next, revision: current.revision };
  const temporary = path.join(current.rootDir, `.agentdiff-config-${randomUUID()}${path.extname(current.file)}`);
  try {
    await fs.writeFile(temporary, output, { flag: "wx", mode: (await fs.stat(current.file)).mode });
    const checked = await loadConfig(temporary);
    if (canonical(checked.config) !== canonical(next))
      throw new Error(
        "The config contains code that changes these settings. Edit the file directly to preserve that behavior.",
      );
    if (revisionOf(await fs.readFile(current.file, "utf8")) !== revision)
      throw new Error("The config changed while saving. Reload the project before trying again.");
    await fs.rename(temporary, current.file);
    return { config: checked.config, revision: revisionOf(output) };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
