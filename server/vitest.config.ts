import { defineConfig } from "vitest/config";

const rampToWeek4 = process.env.COVERAGE_RAMP === "week4";
const thresholds = rampToWeek4
  ? { lines: 75, branches: 65, functions: 75, statements: 75 }
  : { lines: 55, branches: 45, functions: 55, statements: 55 };

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
      ],
      thresholds,
    },
  },
});
