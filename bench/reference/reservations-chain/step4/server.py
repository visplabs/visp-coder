import sys
from http.server import ThreadingHTTPServer

from inventory.http import make_handler
from inventory.store import Store

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), make_handler(Store())).serve_forever()
