// A stand-in for the Jira Cloud REST API, run as its own process so hooks started with
// spawnSync can reach it. State lives in <dir>/state.json and is re-read on every request, so a
// test can change it between calls. Every request is appended to <dir>/calls.jsonl. Prints the
// port it listens on, then serves until killed.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const dir = process.argv[2];
const statePath = join(dir, "state.json");
const load = () =>
  existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { issues: {}, comments: {}, changelog: {}, next: 20 };
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const url = new URL(req.url, "http://fake");
  appendFileSync(
    join(dir, "calls.jsonl"),
    `${JSON.stringify({ method: req.method, path: url.pathname, auth: req.headers.authorization, body })}\n`,
  );
  const state = load();
  const send = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(value === undefined ? "" : JSON.stringify(value));
  };
  // The credential "rejected@example.com:x" stands for a token Jira refuses (pilot 2's unscoped
  // token at the api.atlassian.com gateway answered 401).
  const rejected = `Basic ${Buffer.from("rejected@example.com:x").toString("base64")}`;
  if (req.headers.authorization === rejected) return send(401, { message: "Unauthorized" });
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && parts[3] === "project") return send(200, { key: "VISP" });
  const key = parts[4];
  const issue = state.issues[key];
  if (req.method === "POST" && url.pathname === "/rest/api/3/search/jql") {
    const parent = body.jql.match(/parent = (\S+)/)?.[1];
    const type = body.jql.match(/issuetype = (\S+)/)?.[1];
    const issues = Object.values(state.issues).filter(
      (i) => i.fields.parent?.key === parent && i.fields.issuetype?.id === type,
    );
    return send(200, { issues });
  }
  if (req.method === "POST" && url.pathname === "/rest/api/3/issue") {
    const newKey = `${state.prefix ?? "VISP-"}${state.next++}`;
    state.issues[newKey] = {
      key: newKey,
      fields: {
        ...body.fields,
        parent: body.fields.parent,
        status: { id: "10021" },
        updated: "2026-11-07T10:00:00.000+0000",
      },
    };
    save(state);
    return send(201, { key: newKey });
  }
  if (!issue) return send(404, { errorMessages: [`no issue ${key}`] });
  const sub = parts[5];
  if (req.method === "GET" && !sub) return send(200, issue);
  if (req.method === "PUT" && !sub) {
    Object.assign(issue.fields, body.fields, { updated: "2026-11-07T11:00:00.000+0000" });
    state.changelog[key] = [
      ...(state.changelog[key] ?? []),
      { created: "2026-11-07T11:00:00.000+0000", items: [{ field: "description" }] },
    ];
    save(state);
    return send(204);
  }
  if (sub === "comment" && req.method === "GET") {
    return send(200, { comments: state.comments[key] ?? [] });
  }
  if (sub === "comment" && req.method === "POST") {
    state.comments[key] = [...(state.comments[key] ?? []), { id: "c-new", body: body.body }];
    save(state);
    return send(201, {});
  }
  if (sub === "changelog") {
    return send(200, { values: state.changelog[key] ?? [], isLast: true });
  }
  if (sub === "transitions" && req.method === "GET") {
    const ids = ["10021", "10022", "3", "10023", "10013"];
    return send(200, { transitions: ids.map((id) => ({ id: `t${id}`, to: { id } })) });
  }
  if (sub === "transitions" && req.method === "POST") {
    issue.fields.status = { id: body.transition.id.slice(1) };
    save(state);
    return send(204);
  }
  return send(404, { errorMessages: [`no route ${req.method} ${url.pathname}`] });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
