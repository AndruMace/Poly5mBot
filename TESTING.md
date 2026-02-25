# Testing Guide

This repository has two Vitest contexts:

- Backend/server tests (`server/test/**`) using `server/vitest.config.ts`
- Frontend/client tests (`src/**/*.test.ts(x)`) using root `vitest.config.ts`

Use the npm scripts below to avoid running the wrong config by accident.

## Quick Commands

- `npm run test:unit`
  - Runs both server + client unit suites
- `npm run test:integration`
  - Runs server integration tests
- `npm run test:live`
  - Runs server live smoke tests (read-only external checks; often gated by env)
- `npm run test:e2e`
  - Runs Playwright e2e tests
- `npm run test:coverage`
  - Runs coverage for server and client

## Server Tests

Location:
- `server/test/unit/**`
- `server/test/integration/**`
- `server/test/live/**`

Commands:
- `npm --prefix server run test:unit`
- `npm --prefix server run test:integration`
- `npm --prefix server run test:live`

Notes:
- Uses `server/vitest.config.ts`
- Node/effect backend context (not jsdom)

## Client Tests

Location:
- `src/**/*.test.ts`
- `src/**/*.test.tsx`

Command:
- `npm run test:unit:client`

Notes:
- Uses root `vitest.config.ts`
- jsdom + React Testing Library context

## E2E Tests

Location:
- `test/e2e/**`

Command:
- `npm run test:e2e`

Notes:
- Uses `playwright.config.ts`
- Chromium-only for now
- Includes mocked WS/API flows for deterministic checks

## Why `npx vitest` Can Be Confusing

Running `npx vitest` directly will use the current working directory and whichever config it finds first.  
That can unintentionally run the wrong suite (server vs client) or miss tests.

Preferred rule:
- Use repository scripts (`npm run ...`) instead of raw `npx vitest`.

## CI Layout

Current CI split:
- Job A: unit (server + client)
- Job B: integration + selected e2e
- Job C: live smoke (PR, read-only, short timeout budget)

## Troubleshooting

- Missing `vitest` / `playwright` command:
  - Install root deps: `npm install` (or `bun install` if using Bun consistently)
- Peer dependency conflicts:
  - Use the committed lockfile and `npm ci` for reproducible installs
- Flaky e2e:
  - Re-run with traces and inspect:
    - `npx playwright show-trace test-results/playwright/<trace.zip>`