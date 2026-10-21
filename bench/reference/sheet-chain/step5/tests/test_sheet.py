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

    def test_average_and_count(self):
        self.assertEqual(run("SET A1 2", "SET A2 x", "SET B1 =AVERAGE(A1:A3,4)", "SET B2 =COUNT(A1:A3)",
                             "SET B3 =AVERAGE(C1:C2)", "GET B1", "GET B2", "GET B3"), ["3", "1", "#DIV/0!"])

    def test_comparisons_and_if(self):
        self.assertEqual(run("SET A1 =1+1=2", "SET A2 =IF(A1,5,1/0)", "SET A3 =A1+1", "SET A4 =1<2<3",
                             "GET A1", "GET A2", "GET A3", "GET A4"), ["TRUE", "5", "#VALUE!", "#PARSE!"])

    def test_text_in_formulas(self):
        self.assertEqual(run('SET A1 =1+2&" kg"', 'SET A2 =LEN("say ""hi""")', 'SET A3 ="A3"',
                             "GET A1", "GET A2", "GET A3"), ["3 kg", "8", "A3"])

    def test_rows(self):
        self.assertEqual(run("SET A1 1", "SET A2 2", "SET B9 =SUM(A1:A2)", "INSERTROW 2", "SET A2 4", "GET B10",
                             "DELETEROW 1", "GET B9", "SET C1 =A99", "INSERTROW 1", "GET C2"), ["7", "6", "#REF!"])

    def test_whole_grid_chain(self):
        cells = [f"{chr(column)}{row}" for column in range(65, 91) for row in range(1, 100)]
        build = ["SET A1 1"] + [f"SET {cell} ={previous}+1" for previous, cell in zip(cells, cells[1:])]
        self.assertEqual(run(*build, "GET Z99", "SET A1 2", "GET Z99"), ["2574", "2575"])
        self.assertEqual(run(*build, "GET Z99", "SET Z99 7", "GET Z98", "GET Z99", "SET Z99 =Z98", "GET Z99"),
                         ["2574", "2573", "7", "2573"])

    def test_recalculation(self):
        self.assertEqual(run("SET A1 1", "SET A2 =A1+1", "GET A2", "SET A1 5", "GET A2"), ["2", "6"])


if __name__ == "__main__":
    unittest.main()
