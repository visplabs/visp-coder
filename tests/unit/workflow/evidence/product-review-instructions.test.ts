import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { runProductCritic } from "../../../../src/workflow/product/critic/critic.js";
import { criticPacket } from "../../../../src/workflow/product/critic/critic-packet.js";
import {
  criticSelection,
  readCriticState,
} from "../../../../src/workflow/product/critic/critic-store.js";
import { runProductVerify, runProductWork } from "../../../../src/workflow/product/index.js";
import { independentReviewTemplate } from "../../../../src/workflow/product/review/independent-review.js";
import {
  CRITIC_INSTRUCTIONS,
  productReviewInstructions,
} from "../../../../src/workflow/product/review/review-instructions.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review/review-request.js";
import { runProductReviewerHandoff } from "../../../../src/workflow/product/review/reviewer-handoff.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.workspace.destroy();
});

async function ready(images: boolean) {
  const project = await productWorkspace({ critic: true });
  projects.push(project);
  const w = project.workspace;
  expect((await runProductWork(await w.state())).ok).toBe(true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await w.state())).ok).toBe(true);
  expect(
    (
      await runProductCritic(await w.state(), {
        operation: "configure",
        task: "T001",
        config: balancedCritic("codex"),
      })
    ).ok,
  ).toBe(true);
  if (images) await recordedProductJourney(w, "review-images");
  return w.state();
}

it("delivers the same product rubric through native, prepared and host review", async () => {
  const workspace = await ready(true);
  const ambiguities = [
    {
      quote: "Blank lines are ignored.",
      readings: ["Only empty lines", "Empty and whitespace-only lines"],
      conventionalReading: "Empty and whitespace-only lines",
    },
  ];
  await writeFile(
    workspace.paths.featureFile(workspace.status?.activeFeature ?? "", "acceptance-tests.json"),
    JSON.stringify({
      version: 1,
      status: "declined",
      startedAt: new Date().toISOString(),
      ambiguities,
    }),
  );
  const handoff = await runProductReviewerHandoff(workspace, { task: "T001" });
  const selected = await criticSelection(workspace, { task: "T001" });
  if (!handoff.ok || !selected.ok) throw new Error("Missing review setup");
  const state = await readCriticState(workspace, selected.value);
  if (!state.ok || !state.value.state) throw new Error("Missing critic state");
  const native = await criticPacket(workspace, selected.value, state.value.state, handoff.value);
  if (!native.ok) throw new Error(native.error.message);
  const prepared = await runProductReviewRequest(workspace, { task: "T001", prepare: true });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const packet = JSON.parse(
    await readFile((prepared.value as { packetPath: string }).packetPath, "utf8"),
  );
  let delivered: unknown;
  await runProductReviewRequest(
    workspace,
    { task: "T001", dispatch: true },
    {
      model: "test-reviewer",
      review: async (request) => {
        delivered = request;
        return independentReviewTemplate();
      },
    },
  );
  expect(packet.instructions).toBe(native.value.instructions);
  expect(delivered).toMatchObject({ instructions: native.value.instructions });
  for (const input of [packet, delivered, native.value.current])
    expect(input).toMatchObject({ ambiguities });
  expect(packet.instructions).toContain("deliberate, conventional choice");
  expect(packet.instructions).toContain("visual quality");
  expect(packet.instructions).toContain("composition");
  expect(packet.instructions).toContain(
    "consecutive images of the same action can show a contradiction",
  );
  expect(packet.instructions).toContain("preview's origin and direction");
  expect(packet.instructions).toContain("Finish findings are always required: false");
  expect(packet.images.length).toBeGreaterThan(0);
  for (const input of [packet, delivered, native.value.current]) {
    for (const key of ["feedbackPlan", "agenda", "previousFindings", "challenges"])
      expect(input).not.toHaveProperty(key);
  }
  expect(native.value.current).not.toHaveProperty("instructions");
});

it("does not give source-only or design consultations rendered-product instructions", async () => {
  const workspace = await ready(true);
  const handoff = await runProductReviewerHandoff(workspace, { task: "T001" });
  if (!handoff.ok) throw new Error(handoff.error.message);
  for (const phase of ["product", "understanding"] as const) {
    const selected = await criticSelection(workspace, { task: "T001", phase });
    if (!selected.ok) throw new Error(selected.error.message);
    const state = await readCriticState(workspace, selected.value);
    if (!state.ok || !state.value.state) throw new Error("Missing critic state");
    const packet = await criticPacket(
      workspace,
      selected.value,
      state.value.state,
      handoff.value,
      undefined,
      phase === "product",
    );
    if (!packet.ok) throw new Error(packet.error.message);
    expect(packet.value.instructions).not.toContain("visual quality");
    expect(packet.value.instructions).not.toContain("preview's origin");
    expect(packet.value.instructions).not.toContain("judge finish once");
    expect(packet.value.instructions).toContain("assessments:[]");
    expect(packet.value.instructions).toContain("resolutions:[]");
    expect(packet.value.current).not.toHaveProperty("instructions");
    if (phase === "product") expect(packet.value.current.images).toEqual([]);
  }
});

