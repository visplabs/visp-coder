---
description: 'Start a feature from your own words (owner only). The first line becomes the title.'
argument-hint: '<your request>'
disable-model-invocation: true
---

The SDLC owner-commands hook handled this command before you saw it. Its result is in your
context: the feature issue number `F-<n>` and its link.

- If it names a feature, start the `qe-spec` agent with a prompt that contains the line
  `SDLC-Feature: F-<n>`. When it reports, show the owner the open questions and the issue link,
  and tell them to review the spec there and run `/approve F-<n>`.
- If there is no such result, the hook is off: tell the owner to set `SDLC_OWNER=1` in
  `.claude/settings.local.json`. Do not create the issue yourself.

The owner's request:

$ARGUMENTS
