#!/usr/bin/env bun
// Conflict Witness: merge conflicts for English.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { changedLines, collect, type SourceFile } from "./collect";
import { buildPrompt, judge, type RawFinding, type Verdict } from "./judge";
import * as brain from "./brain";
import { renderReport } from "./report";

export type Finding = RawFinding & {
  pairId: string;
  a: { ref: string; file: string; line: number; text: string; changed: boolean };
  b: { ref: string; file: string; line: number; text: string; changed: boolean };
  suppressedBy?: string; // GBrain decision slug
  decisionWhy?: string;
};

export type Run = {
  mode: "check" | "scan";
  repo: string;
  base?: string;
  head?: string;
  task?: string;
  brain: string;
  files: { id: string; path: string; kind: string; scope: string; loadReason: string; directives: number; changed: number }[];
  findings: Finding[];
  precedents: string[];
  judgeMs: number;
  cached: boolean;
  at: string;
};

const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        flags[k] = v;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const pairIdOf = (a: string, b: string) =>
  "cw-" + createHash("sha1").update([norm(a), norm(b)].sort().join("||")).digest("hex").slice(0, 10);

const STATE = process.env.WITNESS_STATE ?? ".witness";

function lookup(files: SourceFile[], ref: string) {
  for (const f of files) for (const d of f.directives) if (d.ref === ref) return d;
  return null;
}

async function runCheck(mode: "check" | "scan", flags: Record<string, string | boolean>) {
  const repo = resolve(String(flags.repo ?? "."));
  const task = typeof flags.task === "string" ? flags.task : undefined;
  const base = mode === "check" ? String(flags.base ?? "main") : undefined;
  const head = mode === "check" ? String(flags.head ?? "HEAD") : undefined;
  const brainHome = brain.useBrain(typeof flags.brain === "string" ? resolve(flags.brain) : undefined);
  if (mode === "scan" && !task) throw new Error("scan needs --task");

  const changed = mode === "check" ? changedLines(repo, base!, head!) : new Map();
  const files = collect({ repo, changed, task, global: !!flags.global, maxPerFile: Number(flags["max-per-file"] ?? 40) });
  const nChanged = files.reduce((n, f) => n + f.directives.filter((d) => d.changed).length, 0);

  console.log(C.bold(`\n⚖  Conflict Witness`) + C.dim(`  ${mode === "check" ? `${base}..${head}` : "task scan"} · brain: ${brainHome}`));
  if (task) console.log(C.dim(`   task: "${task}"`));
  console.log(C.dim(`\n   co-loaded instruction files:`));
  for (const f of files)
    console.log(
      `   ${C.cyan(f.id.padEnd(3))} ${f.path.padEnd(44)} ${C.dim(`${f.directives.length} directives${f.directives.some((d) => d.changed) ? `, ${f.directives.filter((d) => d.changed).length} changed` : ""} · ${f.loadReason}`)}`,
    );
  if (mode === "check" && nChanged === 0) {
    console.log(C.green(`\n   No instruction directives changed between ${base} and ${head}. Nothing to witness.\n`));
    return 0;
  }

  // GBrain: pull team precedent before judging.
  const precedentTerms = files.map((f) => f.path.split("/").slice(-2).join(" ")).join(" ");
  const precedents = brain.searchPrecedents(`conflict-witness decision ${precedentTerms}`.slice(0, 300));
  if (precedents.length) console.log(C.dim(`\n   GBrain: ${precedents.length} prior team decision(s) loaded as precedent`));

  const prompt = buildPrompt(files, task, precedents, mode === "check");
  process.stdout.write(C.dim(`\n   judging ${files.reduce((n, f) => n + f.directives.length, 0)} directives with claude -p … `));
  // Cache on what was judged (files + task), not on advisory precedent, so re-runs after an approval are instant.
  const { findings: raw, cached, ms } = await judge(prompt, buildPrompt(files, task, [], mode === "check"), join(STATE, "cache"), !!flags.fresh);
  console.log(C.dim(cached ? "(cached)" : `${(ms / 1000).toFixed(1)}s`));

  const findings: Finding[] = [];
  for (const r of raw) {
    const a = lookup(files, r.a_ref);
    const b = lookup(files, r.b_ref);
    if (!a || !b) continue; // judge cited a ref that doesn't exist: drop, never invent lines
    const f: Finding = { ...r, pairId: pairIdOf(a.text, b.text), a, b };
    const dec = brain.getDecision(f.pairId);
    if (dec) {
      f.suppressedBy = brain.decisionSlug(f.pairId);
      const why = dec.match(/Decision:\s*(.+)/);
      f.decisionWhy = why?.[1]?.trim();
    }
    findings.push(f);
  }

  // GBrain: every open, undecided conflict becomes a regression case page.
  for (const f of findings.filter((f) => f.verdict === "open_conflict" && !f.suppressedBy)) {
    brain.put(brain.caseSlug(f.pairId), caseMarkdown(f, repo));
  }

  printFindings(findings);

  const run: Run = {
    mode,
    repo,
    base,
    head,
    task,
    brain: brainHome,
    files: files.map((f) => ({
      id: f.id,
      path: f.path,
      kind: f.kind,
      scope: f.scope,
      loadReason: f.loadReason,
      directives: f.directives.length,
      changed: f.directives.filter((d) => d.changed).length,
    })),
    findings,
    precedents,
    judgeMs: ms,
    cached,
    at: new Date().toISOString(),
  };
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, "last-run.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(STATE, "report.html"), renderReport(run));
  console.log(C.dim(`   report: ${join(STATE, "report.html")}  ·  publish: bun src/witness.ts publish\n`));
  const open = findings.filter((f) => f.verdict === "open_conflict" && !f.suppressedBy).length;
  return open > 0 ? 1 : 0;
}

