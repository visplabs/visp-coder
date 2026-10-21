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

    def test_text_comparisons_and_if(self):
        self.assertEqual(run('SET A1 =IF(2>1, "a"&"b", 1/0)', "SET A2 =\"x\"=\"x\"", "GET A1", "GET A2"), ["ab", "TRUE"])

    def test_count(self):
        self.assertEqual(run("SET A1 1", "SET A2 x", "SET B1 =COUNT(A1:A3)", "GET B1"), ["1"])

    def test_copy_moves_relative_references(self):
        self.assertEqual(run("SET B1 =A1+$A$1", "COPY B1 C3", "FORMULA C3"), ["=B3+$A$1"])

    def test_row_commands_rewrite_references(self):
        self.assertEqual(run("SET A1 1", "SET A2 2", "SET B9 =SUM(A1:A2)", "INSERTROW 2", "FORMULA B10",
                             "DELETEROW 5", "FORMULA B9"), ["=SUM(A1:A3)", "=SUM(A1:A3)"])

    def test_conditional_functions(self):
        self.assertEqual(run("SET A1 apple", "SET A2 5", "SET B1 =COUNTIF(A1:A3,\"a*\")",
                             "SET B2 =SUMIF(A1:A3,\"<>apple\")", "GET B1", "GET B2"), ["1", "5"])


if __name__ == "__main__":
    unittest.main()
