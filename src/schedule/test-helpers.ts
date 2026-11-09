// Run a describe block's tests in an IANA time zone: Node re-reads `process.env.TZ` on
// assignment, so the engine's local-time Date APIs follow it.

import { afterAll, beforeAll } from "vitest";

export function useTimeZone(tz: string): void {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}
