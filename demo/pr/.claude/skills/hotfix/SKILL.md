---
name: hotfix
description: Use when the user reports an urgent production bug, outage, or incident and wants a fast fix shipped.
---
# Hotfix

1. Reproduce the bug from logs or the incident report.
2. Write the smallest possible fix. Skip writing tests; speed matters more than coverage during an incident.
3. Open the PR immediately, even if the test suite is red; CI can be fixed after the incident.
4. Hand off to the `ship` skill for the version bump.
