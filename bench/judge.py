"""Blind visual judge: score each run's final image or game screen against its request.

Usage: judge.py <run_name> [...]
For a visual task, finds the final image (a VISP check's declared image when there is one, else
the newest image the worker wrote; SVG is rasterized in headless Chrome) and copies it under an
anonymous name. For a game task, serves the project and takes a 1280 x 800 screenshot of
index.html at the start of level 1. The judge model (Sonnet 5.5 at high effort, or the run's
preset judge) checks a fixed per-task checklist and gives an overall 1-10 score. Writes judge.json
beside the project. A visual run with no image file is judged on its index.html as served, like a game; a run with neither scores 1 with no checklist item passed;
a failed judge call is recorded as `error` and scores nothing. Runs marked invalid are skipped.
"""
import functools
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

from common import RUNS
from presets import JUDGE
from runfacts import final_project, invalid

BENCH = pathlib.Path(__file__).resolve().parent
CHECKLISTS = {
    "xbox-controller-svg": {
        "elements": ["a dark background behind the controller",
                     "a symmetrical Xbox body shell with grips curving downwards",
                     "gradient shading that gives the shell 3D curvature and an edge shadow",
                     "two thumbsticks in the Xbox offset layout (left stick high, right stick low)",
                     "each thumbstick drawn as a recessed socket, raised base and textured top with grip ridges",
                     "a faceted dark metallic d-pad in a recessed dish at lower left",
                     "A, B, X, Y face buttons in a diamond on the right, coloured green A (bottom), red B (right), blue X (left), yellow Y (top)",
                     "glossy face buttons with centred, legible letter labels",
                     "a circular Xbox guide button at top centre with a glowing X logo",
                     "View, Menu and Share buttons placed correctly around the centre",
                     "the top edges of the LB and RB bumpers visible above the shell"],
        "styles": ["polished, glossy vector render with convincing depth",
                   "clean layering with no messy overlapping or broken shapes",
                   "reads as an Xbox Wireless Controller at a glance"],
        "deliverable": "xbox-controller.svg",
    },
    "ps5-controller-svg": {
        "elements": ["the DualSense body shape with its two grips", "a two-tone white shell with black centre and trim",
                     "a large touchpad", "a light bar", "a PS button", "face buttons with triangle, circle, cross and square",
                     "a d-pad", "two thumbsticks", "L1/L2 and R1/R2 shoulder buttons and triggers",
                     "Create and Options buttons"],
        "styles": ["clean vector illustration", "reads as a PlayStation 5 controller at a glance"],
    },
    "voxel-pagoda": {
        "elements": ["a Japanese pagoda", "a small garden", "cherry blossom trees"],
        "styles": ["isometric 3D voxel (cube) look", "flat shading, no photorealistic lighting",
                   "high-contrast saturated primary-colour palette", "sharp edges, 8-bit retro feel"],
    },
    "rainfall-chart": {
        "elements": ['the title "Colombo average monthly rainfall"', 'a y-axis labelled "Rainfall (mm)"',
                     "horizontal gridlines", "twelve bars with the month names Jan to Dec under them",
                     "each bar's value printed above it", "bar heights matching the stated values",
                     "May and October in a different colour from the other ten bars"],
        "styles": ["clean flat style", "white background"],
    },
    "lighthouse-pixel": {
        "elements": ["a red-and-white striped lighthouse", "a rocky cliff", "a sunset sky",
                     "three seagulls", "waves breaking against the rocks", "the lighthouse lamp glowing"],
        "styles": ["side view", "visible chunky pixels (low-resolution canvas scaled up, no smoothing)",
                   "a limited palette (about 16 colours or fewer)", "a dithered orange-to-purple sky",
                   "no anti-aliasing"],
    },
    # Games are judged on their first screen only; play is covered by the hidden UI checks.
    "slingshot-game": {
        "elements": ["a sky and a ground", "a slingshot near the left edge with a bird resting in it",
                     "pigs on or inside structures of blocks on the right side",
                     "the level, the score and the birds remaining shown on screen", "a Restart button"],
        "styles": ["readable colours", "looks and feels like a game, not a debug view",
                   "the whole world visible without cropping or scrolling"],
    },
    "catapult-game": {
        "elements": ["a sky and a ground", "a catapult near the left edge with a loaded projectile",
                     "structures of blocks on the right side with wood, stone and metal told apart",
                     "enemy targets (banners) on or inside the structures",
                     "the level, the score, the selected projectile and the rounds left of each kind shown on screen",
                     "a Restart button"],
        "styles": ["readable colours", "looks and feels like a game, not a debug view",
                   "the whole world visible without cropping or scrolling"],
    },
}
GAMES = {"slingshot-game", "catapult-game"}
SCHEMA = {
    "type": "object",
    "properties": {
        "elements": {"type": "array", "items": {"type": "object", "properties": {
            "item": {"type": "string"}, "pass": {"type": "boolean"}, "note": {"type": "string"}},
            "required": ["item", "pass", "note"]}},
        "styles": {"type": "array", "items": {"type": "object", "properties": {
            "item": {"type": "string"}, "pass": {"type": "boolean"}, "note": {"type": "string"}},
            "required": ["item", "pass", "note"]}},
        "overall": {"type": "integer", "minimum": 1, "maximum": 10},
        "summary": {"type": "string"},
    },
    "required": ["elements", "styles", "overall", "summary"],
}
IMAGE = re.compile(r"\.(png|svg|gif|jpe?g|webp)$", re.I)
SKIP = {".git", ".visp", "node_modules", "__pycache__", ".claude", ".specify", "_bmad"}


