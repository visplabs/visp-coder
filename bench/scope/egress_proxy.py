"""The only way out of a scope container: an HTTPS proxy that tunnels to an allow-list of hosts.

Usage (run_scope.py starts it in its own container, from the scope image):
  egress_proxy.py --listen 0.0.0.0:3128 --allow api.anthropic.com:443 [--allow host:port ...]

The worker's container sits on an internal Docker network with no route out; this proxy's container is on
that network and on the default bridge. The worker gets HTTPS_PROXY pointing here. Only CONNECT to an
allowed host:port is tunnelled; anything else (another host, a plain-HTTP request) gets 403 and no
connection is made. Every request is printed as one JSON line {"t", "client", "method", "target",
"allowed"}, which run_scope.py saves as <run>/egress.log. The tunnel carries TLS end to end: the proxy
sees host names, never content. Standard library only.
"""
import argparse
import asyncio
import json
import sys
import time

MAX_HEADER = 16384


def normalize(target):
    """host:port in lower case, or None when the target has no port."""
    host, _, port = str(target).strip().rpartition(":")
    if not host or not port.isdigit():
        return None
    return f"{host.strip('[]').lower()}:{int(port)}"


def decide(method, target, allowed):
    """Whether a request may pass: a CONNECT to an allowed host:port."""
    return method.upper() == "CONNECT" and normalize(target) in allowed


def log(client, method, target, allowed):
    print(json.dumps({"t": round(time.time(), 3), "client": client, "method": method, "target": target,
                      "allowed": allowed}), flush=True)


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(reader, writer, allowed):
    client = str((writer.get_extra_info("peername") or ("?",))[0])
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        writer.close()
        return
    words = head.split(b"\r\n", 1)[0].decode("latin-1").split()
    method, target = (words + ["", ""])[:2]
    allowed_here = decide(method, target, allowed)
    log(client, method, target, allowed_here)
    if not allowed_here:
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    host, port = normalize(target).rsplit(":", 1)
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(host, int(port))
    except OSError:
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))


async def serve(listen, allowed, ready=None):
    host, port = listen.rsplit(":", 1)
    server = await asyncio.start_server(lambda r, w: handle(r, w, allowed), host, int(port), limit=MAX_HEADER)
    if ready:
        ready(server.sockets[0].getsockname()[1])
    async with server:
        await server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen", default="0.0.0.0:3128")
    parser.add_argument("--allow", action="append", default=[], help="host:port that may be tunnelled to")
    args = parser.parse_args(argv)
    allowed = {normalize(target) for target in args.allow} - {None}
    if not allowed:
        raise SystemExit("egress_proxy: no --allow host:port given")
    print(json.dumps({"t": round(time.time(), 3), "listen": args.listen, "allow": sorted(allowed)}), flush=True)
    asyncio.run(serve(args.listen, allowed))


if __name__ == "__main__":
    sys.exit(main())
