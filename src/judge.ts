// One batched LLM call that judges co-loaded directives and writes witness tasks.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SourceFile } from "./collect";

export type Verdict = "open_conflict" | "resolved_by_precedence" | "resolved_by_scope";

export type RawFinding = {
  a_ref: string;
  b_ref: string;
  verdict: Verdict;
  severity: "high" | "medium" | "low";
  title: string;
  why_both_apply: string;
  agent_dilemma: string;
  witness_task: string;
  resolution_evidence: string;
  proposed_clarification: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          a_ref: { type: "string", description: "ref of the changed/focus directive, e.g. F3:L12" },
          b_ref: { type: "string", description: "ref of the directive it collides with" },
          verdict: { type: "string", enum: ["open_conflict", "resolved_by_precedence", "resolved_by_scope"] },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string", description: "<= 10 words" },
          why_both_apply: { type: "string", description: "why both directives are in context for the witness task" },
          agent_dilemma: { type: "string", description: "the choice the agent is forced to make, one sentence" },
          witness_task: { type: "string", description: "a concrete user request that makes BOTH directives fire" },
          resolution_evidence: {
            type: "string",
            description: "if resolved: quote the exact override/precedence clause or scope boundary that decides it; else empty",
          },
          proposed_clarification: {
            type: "string",
            description: "a precise edit (new wording for one line, or an added precedence sentence) that removes the ambiguity; empty if already resolved",
          },
        },
        required: [
          "a_ref",
          "b_ref",
          "verdict",
          "severity",
          "title",
          "why_both_apply",
          "agent_dilemma",
          "witness_task",
          "resolution_evidence",
          "proposed_clarification",
        ],
      },
    },
  },
  required: ["findings"],
};

export function buildPrompt(files: SourceFile[], task: string | undefined, precedents: string[], diffMode: boolean): string {
  const body = files
    .map((f) => {
      const ds = f.directives.map((d) => `  [${d.ref}]${d.changed ? " (CHANGED IN PR)" : ""} ${d.text}`).join("\n");
      return `### ${f.id}: ${f.path}\nkind: ${f.kind}\nin context: ${f.scope}\nwhy loaded: ${f.loadReason}\n${ds}`;
    })
    .join("\n\n");

  return `You are Conflict Witness, a merge-time reviewer for natural-language agent instructions (CLAUDE.md, AGENTS.md, SKILL.md).

A coding agent (Claude Code) will have the files below in its context at the same time, subject to each file's "in context" scope. ${
    diffMode
      ? "Directives marked (CHANGED IN PR) were just added or edited. Only report pairs where at least one side is a CHANGED directive."
      : `The user's task is: "${task}". Only report pairs that this task would actually put in tension.`
  }

Find pairs of directives that give the agent INCOMPATIBLE instructions for some realistic task: one says do X, the other says don't / do not-X, or both claim exclusive ownership of the same job. For each pair decide:
- open_conflict: both apply to the witness task and nothing in the text says which wins.
- resolved_by_precedence: the text itself contains an explicit override / precedence / exception clause that names or clearly covers the other directive. Quote it in resolution_evidence. Be strict: a clause that overrides skill A does NOT cover a different skill B.
- resolved_by_scope: the two can never be in context for the same file/task (e.g. a subdirectory CLAUDE.md that only applies under that directory, where more-specific wins by convention). Quote the scope boundary.

Rules:
- Precision over recall. Do NOT report pairs that merely talk about the same topic, restate each other, or are compatible (e.g. "prefer X" + "X is fine"). Do not report style nits.
- The witness_task must be a concrete, realistic user request (one or two sentences) that would make an agent read both directives and have to pick one.
- proposed_clarification must be an exact wording change, not advice.
- Report resolved_* pairs only if a naive linter comparing lines pairwise would flag them — they demonstrate that precedence/scope were checked.
- Use refs exactly as given (e.g. F2:L14). At most 8 findings, most severe first.
${
  precedents.length
    ? `\nTeam decisions previously recorded in GBrain (treat a pair these clearly cover as already decided — do not report it as open):\n${precedents.map((p) => `- ${p}`).join("\n")}\n`
    : ""
}
${task && diffMode ? `Context: the PR author says agents will use these for tasks like: "${task}".\n` : ""}
FILES:

${body}`;
}

export async function judge(prompt: string, cacheKey: string, cacheDir: string, fresh: boolean): Promise<{ findings: RawFinding[]; cached: boolean; ms: number }> {
  const key = createHash("sha1").update(cacheKey).digest("hex").slice(0, 16);
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${key}.json`);
  if (!fresh && existsSync(cacheFile)) {
    return { ...JSON.parse(readFileSync(cacheFile, "utf8")), cached: true, ms: 0 };
  }
  const t0 = performance.now();
  const model = process.env.WITNESS_MODEL ?? "sonnet";
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--disallowed-tools",
      "Bash",
      "Edit",
      "Write",
      "Read",
      "WebFetch",
      "WebSearch",
      "--json-schema",
      JSON.stringify(SCHEMA),
    ],
    { cwd: tmpdir(), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`judge: could not parse claude output\n${out.slice(0, 500)}\n${err.slice(0, 500)}`);
  }
  const res = Array.isArray(parsed) ? parsed.findLast((e: any) => e.type === "result") : parsed;
  let so = res?.structured_output;
  if (!so && typeof res?.result === "string") {
    const m = res.result.match(/\{[\s\S]*\}/);
    if (m) so = JSON.parse(m[0]);
  }
  if (!so || !Array.isArray(so.findings)) throw new Error(`judge: no findings in output\n${out.slice(0, 800)}`);
  const result = { findings: so.findings as RawFinding[] };
  writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  return { ...result, cached: false, ms: performance.now() - t0 };
}
