"""The constraint paragraph every benchmark prompt carries, and the one arm that changes it.

Every arm receives COMMON. The only exception is bare-automemory: Claude Code's auto memory
writes into <run>/memory (run_claude.memory_directory), which is outside the project, so the
paragraph that limits files and reads to the project would forbid the very thing the arm
measures. That arm's paragraph names the memory directory as the one place besides the project
a worker may write and read. No other arm's text changes (test_prompts.py pins them byte for byte).
"""
import pathlib


def memory_directory(root):
    """The run's auto memory, beside its project. Must equal run_claude.memory_directory."""
    return pathlib.Path(root).resolve().parent / "memory"


def common(root, arm):
    """The constraint paragraph for an arm (`arm` is the base arm name, without worker modes)."""
    inside = "create or edit files only inside it. "
    others = "Do not read other directories. "
    if arm == "bare-automemory":
        memory = memory_directory(root)
        inside = f"create or edit files only inside it and in Claude Code's own memory directory {memory}. "
        others = f"Do not read other directories except {memory}. "
    return (
        f"Your project directory is {root}. Run every shell command from that directory "
        f"(start each command with `cd {root} && `) and {inside}"
        f"{others}No dependency downloads or network APIs; the standard "
        "library is available. Do not ask questions: make reasonable assumptions and continue. "
        "Do not delegate to other agents. Build it, run your tests, and finish with a short report "
        "of what you actually verified."
    )
