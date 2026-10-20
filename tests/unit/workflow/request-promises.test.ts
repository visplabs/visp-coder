import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { experiencePromises, hasUiIntent } from "../../../src/workflow/product/request-promises.js";

const root = process.cwd();
const tasks = join(root, "bench/tasks");
const text = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
/** The calibration prompts wrap the request in “…”. */
const quoted = (prompt: string) => prompt.slice(prompt.indexOf("“") + 1, prompt.lastIndexOf("”"));
const catapult = quoted(text("tests/fixtures/review-calibration/catapult-preview/prompt.md"));
/** Task and session prompts only; hidden checks are never read. */
const PROMPT_FILES = [
  "task.md",
  "session1.md",
  "session2.md",
  "conventions.md",
  "noise.md",
  "intermediate.md",
];
const promptsOf = (task: string) =>
  PROMPT_FILES.filter((file) => existsSync(join(tasks, task, file))).map((file) => ({
    name: `${task}/${file}`,
    body: text("bench/tasks", task, file),
  }));

describe("request promises", () => {
  it("quotes the look, feel and preview sentences of the catapult request", () => {
    const promises = experiencePromises(catapult);
    expect(promises).toHaveLength(3);
    expect(promises[0]).toContain("in the spirit of Angry Birds");
    expect(promises[1]).toBe(
      "While dragging, show the pull and a short dotted preview of the first part of the flight.",
    );
    expect(promises[2]).toMatch(/^Make it look and feel like a game/);
  });

  it("finds the style and look-and-feel sentences of the slingshot task", () => {
    expect(experiencePromises(text("bench/tasks/slingshot-game/task.md"))).toEqual([
      "Build a small Angry Birds–style slingshot game that runs in a web browser.",
      expect.stringMatching(/^Make it look and feel like a game/),
    ]);
  });

  it("falls back to weak cues only when no sentence has a strong one", () => {
    expect(experiencePromises("Runs in a browser. Make a small game. Keep the code tidy.")).toEqual(
      ["Make a small game."],
    );
    expect(
      experiencePromises(quoted(text("tests/fixtures/review-calibration/fowl-play/prompt.md"))),
    ).toEqual(["Make a browser game like Angry Birds.", "Make it fun."]);
    for (const fixture of ["orbital-flock", "feather-fury"]) {
      const request = /^originalRequest: (.*)$/m.exec(
        text("tests/fixtures/product-quality", fixture, "brief.yaml"),
      )?.[1] as string;
      expect(experiencePromises(request)).toEqual([request]);
    }
  });

  it("returns nothing without a UI intent or without a promising sentence", () => {
    expect(hasUiIntent("Export the report as CSV.")).toBe(false);
    expect(experiencePromises("Make the output human readable and fun to read.")).toEqual([]);
    expect(experiencePromises("Build a dashboard with a table of orders.")).toEqual([]);
    expect(experiencePromises("")).toEqual([]);
  });

  it("caps the number and length of sentences and quotes verbatim substrings", () => {
    const long = `A polished browser game ${"with many details ".repeat(60)}ends here.`;
    const request = [
      long,
      "The web app should look and feel like a real product.",
      "Animations are welcome.",
      "It should feel like Tetris.",
    ].join("\n");
    const promises = experiencePromises(request);
    expect(promises).toHaveLength(3);
    expect(promises.every((entry) => entry.length <= 400)).toBe(true);
    for (const entry of promises) expect(request).toContain(entry);
    expect(experiencePromises(request, 1)).toHaveLength(1);
  });

  it("strips list markers but keeps the words", () => {
    const request =
      "The html page must be simple.\n- It should feel like a native app.\n2) Animated transitions.";
    expect(experiencePromises(request)).toEqual([
      "It should feel like a native app.",
      "Animated transitions.",
    ]);
  });

  describe("over the benchmark task texts", () => {
    const uiTasks = ["slingshot-game", "catapult-game"];
    // The Xbox SVG request asks for polish and a "modern" look, which reads as an experience promise.
    const picture = ["xbox-controller-svg"];
    const quiet = readdirSync(tasks).filter(
      (name) => !uiTasks.includes(name) && !picture.includes(name),
    );

    it("hits only the UI tasks", () => {
      for (const task of uiTasks)
        for (const prompt of promptsOf(task))
          expect(hasUiIntent(prompt.body), prompt.name).toBe(true);
      expect(hasUiIntent(catapult)).toBe(true);
    });

    it("finds nothing in the API, CLI and carryover task and session texts", () => {
      const prompts = quiet.flatMap(promptsOf);
      expect(prompts.length).toBeGreaterThan(10);
      for (const prompt of prompts)
        expect(experiencePromises(prompt.body), prompt.name).toEqual([]);
    });
  });
});
