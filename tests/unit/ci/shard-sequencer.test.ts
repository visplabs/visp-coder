import { describe, expect, it } from "vitest";
import { splitByDuration } from "../../shard-sequencer.js";

describe("splitByDuration", () => {
  it("balances parts by recorded duration, not by file count", () => {
    const timings = { "a.test.ts": 90, "b.test.ts": 30, "c.test.ts": 30, "d.test.ts": 30 };
    const parts = splitByDuration(Object.keys(timings), timings, 2);
    expect(parts).toEqual([["a.test.ts"], ["b.test.ts", "c.test.ts", "d.test.ts"]]);
  });

  it("puts every file in exactly one part", () => {
    const paths = Array.from({ length: 23 }, (_, i) => `t${i}.test.ts`);
    const timings = Object.fromEntries(paths.map((path, i) => [path, (i * 7) % 11]));
    const parts = splitByDuration(paths, timings, 6);
    expect(parts.flat().sort()).toEqual([...paths].sort());
  });

  it("gives the same split whatever order the files arrive in", () => {
    const timings = { "x.test.ts": 5, "y.test.ts": 5, "z.test.ts": 5 };
    const forward = splitByDuration(["x.test.ts", "y.test.ts", "z.test.ts"], timings, 2);
    const reverse = splitByDuration(["z.test.ts", "y.test.ts", "x.test.ts"], timings, 2);
    expect(reverse).toEqual(forward);
  });

  it("counts a file with no recorded time as the median", () => {
    const timings = { "a.test.ts": 10, "b.test.ts": 20, "c.test.ts": 30 };
    const parts = splitByDuration([...Object.keys(timings), "new.test.ts"], timings, 2);
    expect(parts).toEqual([
      ["c.test.ts", "a.test.ts"],
      ["b.test.ts", "new.test.ts"],
    ]);
  });

  it("splits files evenly when nothing is recorded", () => {
    const parts = splitByDuration(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"], {}, 2);
    expect(parts.map((part) => part.length)).toEqual([2, 2]);
  });
});
