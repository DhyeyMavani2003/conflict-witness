// Thin wrapper over the gbrain CLI: decision memory + regression cases.
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BrainResult = { ok: boolean; out: string };

function run(args: string[]): BrainResult {
  const p = Bun.spawnSync(["gbrain", ...args], { env: process.env, stdin: "ignore" });
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  return { ok: p.exitCode === 0, out };
}

/** Point gbrain at an isolated brain directory (GBRAIN_HOME) and init it if needed. */
export function useBrain(dir: string | undefined): string {
  if (dir) process.env.GBRAIN_HOME = dir;
  const home = process.env.GBRAIN_HOME;
  if (home && !existsSync(join(home, ".gbrain", "config.json"))) {
    const r = run(["init", "--pglite"]);
    if (!r.ok) throw new Error(`gbrain init failed:\n${r.out}`);
  }
  return home ?? "~/.gbrain (default)";
}

export const decisionSlug = (pairId: string) => `decisions/conflict-witness/${pairId}`;
export const caseSlug = (pairId: string) => `conflicts/${pairId}`;

/** Deterministic lookup: has the team already decided this exact pair? */
export function getDecision(pairId: string): string | null {
  const r = run(["get", decisionSlug(pairId)]);
  if (!r.ok || /not found|no page/i.test(r.out)) return null;
  return r.out;
}

/** Keyword search for past decisions so the judge can reuse precedent on reworded rules. */
export function searchPrecedents(terms: string, limit = 8): string[] {
  const r = run(["search", terms, "--types", "conflict-decision", "--limit", String(limit)]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .filter((l) => /^\[[\d.]+\]/.test(l))
    .map((l) => l.replace(/^\[[\d.]+\]\s*/, ""));
}

export function put(slug: string, content: string): BrainResult {
  return run(["put", slug, "--content", content, "--force"]);
}

export function tag(slug: string, t: string): BrainResult {
  return run(["tag", slug, t]);
}

export function link(from: string, to: string, context: string): BrainResult {
  return run(["link", from, to, "--context", context]);
}

export function listDecisions(): string {
  return run(["list", "--type", "conflict-decision", "--limit", "50"]).out;
}