function printFindings(findings: Finding[]) {
  const open = findings.filter((f) => f.verdict === "open_conflict" && !f.suppressedBy);
  const suppressed = findings.filter((f) => f.suppressedBy);
  const resolved = findings.filter((f) => f.verdict !== "open_conflict" && !f.suppressedBy);
  console.log();
  for (const f of open) {
    console.log(C.red(C.bold(`   ✗ OPEN CONFLICT  ${f.title}`)) + C.dim(`  [${f.severity}] ${f.pairId}`));
    console.log(`     ${C.yellow(`${f.a.file}:${f.a.line}`)}  ${f.a.text}`);
    console.log(`     ${C.yellow(`${f.b.file}:${f.b.line}`)}  ${f.b.text}`);
    console.log(`     ${C.bold("witness task:")} "${f.witness_task}"`);
    console.log(`     ${C.bold("dilemma:")} ${f.agent_dilemma}`);
    console.log(`     ${C.bold("fix:")} ${f.proposed_clarification}`);
    console.log(C.dim(`     approve as exception: bun src/witness.ts approve ${f.pairId} --why "..."\n`));
  }
  for (const f of resolved) {
    const label = f.verdict === "resolved_by_precedence" ? "RESOLVED BY PRECEDENCE" : "RESOLVED BY SCOPE";
    console.log(C.green(`   ✓ ${label}  ${f.title}`) + C.dim(`  ${f.pairId}`));
    console.log(C.dim(`     ${f.a.file}:${f.a.line} vs ${f.b.file}:${f.b.line}`));
    console.log(C.dim(`     evidence: ${f.resolution_evidence}\n`));
  }
  for (const f of suppressed) {
    console.log(C.cyan(`   ◆ DECIDED IN GBRAIN  ${f.title}`) + C.dim(`  ${f.pairId}`));
    console.log(C.dim(`     ${f.a.file}:${f.a.line} vs ${f.b.file}:${f.b.line}`));
    console.log(C.dim(`     ${f.suppressedBy}${f.decisionWhy ? ` — "${f.decisionWhy}"` : ""}\n`));
  }
  console.log(
    C.bold(`   ${open.length} open`) + ` · ${resolved.length} resolved by precedence/scope · ${suppressed.length} already decided in GBrain`,
  );
}

function caseMarkdown(f: Finding, repo: string): string {
  return `---
type: conflict-case
title: "${f.title.replace(/"/g, "'")}"
pair_id: ${f.pairId}
status: open
severity: ${f.severity}
---
# Conflict case ${f.pairId}: ${f.title}

Regression case recorded by Conflict Witness (repo: ${repo}).

- A: \`${f.a.file}:${f.a.line}\` — ${f.a.text}
- B: \`${f.b.file}:${f.b.line}\` — ${f.b.text}

**Witness task:** ${f.witness_task}

**Agent dilemma:** ${f.agent_dilemma}

**Why both apply:** ${f.why_both_apply}

**Proposed clarification:** ${f.proposed_clarification}
`;
}

