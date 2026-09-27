# Conflict Witness

**Merge conflicts for English.** Conflict Witness checks agent instruction files (`CLAUDE.md`, `AGENTS.md`, `SKILL.md`) for contradictions at merge time.

Teams now merge skills and rules files as often as they merge code. Git will merge two lines that tell the agent opposite things and report no conflict. Conflict Witness finds those pairs, shows a concrete task that makes both rules fire, and records the team's decision in GBrain so the same pair isn't flagged again.

> Built at the YC **"Own Your Intelligence"** hackathon, 2026-09-27, with **GBrain** + **Superset**.

---

## How it works

```
PR diff / task
   │
   ├─ 1. Co-load     which instruction files would Claude Code load together?
   │                 ~/.claude/CLAUDE.md, repo CLAUDE.md / AGENTS.md,
   │                 subdirectory-scoped rules, skills whose description matches the task
   ├─ 2. Extract     directives with file:line
   ├─ 3. Recall      gbrain get   → exact pair already decided? suppress
   │                 gbrain search → past decisions fed to the judge as precedent
   ├─ 4. Judge       one batched `claude -p` call with a JSON schema
   └─ 5. Report      terminal + .witness/last-run.json + .witness/report.html
                     exit 1 if open conflicts remain (CI gate)
```

For each incompatible pair, the judge returns:

| Field | What it is |
|---|---|
| `verdict` | `open_conflict` \| `resolved_by_precedence` \| `resolved_by_scope` |
| `a`, `b` | the two cited lines, with `file:line` (refs are validated; a hallucinated line is dropped) |
| `agent_dilemma` | what the agent can't do if it follows both |
| `witness_task` | a concrete user request that triggers both directives |
| `resolution_evidence` | the quoted override clause or scope boundary (resolved verdicts only) |
| `proposed_clarification` | suggested replacement wording |

The resolved verdicts show that precedence and scope were checked. They are how the tool avoids false positives: a pair that looks contradictory but is already settled by an override clause or a directory boundary is reported as resolved, not open.

## Quickstart

Requires `bun`, `git`, `gbrain`, and the `claude` CLI. There are no npm dependencies.

```bash
# Check a PR: which instruction pairs does this diff put in conflict?
bun src/witness.ts check --repo <path> --base main [--head HEAD] [--task "..."] [--global] [--brain ~/.conflict-witness/brain] [--fresh]

# No PR: what does this task co-load, and does any of it conflict?
bun src/witness.ts scan --task "open localhost:3000 and check the console" --global

# Record a team decision in GBrain (the pair is suppressed on future runs)
bun src/witness.ts approve <pairId> --why "Hotfixes may skip tests only with a follow-up ticket"

# List recorded decisions
bun src/witness.ts decisions

# Publish the report as a shareable Superset page
bun src/witness.ts publish

# Full demo: builds a repo with a base commit and a PR commit, then runs every step
./demo/run.sh
```

| Flag | Meaning |
|---|---|
| `--global` | include the user-global `~/.claude/CLAUDE.md` |
| `--brain <dir>` | use an isolated brain (sets `GBRAIN_HOME`) |
| `--fresh` | bypass the judge cache |
| `--task` | load skills as if the agent were given this task |

## Demo: `acme-api`

**Base `CLAUDE.md`:** every PR must include a regression test. Never open a PR while `bun test` fails. Choose versions yourself and don't ask the user to approve one; *"this policy overrides the version-approval prompts in the ship skill."* Use pnpm.

**The PR:**

| Change | Verdict |
|---|---|
| `hotfix` skill: "skip writing tests" | **open_conflict** vs "every PR must include a regression test" |
| `hotfix` skill: "open the PR immediately even if the suite is red" | **open_conflict** vs "never open a PR while `bun test` fails" |
| `ship` skill: AskUserQuestion for MAJOR bumps | **resolved_by_precedence**, because the override clause names ship |
| new `legacy/CLAUDE.md`: "use npm in this directory" | **resolved_by_scope**, because it only applies inside `legacy/` |

## Found on our own dev machine (real runs, not fixtures)

**1. `scan --global --task "open localhost:3000 in a browser, click through the signup page and check the console for errors"`: 2 open conflicts**

- `~/.claude/CLAUDE.md:5`: *"Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools."* vs `~/.claude/skills/browser-automation/SKILL.md:3`, whose description claims *"check the page… console errors… verify the UI"*. Nothing says which one wins for localhost QA.
- `browse/SKILL.md:5` and `browser-automation/SKILL.md:3` both claim the same job ("click through a flow… check console errors"), and neither defers to the other.
- The proposed fix scopes the global rule: *"…use `/browse` for external or user-facing sites; for headless verification of your own local dev server, use `browser-automation`."*

**2. `scan --repo ~/.claude/skills/gstack --task "ship it: bump the version and release"`: 0 open, 4 correctly resolved**

