import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const rampToWeek4 = process.env.COVERAGE_RAMP === "week4";
const thresholds = rampToWeek4
  ? { lines: 60, branches: 45, functions: 60, statements: 60 }
  : { lines: 35, branches: 25, functions: 35, statements: 35 };

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler"]],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/main.tsx"],
      thresholds,
    },
  },
});
