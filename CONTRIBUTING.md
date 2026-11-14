# Contributing - AT Protocol project

Short version: branch off `main`, one small PR per change, someone else reviews, CI green, squash merge.

## Status

The workflow rules below (branching, PRs, reviews, titles) apply from day one. The commands, hooks, and checks are the planned toolchain - each one exists only once the tooling that provides it lands, and this guide gets updated as they do.

## Setup

- Use Node.js 22.19 or newer (`node -v` to check).
- Run `npm install` once package.json exists. The tooling setup adds a pre-commit hook that formats the files you commit.
- Run `npx playwright install chromium` once, so `npm run test:e2e` has a browser.

## Workflow

1. Branch from `main`, named `yourname/short-topic`.
2. Keep each PR to one responsibility. Split mixed work into separate PRs (for example, keep config-only changes separate from implementation).
3. Run the local checks below.
4. Open a PR and fill in the template. Title it with a conventional commit: `type: short summary` (feat, fix, docs, test, refactor, chore, ci). The PR title becomes the commit message on `main`.
5. Get one approving review from someone who is not the author. Requested changes block merging until resolved.
6. Squash merge, then delete the branch.

Once branch protection is on (planned), direct pushes to `main` are disabled and the test and e2e checks must pass before a merge. The repo admin can override in an edge case; ask with your reason.

## Decisions

Significant technology or design decisions get an ADR in docs/adr/ - use docs/adr/0000-template.md. Write one when you pick a technology (framework, styling, library) or hit a problem the design document did not anticipate.

## User stories and tests

New capabilities start as user-story issues (use the User story template) and each story names the Playwright e2e test that proves it. A story is not done until its e2e mapping exists.

## Local checks

```
npm run lint           # ESLint
npm run typecheck      # TypeScript type check (tsc)
npm run docs           # TypeDoc API site in dist/docs
npm test               # unit tests
npm run test:coverage  # unit tests + coverage baseline check
npm run test:integration  # integration tests; needs `npm run stack:up` first
npm run test:e2e       # Playwright browser tests
npm run format:check   # Prettier check only
```

- Coverage: the baseline in `coverage-baseline.json` is a ratchet. CI fails if a number drops. If your change raises coverage, copy the `Current:` numbers from the output into the baseline and commit it with your PR.
- Formatting: the pre-commit hook formats staged files, so you usually do not need to run Prettier yourself. CI also runs the format check and fails on unformatted files.

## Code style

- Formatting: Prettier default style (double quotes, semicolons, 2-space indent), enforced in CI. ESLint does not check formatting.
- ESLint recommended rules, plus always `===` and `!==` (`eqeqeq`) and no `console` in app code (`no-console`). The server, tests, and tooling may log. Per-file exceptions live in `eslint.config.js`.
- TypeScript in strict mode everywhere (see docs/adr/0001-typescript-monorepo.md). `npm run typecheck` runs `tsc` in CI.
- JSDoc comments on new or changed functions (also in the PR template checklist). Write types in TypeScript, not JSDoc tags.