- `ship/SKILL.md:720` (AskUserQuestion for MINOR/MAJOR bumps) vs gstack `CLAUDE.md:520`: **resolved by precedence**. The evidence quoted is *"overrides generic version-approval prompts in `/ship` and `/document-release`."*
- `document-release/SKILL.md:572` vs `CLAUDE.md:520`: **resolved by precedence**, because the override names document-release explicitly.
- Two more pairs (a CHANGELOG rule pair and a docs-sync guard pair) were **resolved by scope**.

This is the false-positive test that matters. A pairwise linter flags every one of these; Conflict Witness reads the override clauses and stays quiet.

## GBrain: decisions the whole team can see (sponsor)

- Every open conflict is saved as a regression case page at `conflicts/<pairId>`.
- `witness approve <pairId> --why "..."` writes a decision page at `decisions/conflict-witness/<pairId>` (type `conflict-decision`), tags it `approved-exception`, and links it to the case page.
- On later runs, an exact lookup with `gbrain get` suppresses the pair (*"suppressed by GBrain decision ..."*). Past decisions retrieved with `gbrain search` are also given to the judge as precedent, so a reworded version of an approved rule is still recognized.
- `pairId` is a hash of both directive texts, so it stays the same when lines move.
- Any tool connected to the same brain (Claude Code, Codex, ChatGPT via gbrain.io) sees the same decisions.

## Superset: shareable report (sponsor)

`witness publish` runs:

```bash
superset pages publish .witness/report.html --title "Conflict Witness" --visibility everyone
```

The report becomes a versioned Superset page that reviewers can comment on.

## Why it matters

- **SLBench / SkillLogic** ([arXiv 2607.09016](https://arxiv.org/abs/2607.09016), Jul 2026): 70% of 5,000+ public agent skills contain logical relations between rules. Codex and Claude Code violate them in up to 70% of cases.
- **IH-Benchmark** ([arXiv 2607.25987](https://arxiv.org/abs/2607.25987)): compliance under conflicting instructions ranges from 20.5% to 98.2% across 37 models. Implicitly phrased rules score up to about 10 points worse, which is why our suggested rewrites use explicit precedence sentences.
- **Demand:** [OpenHands issue #17251](https://github.com/OpenHands/OpenHands/issues/17251) (Sep 2026) asks for semantic conflict detection across AGENTS.md and skills. [agenthood #595](https://github.com/fworks-tech/agenthood/issues/595): *"no existing tool does this well."*

## Prior art

We did not invent conflict linting. We add three things none of these tools do: **witness tasks**, **precedence and scope verdicts**, and **team memory of decisions in GBrain**.

| Tool | What it does | What it lacks compared to Conflict Witness |
|---|---|---|
| [Scavi](https://github.com/hsr88/scavi) | Lints AGENTS.md, CLAUDE.md, Cursor and Copilot rules. Optional LLM semantic check. PR-scoped GitHub Action. | No witness task, no precedence verdict, no decision memory |
| [ruleward](https://github.com/kernullist/ruleward) | Rule-file linter with an opt-in NLI tier (info-level, same code referent only) | No SKILL.md co-loading, no witness task. Suppression is a static disable config only. |
| [WhichRules](https://github.com/z35068037/whichrules) | Rebuilds each agent's instruction stack and flags explicit conflicts in fixed categories | Its README says it is *"not an LLM judge, will miss semantic contradictions"* |
| [agent-rule-conflicts](https://github.com/actions-marketplace-validations/al1re3a_agent-rule-conflicts) | Polarity-based checks with SARIF output | States that it does not handle precedence or semantic equivalence |
| [skills-evals](https://github.com/ahnafyy/skills-evals) | Behavioral evals for each skill in CI | Does not look for contradictions between rules |
| [skill-collision-guard](https://github.com/Three-Liu/skill-collision-guard) | Install-time checks using 5 regex families | Suppression lasts only for the session |
| gbrain `check-resolvable` | Checks skill trees for reachability, MECE coverage, and DRY overlap | Does not check for contradictions. Conflict Witness fills that gap. |

## Limitations

- **Witness tasks are generated examples, not executed proofs.** Next step: run each one against the old and new instructions and compare behavior.
- **Only Claude Code's loading model** is supported so far. Codex and Cursor load files differently.
- **Skill matching uses a keyword prefilter**, so a skill whose description doesn't share words with the task can be missed.
- **The LLM judge can be wrong.** Results are cached per judged input (files + task) so repeated runs give the same answer, and `--fresh` forces a new call.

## Roadmap

- Run witness tasks as behavioral regression tests (old instructions vs new).
- **QM skill registry hook:** add a `semantic_conflict` exclusion reason to QM's admin skill-pack promotion. `planIngest` currently checks only for name collisions.
- **Memorable:** flag stored procedures that a newly merged directive invalidates.
- **River:** train a small conflict judge on the GBrain regression cases.
- A GitHub Action.

## Hackathon notes

- All code was written on 2026-09-27 during hackathon hours.
- Side quests: **GBrain** (automate the tedious work of reviewing instruction-file PRs) and **Superset**.
