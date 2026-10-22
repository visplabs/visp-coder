import { describe, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import { err, ok } from "../../../../src/core/result.js";
import {
  inspectReviewImages,
  type ProductReviewCapture,
} from "../../../../src/workflow/evidence/product-review.js";
import { inspectProductImages } from "../../../../src/workflow/product/images.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { pngHeader } from "../../support/workspace.js";

const bytes = pngHeader(1280, 720),
  digest = "a".repeat(64);
const capture: ProductReviewCapture = {
  id: "capture-one",
  path: ".visp/capture.png",
  sha256: sha256(bytes),
  subjectDigest: digest,
  route: "/User/Alice",
  steps: ["Navigate", "Click launch"],
  viewport: { width: 1280, height: 720 },
  createdAt: "2026-01-01T00:00:00Z",
  provenance: "runner-captured",
};

describe("product image delivery", () => {
  it("prefers newly captured states over images appended from an older review", async () => {
    const workspace = {
      files: { readBytesIfExists: async () => ok(bytes) },
    } as unknown as WorkspaceState;
    const newer = Array.from({ length: 6 }, (_, index) => ({
      ...capture,
      id: `new-${index}`,
      createdAt: "2026-02-01T00:00:00Z",
    }));
    const older = Array.from({ length: 6 }, (_, index) => ({ ...capture, id: `old-${index}` }));
    const result = await inspectProductImages(workspace, digest, [...newer, ...older]);
    expect(result.images.map((image) => image.id).every((id) => id.startsWith("new-"))).toBe(true);
  });
  it("keeps a preferred journey intact, filters malformed entries and preserves stale or inaccessible gaps", async () => {
    const workspace = {
      files: {
        readBytesIfExists: async (path: string) =>
          path === "blocked.png" ? err({ code: "IO_ERROR", message: "refused" }) : ok(bytes),
      },
    } as unknown as WorkspaceState;
    const preferred = ["before", "during", "after"].map((id) => ({
      ...capture,
      id,
      createdAt: "invalid legacy date",
    }));
    const others = Array.from({ length: 6 }, (_, index) => ({
      ...capture,
      id: `other-${index}`,
      createdAt: "2026-03-01",
    }));
    const result = await inspectProductImages(
      workspace,
      digest,
      [
        null,
        {},
        ...others,
        ...preferred,
        { ...capture, id: "stale", subjectDigest: "old" },
        preferred[0],
      ],
      preferred.map((entry) => entry.id),
    );
    expect(
      result.images
        .slice(0, 3)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["after", "before", "during"]);
    expect(result.images).toHaveLength(6);
    expect(result.gaps.some((gap) => gap.includes("different product version"))).toBe(true);
    const inaccessible = await inspectProductImages(workspace, digest, [
      { ...capture, path: "blocked.png" },
    ]);
    expect(inaccessible.images).toEqual([]);
    expect(inaccessible.gaps.join()).toContain("missing");
  });
  it("delivers actual bytes with provenance without inventing a passing assessment", async () => {
    const bundle = await inspectReviewImages({
      subjectDigest: digest,
      captures: [capture],
      readBytes: async () => bytes,
    });
    expect(bundle.images[0]).toMatchObject({
      data: bytes.toString("base64"),
      mimeType: "image/png",
      provenance: "runner-captured",
    });
    expect(bundle.gaps).toEqual([]);
    expect(bundle).not.toHaveProperty("passed");
    expect(bundle.images[0]).not.toHaveProperty("assessment");
  });
  it.each([
    ["missing", undefined, capture],
    ["changed", Buffer.from("changed"), capture],
    ["stale", bytes, { ...capture, subjectDigest: "b".repeat(64) }],
    ["unreproduced", bytes, { ...capture, steps: [] }],
  ])("keeps %s captures as review gaps", async (_name, data, item) => {
    const bundle = await inspectReviewImages({
      subjectDigest: digest,
      captures: [item],
      readBytes: async () => data,
    });
    expect(bundle.images).toEqual([]);
    expect(bundle.gaps.length).toBeGreaterThan(0);
  });
  it("bounds delivery independently of capture claims", async () => {
    const bundle = await inspectReviewImages({
      subjectDigest: digest,
      captures: Array.from({ length: 8 }, (_, i) => ({ ...capture, id: String(i) })),
      readBytes: async () => bytes,
    });
    expect(bundle.images).toHaveLength(6);
    expect(bundle.gaps).toHaveLength(2);
  });
  it("reports inaccessible, oversized, malformed and invalid viewport captures without delivery", async () => {
    for (const [data, extra] of [
      [Buffer.alloc(4 * 1024 * 1024 + 1), {}],
      [Buffer.from("not image bytes"), {}],
      [bytes, { route: " " }],
      [bytes, { viewport: { width: 0, height: 720 } }],
      [bytes, { viewport: { width: 1280, height: 0 } }],
    ] as const) {
      const result = await inspectReviewImages({
        subjectDigest: digest,
        captures: [{ ...capture, ...extra, sha256: sha256(data) }],
        readBytes: async () => data,
      });
      expect(result.images).toEqual([]);
      expect(result.gaps.length).toBeGreaterThan(0);
    }
    const unreadable = await inspectReviewImages({
      subjectDigest: digest,
      captures: [capture],
      readBytes: async () => {
        throw new Error("confined reader refused");
      },
    });
    expect(unreadable.images).toEqual([]);
  });
  it("delivers supported GIF pixels with the proper media type", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const result = await inspectReviewImages({
      subjectDigest: digest,
      captures: [{ ...capture, sha256: sha256(gif) }],
      readBytes: async () => gif,
    });
    expect(result.images[0]?.mimeType).toBe("image/gif");
  });
});

