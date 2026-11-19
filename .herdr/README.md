# .herdr — agent workflow files

All coordination between agents happens in GitHub issues and in this folder.
Nothing here may contain secrets, credentials, emails, GCP project IDs/numbers,
real service URLs, or local paths. Use placeholders: `$GCP_PROJECT`, `$GCP_REGION`,
`$API_URL`, Secret Manager secret *names* (never values).

| Path | Owner | Purpose |
|---|---|---|
| `PLAN.md` | PM | Idea, scope, architecture, task split, acceptance criteria |
| `contracts/api.yaml` | PM (BE proposes changes) | OpenAPI contract between backend and frontend |
| `qa/harness-plan.md` | QA | Test strategy and harness steps |
| `reports/<issue>-<role>.md` | each role | Final report for an issue |
