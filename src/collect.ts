// Collect the instruction files an agent would co-load, and the directives inside them.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";

export type SourceFile = {
  id: string; // F1, F2, ...
  path: string; // display path (repo-relative or ~/...)
  abs: string;
  kind: "global-rules" | "repo-rules" | "scoped-rules" | "skill";
  scope: string; // when this file is in the agent's context
  loadReason: string;
  directives: Directive[];
};

export type Directive = {
  ref: string; // F2:L17
  file: string;
  line: number;
  text: string;
  changed: boolean; // added/edited in the PR under review
};

const DIRECTIVE_RE =
  /\b(must|never|always|do not|don't|dont|only|ask|askuserquestion|stop|require[sd]?|should|avoid|prefer|use|skip|without|every|all|immediately|wait|overrides?)\b/i;

const STOP = new Set(
  "the a an and or of to in on for with is are be this that it as at by from when you your use using any all should must never always do not".split(
    " ",
  ),
);

export function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

export function isInstructionFile(p: string): boolean {
  const b = basename(p);
  return (
    b === "CLAUDE.md" ||
    b === "AGENTS.md" ||
    b === "SKILL.md" ||
    /\.cursor\/rules\/.+\.mdc?$/.test(p) ||
    p.endsWith(".github/copilot-instructions.md")
  );
}

function frontmatter(src: string): Record<string, string> {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export function extractDirectives(abs: string, display: string, changedLines: Set<number>): Directive[] {
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  const out: Directive[] = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    if (raw.trim().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const text = raw
      .replace(/^\s*([-*+]|\d+\.)\s+/, "")
      .replace(/^#+\s*/, "")
      .trim();
    const isDescription = /^description:\s*/.test(raw);
    if (text.length < 15 || text.length > 500) return;
    if (!isDescription && !DIRECTIVE_RE.test(text)) return;
    out.push({ ref: "", file: display, line: i + 1, text, changed: changedLines.has(i + 1) });
  });
  return out;
}

export function skillMeta(abs: string): { name: string; description: string } {
  const fm = frontmatter(readFileSync(abs, "utf8"));
  return { name: fm.name ?? basename(dirname(abs)), description: fm.description ?? "" };
}

export type CollectOpts = {
  repo: string;
  changed: Map<string, Set<number>>; // repo-relative path -> changed line numbers
  task?: string;
  global: boolean;
  maxPerFile: number;
};

export function collect(opts: CollectOpts): SourceFile[] {
  const { repo, changed, task } = opts;
  const taskWords = words(task ?? "");
  const files: Omit<SourceFile, "id" | "directives">[] = [];

  if (opts.global) {
    const g = join(homedir(), ".claude", "CLAUDE.md");
    if (existsSync(g))
      files.push({
        path: "~/.claude/CLAUDE.md",
        abs: g,
        kind: "global-rules",
        scope: "every session in every repo (user-global)",
        loadReason: "always loaded",
      });
    const skillsDir = join(homedir(), ".claude", "skills");
    if (existsSync(skillsDir) && taskWords.size) {
      for (const d of readdirSync(skillsDir)) {
        const abs = join(skillsDir, d, "SKILL.md");
        if (!existsSync(abs)) continue;
        const { name, description } = skillMeta(abs);
        const hit = overlap(taskWords, words(`${name} ${description}`));
        if (hit >= 3)
          files.push({
            path: `~/.claude/skills/${d}/SKILL.md`,
            abs,
            kind: "skill",
            scope: `loaded when the task matches: "${description.slice(0, 200)}"`,
            loadReason: `skill description matches task (${hit} shared terms)`,
          });
      }
    }
  }

  const tracked = Bun.spawnSync(["git", "-C", repo, "ls-files"]).stdout.toString().split("\n").filter(Boolean);
  for (const rel of tracked) {
    if (!isInstructionFile(rel)) continue;
    const abs = join(repo, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const dir = dirname(rel);
    const isChanged = changed.has(rel);
    if (basename(rel) === "SKILL.md") {
      const { name, description } = skillMeta(abs);
      const hit = overlap(taskWords, words(`${name} ${description}`));
      // A skill co-loads if the PR touched it, the task triggers it, or another loaded file hands off to it.
      if (!isChanged && hit < 2 && taskWords.size) continue;
      files.push({
        path: rel,
        abs,
        kind: "skill",
        scope: `loaded when the task matches: "${description.slice(0, 200)}"`,
        loadReason: isChanged ? "changed in this PR" : taskWords.size ? `description matches task (${hit} terms)` : "repo skill",
      });
    } else {
      files.push({
        path: rel,
        abs,
        kind: dir === "." ? "repo-rules" : "scoped-rules",
        scope: dir === "." ? "every session in this repo" : `only when working on files under ${dir}/`,
        loadReason: isChanged ? "changed in this PR" : "always loaded for its scope",
      });
    }
  }

  // Focus terms decide which directives survive the per-file cap.
  const focusText = [
    task ?? "",
    ...files.flatMap((f) => {
      const rel = relative(repo, f.abs);
      const ch = changed.get(rel);
      if (!ch) return [];
      const lines = readFileSync(f.abs, "utf8").split("\n");
      return [...ch].map((n) => lines[n - 1] ?? "");
    }),
  ].join(" ");
  const focus = words(focusText);

  return files.map((f, i) => {
    const id = `F${i + 1}`;
    const rel = relative(repo, f.abs);
    let ds = extractDirectives(f.abs, f.path, changed.get(rel) ?? new Set());
    if (ds.length > opts.maxPerFile) {
      const ranked = ds
        .map((d, k) => ({ d, k, s: (d.changed ? 100 : 0) + overlap(words(d.text), focus) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, opts.maxPerFile)
        .sort((a, b) => a.k - b.k);
      ds = ranked.map((r) => r.d);
    }
    ds.forEach((d) => (d.ref = `${id}:L${d.line}`));
    return { ...f, id, directives: ds };
  });
}

/** Parse `git diff -U0 base head` into repo-relative path -> added/edited line numbers (new side). */
export function changedLines(repo: string, base: string, head: string): Map<string, Set<number>> {
  const range = head === "WORKTREE" ? [base] : [base, head];
  const diff = Bun.spawnSync(["git", "-C", repo, "diff", "-U0", "--no-color", ...range]).stdout.toString();
  const out = new Map<string, Set<number>>();
  let file = "";
  let lineNo = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "");
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      lineNo = Number(h[1]);
      continue;
    }
    if (l.startsWith("+") && !l.startsWith("+++") && file && isInstructionFile(file)) {
      if (!out.has(file)) out.set(file, new Set());
      out.get(file)!.add(lineNo);
      lineNo++;
    }
  }
  return out;
}
