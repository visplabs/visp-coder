import { expect, it } from "vitest";
import { errorReportingDsn } from "../../../src/telemetry/error-reporting.js";

it("reports only to a DSN given in VISP_SENTRY_DSN", () => {
  expect(errorReportingDsn({})).toBeUndefined();
  expect(errorReportingDsn({ VISP_SENTRY_DSN: "  " })).toBeUndefined();
  expect(errorReportingDsn({ VISP_SENTRY_DSN: " https://key@o1.ingest.sentry.io/2 " })).toBe(
    "https://key@o1.ingest.sentry.io/2",
  );
});

it("ignores SENTRY_DSN, which belongs to the product being built", () => {
  expect(errorReportingDsn({ SENTRY_DSN: "https://key@o1.ingest.sentry.io/2" })).toBeUndefined();
});
