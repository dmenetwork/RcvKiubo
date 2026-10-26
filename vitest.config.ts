import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "email-worker/**/*.test.ts"],
    // Los tests de integración comparten una base y la truncan: en serie (ver package.json).
    testTimeout: 20_000,
  },
});
