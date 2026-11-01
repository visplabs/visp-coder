<!-- visp:instructions:start -->
Follow the VISP project instructions in [AGENTS.visp.md](AGENTS.visp.md). The package is visp-coder; the executable is `visp`. Use VISP MCP tools when connected: `visp_next({})`, then `visp_<command>` schemas; otherwise use CLI `visp next`.

| When | Command |
|---|---|
| Start or resume | `visp next` |
| New request | `visp feature "<goal>" --check "<test command>" --source-brief -` |
| Plan or revise a decision | `visp brief --template` |
| Implement a slice | `visp work --check "<test command>"` |
| An ownership/caller/test question | `visp query search "<symbol or behavior>"` |
| Observe a browser interaction | `visp capture --task <id> --from -` |
| The slice is usable | `visp done --task <id>` |
| Next directs final acceptance | `visp accept --feature <id>` |
| Only when `visp next` prints it | `visp pr --feature <id>` |

Research relevant uncertainties with host tools; apply conclusions in the brief. Read [VISP.commands.md](VISP.commands.md) for input examples, critic dispatch and recovery. No custom skill is needed. Reviewer configuration is not proof of invocation or quality.
<!-- visp:instructions:end -->