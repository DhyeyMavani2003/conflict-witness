---
name: ship
description: Use when the user says "ship it", "open a PR", or "release". Runs tests, bumps the version, writes the changelog and opens the PR.
---
# Ship

1. Run `bun test`. Stop if anything fails.
2. Version bump:
   - PATCH for fixes.
   - MINOR: AskUserQuestion for any feature signal (new route, migration, new module). Wait for the answer.
   - MAJOR: AskUserQuestion for breaking API changes. Never bump MAJOR without explicit approval.
3. Write a CHANGELOG entry, push, and open the PR.
