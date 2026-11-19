import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

// Built output is a Pomade app folder: index.html + manifest.json + assets, relative URLs.
export default defineConfig({
  root: here,
  base: "./",
  resolve: {
    alias: {
      "pomade-kit/sdk": fileURLToPath(new URL("../../src/sdk/index.ts", import.meta.url)),
      "pomade-kit/protocol": fileURLToPath(new URL("../../src/protocol/index.ts", import.meta.url)),
      "pomade-kit/tokens.css": fileURLToPath(new URL("../../src/tokens/tokens.css", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
