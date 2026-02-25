# Testing Guide

## Test Matrix

| Scope | Location | Runner/Config | Command |
|---|---|---|---|
| Server unit | `server/test/unit/**` | Vitest (`server/vitest.config.ts`) | `npm --prefix server run test:unit` |
| Server integration | `server/test/integration/**` | Vitest (`server/vitest.config.ts`) | `npm --prefix server run test:integration` |
| Server live smoke | `server/test/live/**` | Vitest (`server/vitest.config.ts`) | `npm --prefix server run test:live` |
| Client unit | `src/**/*.test.ts(x)` | Vitest (`vitest.config.ts`, jsdom + RTL) | `npm run test:unit:client` |
| E2E | `test/e2e/**` | Playwright (`playwright.config.ts`) | `npm run test:e2e` |

## Primary Commands

- `npm run test:unit` — server + client unit
- `npm run test:integration` — server integration
- `npm run test:live` — server live smoke (read-only; env-gated)
- `npm run test:e2e` — Playwright e2e
- `npm run test:coverage` — server + client coverage

## Rule of Thumb

Use `npm run ...`, not raw `npx vitest`.  
`npx vitest` can pick the wrong config based on cwd.

## CI Split

- Job A: unit (server + client)
- Job B: integration + selected e2e
- Job C: live smoke (PR, read-only, short timeout budget)

## Troubleshooting

- Missing tools: run `npm install`
- Peer dependency issues: use lockfile + `npm ci`
- E2E failure diagnostics:  
  `npx playwright show-trace test-results/playwright/<trace.zip>`
