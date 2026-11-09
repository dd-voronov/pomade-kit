import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Serves the fake-host harness page; the app under test is served separately (another origin).
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
  resolve: {
    alias: {
      "pomade-kit/fake-host": fileURLToPath(new URL("../src/fake-host/index.ts", import.meta.url)),
    },
  },
});
