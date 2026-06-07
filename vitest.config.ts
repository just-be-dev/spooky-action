import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    exclude: ["repos/**", "node_modules/**"],
    setupFiles: ["./src/ui/vitest-setup.ts"],
    server: {
      deps: {
        inline: ["foldkit"],
      },
    },
  },
});
