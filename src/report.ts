// Self-contained HTML report (published as a Superset page).
import type { Finding, Run } from "./witness";

const esc = (s: string | undefined) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function status(f: Finding) {
  if (f.suppressedBy) return { cls: "decided", label: "Decided in GBrain" };
  if (f.verdict === "open_conflict") return { cls: "open", label: "Open conflict" };
  if (f.verdict === "resolved_by_precedence") return { cls: "resolved", label: "Resolved by precedence" };
  return { cls: "resolved", label: "Resolved by scope" };
}

function card(f: Finding) {
  const s = status(f);
  const line = (d: Finding["a"]) =>
    `<div class="line"><div class="loc">${esc(d.file)}:${d.line}${d.changed ? ' <span class="chg">changed in PR</span>' : ""}</div><div class="txt">${esc(d.text)}</div></div>`;
  return `<article class="card ${s.cls}">
  <header><span class="pill ${s.cls}">${s.label}</span><h3>${esc(f.title)}</h3><code class="id">${f.pairId}</code></header>
  <div class="pair">${line(f.a)}<div class="vs">vs</div>${line(f.b)}</div>
  <dl>
    <dt>Witness task</dt><dd class="witness">“${esc(f.witness_task)}”</dd>
    <dt>Agent’s dilemma</dt><dd>${esc(f.agent_dilemma)}</dd>
    ${f.verdict !== "open_conflict" && f.resolution_evidence ? `<dt>Why it’s not a conflict</dt><dd><q>${esc(f.resolution_evidence)}</q></dd>` : ""}
    ${f.verdict === "open_conflict" && !f.suppressedBy ? `<dt>Proposed clarification</dt><dd class="fix">${esc(f.proposed_clarification)}</dd>` : ""}
    ${f.suppressedBy ? `<dt>Team decision (GBrain)</dt><dd><code>${esc(f.suppressedBy)}</code>${f.decisionWhy ? ` — ${esc(f.decisionWhy)}` : ""}</dd>` : ""}
  </dl>
</article>`;
}

export function renderReport(run: Run): string {
  const open = run.findings.filter((f) => f.verdict === "open_conflict" && !f.suppressedBy);
  const resolved = run.findings.filter((f) => f.verdict !== "open_conflict" && !f.suppressedBy);
  const decided = run.findings.filter((f) => f.suppressedBy);
  const ordered = [...open, ...decided, ...resolved];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conflict Witness</title>
<style>
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b6760;--card:#fff;--line:#e7e3da;--red:#c2361f;--redbg:#fdeee9;--green:#2f7a45;--greenbg:#eaf5ec;--blue:#2856b8;--bluebg:#eaf0fc;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141414;--fg:#ecebe8;--muted:#9b978f;--card:#1d1d1c;--line:#2f2e2b;--red:#ff7a61;--redbg:#3a1d17;--green:#6fcf8a;--greenbg:#16301f;--blue:#8fb0ff;--bluebg:#1a2542;--code:#262523}}
:root[data-theme="dark"]{--bg:#141414;--fg:#ecebe8;--muted:#9b978f;--card:#1d1d1c;--line:#2f2e2b;--red:#ff7a61;--redbg:#3a1d17;--green:#6fcf8a;--greenbg:#16301f;--blue:#8fb0ff;--bluebg:#1a2542;--code:#262523}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}h1 span{color:var(--muted);font-weight:400}
.sub{color:var(--muted);margin:0 0 20px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 26px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:130px}
.stat b{display:block;font-size:24px}.stat.open b{color:var(--red)}.stat.resolved b{color:var(--green)}.stat.decided b{color:var(--blue)}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 16px}
.card.open{border-left-color:var(--red)}.card.resolved{border-left-color:var(--green)}.card.decided{border-left-color:var(--blue)}
.card header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.card h3{margin:0;font-size:17px;flex:1;min-width:200px}
.pill{font-size:12px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap}
.pill.open{background:var(--redbg);color:var(--red)}.pill.resolved{background:var(--greenbg);color:var(--green)}.pill.decided{background:var(--bluebg);color:var(--blue)}
code,.loc{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.id{color:var(--muted)}
.pair{display:grid;grid-template-columns:1fr auto 1fr;gap:10px;margin:14px 0;align-items:stretch}
@media (max-width:640px){.pair{grid-template-columns:1fr}.vs{text-align:center}}
.line{background:var(--code);border-radius:8px;padding:10px 12px;overflow-wrap:anywhere}.loc{color:var(--muted);margin-bottom:4px}.txt{font-size:14px}
.chg{background:var(--redbg);color:var(--red);border-radius:4px;padding:0 5px;font-size:11px}
.vs{align-self:center;color:var(--muted);font-size:12px;font-weight:600}
dl{margin:0;display:grid;grid-template-columns:170px 1fr;gap:6px 14px}@media (max-width:640px){dl{grid-template-columns:1fr}}
dt{color:var(--muted);font-size:13px}dd{margin:0}.witness{font-style:italic}.fix{font-weight:500}
.files{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-top:28px;font-size:13.5px}
.files table{width:100%;border-collapse:collapse}.files td{padding:4px 6px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.files td:first-child{width:36px;color:var(--muted)}
footer{color:var(--muted);font-size:13px;margin-top:22px}
</style></head><body><main>
<h1>Conflict Witness <span>· merge conflicts for English</span></h1>
<p class="sub">${run.mode === "check" ? `PR <code>${esc(run.base)}..${esc(run.head)}</code>` : "Task scan"}${run.task ? ` · task: “${esc(run.task)}”` : ""} · ${esc(run.at.slice(0, 16).replace("T", " "))} UTC</p>
<div class="stats">
  <div class="stat open"><b>${open.length}</b>open conflicts</div>
  <div class="stat decided"><b>${decided.length}</b>decided in GBrain</div>
  <div class="stat resolved"><b>${resolved.length}</b>resolved by precedence/scope</div>
  <div class="stat"><b>${run.files.length}</b>co-loaded files</div>
</div>
${ordered.map(card).join("\n") || '<p>No conflicts found.</p>'}
<section class="files"><strong>What the agent would load</strong>
<table>${run.files.map((f) => `<tr><td>${f.id}</td><td><code>${esc(f.path)}</code><br><span style="color:var(--muted)">${esc(f.scope)}</span></td><td>${f.directives} directives${f.changed ? `, ${f.changed} changed` : ""}</td></tr>`).join("")}</table></section>
<footer>Open conflicts are saved as regression cases in GBrain (<code>conflicts/&lt;pairId&gt;</code>). Approving one writes a team decision to <code>decisions/conflict-witness/&lt;pairId&gt;</code> that every harness on the brain can see. Witness tasks are generated reproducers, not executed proofs.</footer>
</main></body></html>`;
}
