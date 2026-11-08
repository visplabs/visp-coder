// Jira Cloud REST calls for the SDLC, made as the agent bot user. Issue bodies cross as
// the markdown issue-body.mjs writes (see adf.mjs). The token comes from the OS keyring each
// time, as "email:token", through SDLC_SECRET_CMD (default: secret-tool). SDLC_JIRA_URL replaces
// the API base in tests; service-account tokens need the api.atlassian.com gateway form.

import { execFileSync } from "node:child_process";
import { adfToBody, bodyToAdf } from "./adf.mjs";
import { loadConfig } from "./config.mjs";

// Jira's limit for a text field; the document is measured as stored JSON, which is longer than
// its text, so a body that passes always fits.
const MAX_FIELD = 32_767;
const ISSUE_FIELDS = ["summary", "description", "status", "parent", "issuetype", "updated"];

export function jiraClient(cwd = process.cwd()) {
  const config = loadConfig(cwd);
  warnIfExpiring(config.jira.secret);
  const request = requester(config);
  const browse = (key) => `https://${config.jira.site}/browse/${key}`;
  const issue = (raw) => ({
    key: raw.key,
    title: raw.fields.summary,
    body: adfToBody(raw.fields.description),
    status: raw.fields.status?.id,
    type: raw.fields.issuetype?.id,
    parent: raw.fields.parent?.key,
    updated: raw.fields.updated,
    url: browse(raw.key),
  });

  return {
    config,
    async readIssue(key) {
      return issue(await request("GET", `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`));
    },
    async children(parentKey, typeId) {
      const jql = `parent = ${parentKey} AND issuetype = ${typeId} ORDER BY key ASC`;
      const found = await request("POST", "/rest/api/3/search/jql", {
        jql,
        fields: ISSUE_FIELDS,
        maxResults: 100,
      });
      return (found.issues ?? []).map(issue);
    },
    async writeBody(key, body) {
      await request("PUT", `/rest/api/3/issue/${key}`, { fields: { description: adf(body) } });
    },
    async createIssue({ type, summary, body, parent }) {
      const created = await request("POST", "/rest/api/3/issue", {
        fields: {
          project: { id: config.jira.project.id },
          issuetype: { id: type },
          summary,
          description: adf(body),
          ...(parent ? { parent: { key: parent } } : {}),
        },
      });
      return { key: created.key, url: browse(created.key) };
    },
    async comments(key) {
      const page = await request(
        "GET",
        `/rest/api/3/issue/${key}/comment?orderBy=created&maxResults=100`,
      );
      return (page.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author?.accountId,
        updateAuthor: c.updateAuthor?.accountId,
        created: c.created,
        updated: c.updated,
        text: adfToBody(c.body),
      }));
    },
    // When the description last changed, from the full changelog (oldest first, paged).
    async bodyChangedAt(key) {
      let last;
      for (let startAt = 0; ; ) {
        const page = await request(
          "GET",
          `/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=100`,
        );
        for (const entry of page.values ?? []) {
          if (entry.items?.some((item) => item.field === "description")) last = entry.created;
        }
        startAt += page.values?.length ?? 0;
        if (page.isLast !== false || !page.values?.length) return last;
      }
    },
    async addComment(key, text) {
      await request("POST", `/rest/api/3/issue/${key}/comment`, { body: bodyToAdf(text) });
    },
    async moveTo(key, statusId) {
      const { transitions = [] } = await request("GET", `/rest/api/3/issue/${key}/transitions`);
      const transition = transitions.find((t) => t.to?.id === statusId);
      if (!transition) throw new Error(`${key} has no transition to status ${statusId}`);
      await request("POST", `/rest/api/3/issue/${key}/transitions`, {
        transition: { id: transition.id },
      });
    },
  };
}

// A JSON request to the Jira API; the keyring is read on the first call only.
function requester(config) {
  const base =
    process.env.SDLC_JIRA_URL ?? `https://api.atlassian.com/ex/jira/${config.jira.cloudId}`;
  let auth;
  return async (method, path, body) => {
    auth ??= `Basic ${Buffer.from(secret(config.jira.secret)).toString("base64")}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, 300);
      throw new Error(`Jira ${method} ${path} failed with ${response.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : {};
  };
}

function adf(body) {
  const doc = bodyToAdf(body);
  const size = JSON.stringify(doc).length;
  if (size > MAX_FIELD) {
    throw new Error(`the issue body would be ${size} characters (Jira allows ${MAX_FIELD})`);
  }
  return doc;
}

// API tokens last at most a year; jira.secret.expires (the date the owner chose) gives a month's
// warning on every Jira call before the pipeline stops.
function warnIfExpiring({ account, expires }) {
  if (!expires) return;
  const days = (Date.parse(expires) - Date.now()) / 86_400_000;
  if (days > 30) return;
  console.error(`sdlc: the Jira token for ${account} expires on ${expires}; make a new one`);
}

function secret({ service, account }) {
  const command = process.env.SDLC_SECRET_CMD;
  const value = command
    ? execFileSync("sh", ["-c", command], { encoding: "utf8" })
    : execFileSync("secret-tool", ["lookup", "service", service, "account", account], {
        encoding: "utf8",
      });
  const trimmed = value.trim();
  if (!trimmed.includes(":")) {
    throw new Error(`the keyring entry ${service}/${account} must hold "email:token"`);
  }
  return trimmed;
}
