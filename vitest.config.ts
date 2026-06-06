import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/ui/**/*.test.ts"],
    setupFiles: ["./src/ui/vitest-setup.ts"],
    server: {
      deps: {
        inline: ["foldkit"],
      },
    },
  },
});
