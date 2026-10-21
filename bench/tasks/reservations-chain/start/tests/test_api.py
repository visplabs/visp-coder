import http.client
import json
import os
import socket
import subprocess
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.proc = subprocess.Popen([os.path.join(ROOT, "start.sh"), str(cls.port)])
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.2).close()
                return
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)

    def call(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers=headers or {"Content-Type": "application/json"})
        response = conn.getresponse()
        raw = response.read()
        conn.close()
        return response.status, json.loads(raw) if raw else None

    def test_item_lifecycle(self):
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-1", "quantity": 3})[0], 201)
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-1", "quantity": 3})[0], 409)
        self.assertEqual(self.call("GET", "/v1/items/T-1")[1], {"sku": "T-1", "quantity": 3, "available": 3})

    def test_reserve_confirm_release(self):
        self.call("POST", "/v1/items", {"sku": "T-2", "quantity": 5})
        status, body = self.call("POST", "/v1/reservations", {"sku": "T-2", "quantity": 2, "ttlSeconds": 60})
        self.assertEqual(status, 201)
        self.assertEqual(self.call("GET", "/v1/items/T-2")[1]["available"], 3)
        self.assertEqual(self.call("POST", f"/v1/reservations/{body['id']}/confirm", {})[0], 200)
        self.assertEqual(self.call("GET", "/v1/items/T-2")[1], {"sku": "T-2", "quantity": 3, "available": 3})
        other = self.call("POST", "/v1/reservations", {"sku": "T-2", "quantity": 1, "ttlSeconds": 60})[1]
        self.assertEqual(self.call("DELETE", f"/v1/reservations/{other['id']}")[0], 204)

    def test_errors(self):
        self.assertEqual(self.call("POST", "/v1/reservations", {"sku": "none", "quantity": 1, "ttlSeconds": 5})[0], 404)
        self.assertEqual(self.call("GET", "/v1/reservations")[0], 405)
        self.assertEqual(self.call("POST", "/v1/items", {"sku": "T-3", "quantity": 1}, {"Content-Type": "text/plain"})[0], 415)


if __name__ == "__main__":
    unittest.main()
