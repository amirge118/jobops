# Contributing

Thank you for improving jobOps. Keep changes small, local-first, and easy to verify.

## Setup and checks

```bash
npm ci
npx playwright install chromium
npm run setup
npm run doctor
npm run check
npm test
npm run scan:dry
```

`npm run scan:dry` uses live public ATS endpoints and may fail when a provider is temporarily
unavailable. Syntax checks and unit tests must pass without private data or credentials. Tests
mock `codex exec`; CI must not require a developer's ChatGPT session.

## Change guidelines

- Put reusable job logic under `scripts/jobs/` and keep `scripts/jobs.mjs` as orchestration.
- Add or update tests for behavioral changes.
- Do not make a missing programming language an automatic fit blocker.
- Keep report output minimal and do not add columns without a clear user need.
- Never automate final application submission.
- Do not commit `profile/`, `documents/`, `auth/`, `data/`, `reports/`, `.env`, or real group JIDs.
- Do not introduce a production dependency without documenting why it is needed.
- Keep scoring on the signed-in Codex CLI path; never silently fall back to an API key.

## Pull requests

Explain the user-visible outcome, tests run, and any remaining limitations. Before opening a
pull request, inspect the diff and run a redacted secret scan:

```bash
gitleaks dir . --redact
```

The repository's `.gitleaks.toml` excludes only the ignored `auth/` session directory, whose
files are credentials by definition. Secrets found anywhere in publishable source still fail the
scan.

Code adapted from third-party projects must retain compatible license notices and be reflected in
`THIRD_PARTY_NOTICES.md`.