def chrome_env():
    # Headless Chrome hangs on this host when it can reach a desktop session bus or display.
    return {key: value for key, value in os.environ.items()
            if key not in ("DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY")}


def screenshot(url, target, size, wait_ms=0):
    with tempfile.TemporaryDirectory(prefix="judge-chrome-") as profile:
        argv = ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
                "--allow-file-access-from-files", f"--user-data-dir={profile}", f"--window-size={size}",
                f"--screenshot={target}"]
        if wait_ms:
            argv.append(f"--virtual-time-budget={wait_ms}")
        subprocess.run([*argv, url], check=True, capture_output=True, timeout=120, env=chrome_env())


def declared_image(project):
    for brief in project.glob(".visp/features/*/brief.yaml"):
        for match in re.finditer(r"images:\s*\n((?:\s+-\s+.+\n)+)|images:\s*\[([^\]]+)\]", brief.read_text()):
            paths = re.findall(r"-\s+(\S+)", match.group(1)) if match.group(1) else \
                [p.strip().strip("'\"") for p in match.group(2).split(",")]
            for path in paths:
                if (project / path).is_file():
                    return project / path
    return None


def newest_image(project):
    found = [p for p in project.rglob("*") if p.is_file() and IMAGE.search(p.name)
             and not SKIP.intersection(p.relative_to(project).parts)]
    return max(found, key=lambda p: p.stat().st_mtime, default=None)


def raster(image, directory):
    digest = hashlib.sha256(image.read_bytes()).hexdigest()[:10]
    target = directory / f"image-{digest}.png"
    if image.suffix.lower() == ".svg":
        # A browser is the real target for an SVG; ImageMagick's own renderer drops some shapes.
        page = directory / f"page-{digest}.html"
        page.write_text(f'<html><body style="margin:0;background:#fff;display:flex;align-items:center;'
                        f'justify-content:center;width:1000px;height:700px"><img src="file://{image}" '
                        f'style="max-width:960px;max-height:660px"></body></html>')
        screenshot(f"file://{page}", target, "1000,700")
        page.unlink()
    else:
        shutil.copy(image, target)
    return target


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def game_screen(project, directory):
    """A 1280 x 800 screenshot of the game's first screen, served over HTTP as the contract says."""
    if not (project / "index.html").is_file():
        return None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(project)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        staging = directory / f"screen-{os.getpid()}-{threading.get_ident()}.png"
        screenshot(f"http://127.0.0.1:{server.server_address[1]}/index.html", staging, "1280,800", wait_ms=3000)
    finally:
        server.shutdown()
    target = directory / f"image-{hashlib.sha256(staging.read_bytes()).hexdigest()[:10]}.png"
    staging.replace(target)
    return target


def ask(model, effort, prompt, directory, schema, tools="Read", timeout=600):
    """A blind `claude -p` call with structured output; returns (verdict, call facts).

    About one call in ten ended with error_max_structured_output_retries in calibration; such a
    call is made once more, and the first attempt's facts are kept under `earlier`.
    """
    verdict, usage = _ask_once(model, effort, prompt, directory, schema, tools, timeout)
    if usage.get("subtype") == "error_max_structured_output_retries":
        verdict, retried = _ask_once(model, effort, prompt, directory, schema, tools, timeout)
        usage = {**retried, "earlier": [usage]}
    return verdict, usage


