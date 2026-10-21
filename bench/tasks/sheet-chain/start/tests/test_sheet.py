import os
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*commands):
    completed = subprocess.run([os.path.join(ROOT, "run.sh")], input="\n".join(commands) + "\n",
                               capture_output=True, text=True, timeout=30)
    return completed.stdout.splitlines()


class SheetTest(unittest.TestCase):
    def test_arithmetic_and_precedence(self):
        self.assertEqual(run("SET A1 =2+3*4", "SET A2 =-2^2", "GET A1", "GET A2"), ["14", "4"])

    def test_ranges_and_functions(self):
        self.assertEqual(run("SET A1 1", "SET A2 2", "SET B1 =SUM(A1:A2)", "GET B1"), ["3"])

    def test_errors_and_cycles(self):
        self.assertEqual(run("SET A1 =1/0", "SET B1 =B1", "GET A1", "GET B1"), ["#DIV/0!", "#CYCLE!"])

    def test_recalculation(self):
        self.assertEqual(run("SET A1 1", "SET A2 =A1+1", "GET A2", "SET A1 5", "GET A2"), ["2", "6"])


if __name__ == "__main__":
    unittest.main()
