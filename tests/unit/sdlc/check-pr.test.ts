import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { featureBody, installFakeGh, setFakeIssue } from "./support/fake-gh.js";
import { type SdlcRepo, SPEC, sdlcRepo } from "./support/sdlc-repo.js";

const cli = join(process.cwd(), "scripts/sdlc/sdlc.mjs");
const { specHash } = (await import(
  pathToFileURL(join(process.cwd(), "scripts/sdlc/lib/hash.mjs")).href
)) as { specHash(intent: unknown, acceptance: unknown): string };

let fixture: SdlcRepo;
let gh = "";
const OWNER_TEXT = "Work log entries are separate timestamped files.";
const TEST = "tests/worklog.test.ts > worklog > writes one file";
const TEST_CASES = (SPEC["spec/test-cases.yml"] ?? "").replace(
  "criteria: [AC-01] }",
  `criteria: [AC-01], test: '${TEST}' }`,
);
const BLOCKS = [SPEC["spec/intent.yml"] ?? "", SPEC["spec/acceptance.yml"] ?? "", TEST_CASES];
const HASH = specHash(parse(BLOCKS[0] ?? ""), parse(BLOCKS[1] ?? ""));
const TASK_BODY = `\`\`\`yaml\n${SPEC["tasks/T-13/task.yml"]}\n\`\`\``;

type Comment = { login: string; body: string; createdAt: string; lastEditedAt?: string | null };

function approval(hash = HASH, login = "owner", createdAt = "2026-11-05T12:00:00Z"): Comment {
  return { login, body: `<!-- sdlc:approval -->\nSpec hash: \`${hash}\``, createdAt };
}

function setFeature(
  comments: Comment[],
  { body = featureBody(OWNER_TEXT, BLOCKS), editedAt = "2026-11-05T11:00:00Z" } = {},
) {
  const issue = {
    body,
    createdAt: "2026-11-05T10:00:00Z",
    lastEditedAt: editedAt,
    comments: {
      nodes: comments.map((c) => ({
        body: c.body,
        author: { login: c.login },
        createdAt: c.createdAt,
        lastEditedAt: c.lastEditedAt ?? null,
      })),
    },
  };
  writeFileSync(
    join(fixture.repo, "graphql-12.json"),
    JSON.stringify({ data: { repository: { issue } } }),
  );
}

function setPr(body: string, commitMessages: string[] = []) {
  const commits = commitMessages.map((message) => ({ messageHeadline: message, messageBody: "" }));
  writeFileSync(join(fixture.repo, "pr-104.json"), JSON.stringify({ body, commits }));
}

function setResults(status: string) {
  const report = {
    testResults: [
      {
        name: join(fixture.repo, "tests/worklog.test.ts"),
        assertionResults: [{ ancestorTitles: ["worklog"], title: "writes one file", status }],
      },
    ],
  };
  writeFileSync(join(fixture.repo, "results.json"), JSON.stringify(report));
}

function checkPr() {
  return spawnSync(process.execPath, [cli, "check-pr", "104", "--results", "results.json"], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env, SDLC_GH: gh, FAKE_DIR: fixture.repo, SDLC_OWNER_LOGIN: "owner" },
  });
}

describe("sdlc check-pr", () => {
  beforeEach(() => {
    fixture = sdlcRepo();
    gh = installFakeGh(fixture.repo);
    setFakeIssue(fixture.repo, 13, TASK_BODY, "Write worklog files");
    setFeature([approval()]);
    setPr("Adds the worklog.\n\nTask: #13");
    setResults("passed");
  });
  afterEach(() => fixture.cleanup());

  it("passes a task PR whose spec the owner approved and whose linked tests pass", () => {
    const result = checkPr();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("F-12/T-13");
    expect(result.stdout).toContain("pass");
  });

  it("finds the task line in a commit message too", () => {
    setPr("No trailer here.", ["feat: worklog\n\nTask: #13"]);
    expect(checkPr().status).toBe(0);
  });

  it("skips a pull request that names no task", () => {
    setPr("Dependency bump.");
    const result = checkPr();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped");
  });

  it("fails when only someone other than the owner approved", () => {
    setFeature([approval(HASH, "visp-agent")]);
    const result = checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no approval by owner");
  });

  it("fails when the approval was edited or is older than the last spec edit", () => {
    setFeature([{ ...approval(), lastEditedAt: "2026-11-05T12:30:00Z" }]);
    expect(checkPr().status).toBe(1);
    setFeature([approval()], { editedAt: "2026-11-05T13:00:00Z" });
    const result = checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("edited after");
  });

  it("fails when the spec no longer matches the approved hash", () => {
    setFeature([approval("0".repeat(64))]);
    const result = checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("hash");
  });

  it("fails when a linked test does not pass", () => {
    setResults("failed");
    const result = checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("failing");
  });

  it("fails when a criterion of the task has no linked test", () => {
    setFeature([approval(specHash(parse(BLOCKS[0] ?? ""), parse(BLOCKS[1] ?? "")))], {
      body: featureBody(OWNER_TEXT, [
        BLOCKS[0] ?? "",
        BLOCKS[1] ?? "",
        SPEC["spec/test-cases.yml"] ?? "",
      ]),
    });
    const result = checkPr();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("TC-01");
  });
});