it("reserves a current image for each ungrouped viewport despite desktop preferences", async () => {
  const workspace = {
    files: { readBytesIfExists: async () => ok(bytes) },
  } as unknown as WorkspaceState;
  const desktop = Array.from({ length: 6 }, (_, index) => ({ ...capture, id: `desktop-${index}` }));
  const phone = { ...capture, id: "phone", viewport: { width: 390, height: 844 } };
  const result = await inspectProductImages(
    workspace,
    digest,
    [...desktop, phone],
    desktop.map((item) => item.id),
  );
  expect(result.images).toHaveLength(6);
  expect(result.images.some((image) => image.id === "phone")).toBe(true);
  expect(result.gaps.join()).toContain("omitted");
});

it("reports declared viewports without available current captures", async () => {
  const { productBriefSchema, initialProductState } = await import(
    "../../../../src/workflow/product/model.js"
  );
  const { inspectSelectedImages } = await import(
    "../../../../src/workflow/product/review/review-selection.js"
  );
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-viewports",
    goal: "Responsive UI",
    originalRequest: "Responsive UI",
    outcomes: [
      {
        id: "O001",
        kind: "experience",
        statement: "Readable on phones",
        expectations: [
          { id: "E001", statement: "Phone screen", viewport: { width: 390, height: 844 } },
        ],
      },
    ],
  });
  const record = { brief, briefText: "", stateText: "", state: initialProductState(brief, "now") };
  const workspace = {
    files: { readBytesIfExists: async () => ok(bytes) },
  } as unknown as WorkspaceState;
  const result = await inspectSelectedImages(
    workspace,
    record,
    {},
    digest,
    undefined,
    [capture],
    [],
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.gaps.join()).toContain(
      "Viewport 390x844: no current representative capture available",
    );
});

it("keeps declared viewport gaps in packets for functional browser checks", async () => {
  const { productBriefSchema, initialProductState } = await import(
    "../../../../src/workflow/product/model.js"
  );
  const { inspectSelectedImages, reviewImageGaps } = await import(
    "../../../../src/workflow/product/review/review-selection.js"
  );
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-functional-viewport",
    goal: "Browser action",
    originalRequest: "Browser action",
    outcomes: [{ id: "O001", kind: "functional", statement: "The browser action succeeds" }],
    checks: [
      {
        id: "C001",
        outcomes: ["O001"],
        command: {
          kind: "browser-journey",
          journey: {
            url: "project:/index.html",
            viewport: { width: 390, height: 844 },
            actions: [{ kind: "wait", durationMs: 1 }],
          },
        },
      },
    ],
  });
  const record = { brief, briefText: "", stateText: "", state: initialProductState(brief, "now") };
  const workspace = {
    files: { readBytesIfExists: async () => ok(undefined) },
  } as unknown as WorkspaceState;
  const result = await inspectSelectedImages(workspace, record, {}, digest, undefined, [], []);
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(reviewImageGaps(brief.outcomes, result.value.gaps, false).join()).toContain(
      "Viewport 390x844: no current representative capture available",
    );
});
