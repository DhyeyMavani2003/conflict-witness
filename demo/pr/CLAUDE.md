# Acme API — agent instructions

## Testing
- Every PR must include a regression test for the behavior it changes.
- Never open a PR while `bun test` is failing.

## Releases
- **Choose versions autonomously; default to PATCH.** Do not ask the user to choose or approve a version. This policy overrides the version-approval prompts in the `ship` skill.

## Tooling
- Use pnpm for all package installs.
- Keep commits small and focused; one logical change per commit.
