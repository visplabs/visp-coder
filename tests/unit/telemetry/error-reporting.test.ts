import { expect, it } from "vitest";
import { errorReportingDsn, errorReportingTags } from "../../../src/telemetry/error-reporting.js";

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

it("tags reports with the run named in VISP_SENTRY_TAGS and drops malformed pairs", () => {
  expect(errorReportingTags({})).toEqual({});
  expect(
    errorReportingTags({
      VISP_SENTRY_TAGS: "feature=F-12, task=T-13,run_id=qe-20261104T101530Z,commit=8b3b3679",
    }),
  ).toEqual({ feature: "F-12", task: "T-13", run_id: "qe-20261104T101530Z", commit: "8b3b3679" });
  expect(errorReportingTags({ VISP_SENTRY_TAGS: "Bad Key=x,empty=,ok=1,secret=a b" })).toEqual({
    ok: "1",
  });
});