it("keeps UI-specific advice out of a nonvisual module review", async () => {
  const workspace = await ready(false);
  const prepared = await runProductReviewRequest(workspace, { task: "T001", prepare: true });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const packet = JSON.parse(
    await readFile((prepared.value as { packetPath: string }).packetPath, "utf8"),
  );
  expect(packet.instructions).toEqual(expect.any(String));
  expect(packet.instructions).not.toContain("visual quality");
  expect(packet.instructions).not.toContain("preview's origin");
  expect(packet.instructions).not.toContain("judge finish once");
});

it("asks for a preview to be compared across consecutive images and required only on a promise", () => {
  const visual = productReviewInstructions({ visual: true });
  expect(visual).toContain("One still image cannot prove motion or interaction");
  expect(visual).toContain("Name the two images and the visible offset");
  expect(visual).toContain(
    "Mark such a finding required only when the request promises the preview",
  );
  expect(visual).toContain("list the missing observation instead of inferring a mismatch");
  expect(productReviewInstructions()).not.toContain("preview's origin");
});

it("asks for one optional finish finding that can never fail an outcome", () => {
  const visual = productReviewInstructions({ visual: true });
  expect(visual).toContain(
    "also judge finish once, as at most one finding after any required ones",
  );
  expect(visual).toContain("When requestPromises mention a game, play or a rich look");
  expect(visual).toContain("omit it when three findings are already required");
  expect(visual).toContain("compare the units");
  expect(visual).toContain("Name the image and two concrete visible improvements");
  expect(visual).toContain(
    "Finish findings are always required: false; never mark one required and never let one fail an outcome.",
  );
  expect(productReviewInstructions()).not.toContain("judge finish once");
});

it("requires what the request names to be recognizable in the images, unlike finish", () => {
  const visual = productReviewInstructions({ visual: true });
  expect(visual).toContain(
    "Recognizability is not finish and overrides the finish rule: every object or subject the request names for a picture or screen to show, and every concrete look it names (named colours or palette, a named art style such as pixel art, voxel or isometric, a viewpoint), must be recognizable",
  );
  // "A clean, modern design" or "a polished game" is never a required, outcome-failing finding.
  expect(visual).toContain(
    "evaluative words (modern, clean, beautiful, polished) stay finish or advisory",
  );
  // Finish no longer lists what the recognizability rule makes required.
  expect(visual).toContain(
    "for what the request describes (materials or texture, depth, visible feedback for hits or changes)",
  );
  expect(visual).not.toContain("recognizable objects");
  expect(visual).toContain(
    "missing, hidden behind something else, cut off, or reads as something different is a departure from the request",
  );
  expect(visual).toContain("do not mark an outcome that covers it satisfied");
  // A named real thing is recognized by its parts: in six benchmark runs reviewers who saw a
  // controller with no two-tone shell, shoulder buttons or logo called it "generic" as an optional
  // finding, and the blind judge marked each missing part down.
  expect(visual).toContain(
    "A real thing it names for a picture or scene to depict (a product or model, vehicle, animal, building, landmark) is recognized by its identifying parts and colouring",
  );
  // One finding per thing, so missing parts cannot fill every finding slot.
  expect(visual).toContain("report one required finding per thing, naming every such part");
  // A style the request names may leave parts or colours out on purpose.
  expect(visual).toContain(
    "left out by a style the request names (a minimalist logo, an icon, a silhouette), stays finish while the thing stays recognizable, and colours or a style the request names override the real thing's",
  );
  expect(visual).toContain("Only what the request names counts:");
  // Ordinary apps name no visual subjects: the rule adds nothing for their controls.
  expect(visual).toContain(
    "an app's controls, forms and data tables fall under the criteria above, and polish beyond what the request names stays finish.",
  );
  // Without images there is nothing to recognize; code review keeps its own rules.
  expect(productReviewInstructions()).not.toContain("Recognizability");
});

it("lets a specific request statement govern a case a general rule also covers", () => {
  expect(CRITIC_INSTRUCTIONS).toContain(
    "an implementation that makes it impossible for that option to match or apply under those conditions is a required finding",
  );
});

it("requires findings for weakened existing tests unless the request changes their behavior", () => {
  expect(CRITIC_INSTRUCTIONS).toContain(
    "Edits that weaken, skip, delete or deselect existing tests, whether in test files or check commands, are required findings unless the request changes that behavior",
  );
  expect(CRITIC_INSTRUCTIONS).toContain("when it does, quote the request sentence");
});
