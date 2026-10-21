"""Local test service: runs a worker's patch inside a chain's SWE-bench image.

POST /run {"image": name, "patch": text, "command": shell text, "timeout": s}
-> {"exit": code, "output": tail}. Each call uses a fresh container with no network, the
repository at /testbed with the patch applied and the image's conda environment active.

Run it as a user unit so it outlives the shell that started it, for example
  systemd-run --user --unit=chainswe-testsvc python3 bench/swe_env/testsvc.py
Only images under SWE_TEST_IMAGES (default swebench/) that are already pulled are served.
"""
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SWE_TEST_PORT", "8766"))
DOCKER = {**os.environ, "DOCKER_HOST": os.environ.get("DOCKER_HOST", "unix:///var/run/docker.sock")}
SLOTS = threading.Semaphore(int(os.environ.get("SWE_TEST_SLOTS", "6")))
PREFIXES = tuple(os.environ.get("SWE_TEST_IMAGES", "swebench/").split(","))
SCRIPT = """set -e
cd /testbed
if [ -s /tmp/worker.patch ]; then git apply --whitespace=nowarn /tmp/worker.patch; fi
set +e
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
"""


def pulled(image):
    if not image.startswith(PREFIXES):
        return False
    return subprocess.run(["docker", "image", "inspect", image], env=DOCKER, capture_output=True).returncode == 0


def run(image, patch, command, timeout):
    name = f"swetest-{os.getpid()}-{threading.get_ident()}"
    with SLOTS:
        argv = ["docker", "run", "--rm", "-i", "--name", name, "--network", "none", "--cpus", "2",
                "--memory", "4g", "--entrypoint", "bash", image, "-c",
                f"cat > /tmp/worker.patch; {SCRIPT}\ntimeout {int(timeout)} bash -c {json.dumps(command)} 2>&1"]
        try:
            done = subprocess.run(argv, input=patch, env=DOCKER, capture_output=True, text=True,
                                  timeout=timeout + 120)
            return done.returncode, done.stdout + done.stderr
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "rm", "-f", name], env=DOCKER, capture_output=True)
            return 124, "swe-test: timed out"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            if not pulled(body["image"]):
                raise LookupError(f"image {body['image']} is not available")
            code, output = run(body["image"], body.get("patch", ""), body["command"],
                               min(int(body.get("timeout", 900)), 1800))
        except Exception as error:  # reported to the worker as an environment problem
            code, output = 125, f"swe-test environment error: {error}"
        data = json.dumps({"exit": code, "output": output[-30000:]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