def _ask_once(model, effort, prompt, directory, schema, tools, timeout):
    argv = ["claude", "-p", "--model", model, "--effort", effort, "--output-format", "json",
            "--json-schema", json.dumps(schema), "--tools", tools, "--safe-mode", "--strict-mcp-config",
            "--no-session-persistence", "--permission-mode", "dontAsk", "--add-dir", str(directory)]
    done = subprocess.run(argv, input=prompt, capture_output=True, text=True, cwd=directory, timeout=timeout)
    try:
        envelope = json.loads(done.stdout)
    except ValueError:
        return {"error": (done.stdout + done.stderr)[-800:]}, {}
    usage = {key: envelope.get(key) for key in ("usage", "total_cost_usd", "duration_ms", "is_error", "subtype")}
    verdict = envelope.get("structured_output")
    if envelope.get("is_error") or not isinstance(verdict, dict):
        # No verdict: keep what the CLI said, so a failed call is visible and never read as a score.
        return {"error": f"{envelope.get('subtype')}: {str(envelope.get('result'))[-800:]}"}, usage
    return verdict, usage


def judge(name):
    run = RUNS / "runs" / name
    arm = json.loads((run / "arm.json").read_text())
    task = arm["task"]
    if invalid(run):
        return {"run": name, "skipped": "invalid run"}
    settings = (arm.get("settings") or {}).get("judge") or JUDGE
    checklist = CHECKLISTS[task]
    project = final_project(run)
    directory = RUNS / "judge"
    directory.mkdir(exist_ok=True)
    if task in GAMES:
        image, source = game_screen(project, directory), "index.html"
        what = "the first screen of a browser game, as a player sees it before the first shot"
    else:
        # A request that names its output file is judged on that file, not on a newer preview.
        named = checklist.get("deliverable") and project / checklist["deliverable"]
        image = named if named and named.is_file() else declared_image(project) or newest_image(project)
        source = str(image.relative_to(project)) if image else None
        image = raster(image, directory) if image else None
        what = "one image"
        if not image and (project / "index.html").is_file():
            # These requests name no file format, so a page that draws the picture is a delivery
            # too; judge what it shows when opened, as for the games.
            image, source = game_screen(project, directory), "index.html"
            what = "the picture the delivered page shows when it is opened in a browser"
    if not image:
        # Nothing to judge is the lowest score, as a hidden check with no result passes nothing.
        result = {"run": name, "task": task, "image": None, "missing": "no image produced",
                  "judge": f"{settings['model']}:{settings['effort']}", "overall": 1,
                  "elements": f"0/{len(checklist['elements'])}", "styles": f"0/{len(checklist['styles'])}"}
        (run / "judge.json").write_text(json.dumps(result, indent=2))
        return result
    request = (BENCH / "tasks" / task / "task.md").read_text().strip()
    prompt = (
        f"Judge {what} against the request it was made for. Open {image} with the Read tool and look at it carefully.\n\n"
        f"Request:\n{request}\n\n"
        "For each checklist item, decide whether a viewer who has not read any code would recognize it in the image "
        "(pass true only when it is clearly there and reads as that thing; hidden, cut off or ambiguous is false). "
        "Then give an overall 1-10 score for how well the image delivers the request"
        + (" as far as one screen can show it" if task in GAMES else "") + ".\n\n"
        f"Elements: {json.dumps(checklist['elements'])}\nStyles: {json.dumps(checklist['styles'])}"
    )
    verdict, usage = ask(settings["model"], settings["effort"], prompt, directory, SCHEMA)
    elements = verdict.get("elements", [])
    styles = verdict.get("styles", [])
    result = {
        "run": name, "task": task, "image": source, "blind": image.name,
        "judge": f"{settings['model']}:{settings['effort']}",
        "elements": f"{sum(bool(e.get('pass')) for e in elements)}/{len(checklist['elements'])}",
        "styles": f"{sum(bool(s.get('pass')) for s in styles)}/{len(checklist['styles'])}",
        "overall": verdict.get("overall"),
        "error": verdict.get("error") or (None if verdict.get("overall") else "the judge gave no score"),
        "verdict": verdict, "call": usage,
    }
    (run / "judge.json").write_text(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    for name in sys.argv[1:]:
        r = judge(name)
        print(json.dumps({k: r.get(k) for k in ("run", "image", "elements", "styles", "overall", "error", "skipped")}))