function approve(pairId: string, flags: Record<string, string | boolean>) {
  brain.useBrain(typeof flags.brain === "string" ? resolve(flags.brain) : undefined);
  const why = String(flags.why ?? "");
  if (!why) throw new Error('approve needs --why "<the team decision>"');
  const lastPath = join(STATE, "last-run.json");
  const last: Run | null = existsSync(lastPath) ? JSON.parse(readFileSync(lastPath, "utf8")) : null;
  const f = last?.findings.find((x) => x.pairId === pairId);
  if (!f) throw new Error(`no finding ${pairId} in ${lastPath}; run check first`);
  const by = String(flags.by ?? process.env.USER ?? "reviewer");
  const slug = brain.decisionSlug(pairId);
  const md = `---
type: conflict-decision
title: "Conflict Witness decision: ${f.title.replace(/"/g, "'")}"
pair_id: ${pairId}
decided_by: ${by}
---
# conflict-witness decision ${pairId}: ${f.title}

Decision: ${why}

Applies to this pair of agent instructions:
- \`${f.a.file}:${f.a.line}\` — ${f.a.text}
- \`${f.b.file}:${f.b.line}\` — ${f.b.text}

Witness task that triggered review: ${f.witness_task}

Suggested wording (if the team later wants to encode this in the files): ${f.proposed_clarification}
`;
  const r = brain.put(slug, md);
  if (!r.ok) throw new Error(`gbrain put failed:\n${r.out}`);
  brain.tag(slug, "approved-exception");
  brain.tag(slug, "conflict-witness");
  const caseMd = caseMarkdown(f, last!.repo).replace("status: open", "status: decided");
  brain.put(brain.caseSlug(pairId), caseMd);
  brain.link(slug, brain.caseSlug(pairId), "resolves conflict case");
  console.log(C.cyan(`\n   ◆ Saved to GBrain: ${slug}`));
  console.log(C.dim(`     tagged approved-exception · linked → ${brain.caseSlug(pairId)}`));
  console.log(C.dim(`     every harness on this brain (Claude Code, Codex, ChatGPT via gbrain.io) now sees this decision.\n`));
}

function publish(flags: Record<string, string | boolean>) {
  const file = join(STATE, "report.html");
  if (!existsSync(file)) throw new Error("no report yet; run check first");
  const cmd = [
    "superset",
    "pages",
    "publish",
    file,
    "--title",
    String(flags.title ?? "Conflict Witness"),
    "--description",
    "Merge conflicts for English: instruction conflicts, witness tasks, and GBrain-backed decisions",
    "--visibility",
    String(flags.visibility ?? "everyone"),
    "--label",
    String(flags.label ?? `witness run ${new Date().toISOString().slice(0, 16)}`),
    "--json",
  ];
  if (typeof flags.page === "string") cmd.push("--page", flags.page);
  const p = Bun.spawnSync(cmd, { stdin: "ignore" });
  console.log(p.stdout.toString() || p.stderr.toString());
  return p.exitCode ?? 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  switch (cmd) {
    case "check":
      process.exit(await runCheck("check", flags));
    case "scan":
      process.exit(await runCheck("scan", flags));
    case "approve":
      approve(pos[0], flags);
      break;
    case "decisions":
      brain.useBrain(typeof flags.brain === "string" ? resolve(flags.brain) : undefined);
      console.log(brain.listDecisions());
      break;
    case "report": {
      const last: Run = JSON.parse(readFileSync(join(STATE, "last-run.json"), "utf8"));
      writeFileSync(join(STATE, "report.html"), renderReport(last));
      console.log(join(STATE, "report.html"));
      break;
    }
    case "publish":
      process.exit(publish(flags));
    default:
      console.log(`conflict-witness — merge conflicts for English

  check    --repo <path> --base main [--head HEAD] [--task "..."] [--global] [--brain <dir>] [--fresh]
  scan     --task "..." [--repo <path>] [--global] [--brain <dir>]
  approve  <pairId> --why "<team decision>" [--by <name>] [--brain <dir>]
  decisions [--brain <dir>]
  report   re-render .witness/report.html from the last run
  publish  [--page <id>] publish the report as a Superset page`);
  }
}

main().catch((e) => {
  console.error(C.red(String(e?.message ?? e)));
  process.exit(2);
});
