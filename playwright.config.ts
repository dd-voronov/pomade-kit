import { defineConfig, devices } from "@playwright/test";

const APP_PORT = 4317;
const HARNESS_PORT = 4318;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"] },
  webServer: [
    {
      command: `npm run hello:build && npx vite preview --config examples/hello/vite.config.ts --port ${APP_PORT} --strictPort`,
      url: `http://localhost:${APP_PORT}/manifest.json`,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --config e2e/vite.config.ts --port ${HARNESS_PORT} --strictPort`,
      url: `http://localhost:${HARNESS_PORT}/harness.html`,
      reuseExistingServer: false,
    },
  ],
});
