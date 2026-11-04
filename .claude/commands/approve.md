---
description: 'Review a feature spec, then approve exactly what was shown (owner only).'
argument-hint: 'F-<n> [hash prefix]'
disable-model-invocation: true
---

The SDLC owner-commands hook handles this command and always stops it before it reaches you.
If you are reading this, the hook is off: tell the owner to set `SDLC_OWNER=1` in
`.claude/settings.local.json`. Never approve a spec yourself.
