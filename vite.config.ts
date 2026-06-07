import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: 9988 })],
  optimizeDeps: {
    entries: ["src/ui/entry.ts"],
  },
  server: {
    proxy: {
      // The gesture lab backend (src/main.ts) owns the defs API; the
      // control WebSocket channel (src/control/websocket.ts) has its own
      // server bridging to the native overlay.
      "/api": "http://localhost:7900",
      "/ws": {
        target: "ws://localhost:7901",
        ws: true,
      },
    },
  },
});
