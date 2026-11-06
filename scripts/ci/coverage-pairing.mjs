// Adds the hit counts of one Istanbul file coverage (from the CLI bundle) to another (from vitest)
// for the same source file. Entries are paired by key, one pass after another; a key pairs only
// when both sides have the same number of entries under it, taken in source order. Entries left
// unpaired after the last pass are counted and dropped.
const PASSES = {
  branches: [
    (branch) => `${branch.type}:${branch.locations[0].start.line}:${branch.locations.length}`,
    (branch) => `${branch.type}:${lastLine(branch.locations.at(-1))}:${branch.locations.length}`,
    (branch) => `${branch.type}:${branch.locations.length}`,
  ],
  statements: [(location) => `${location.start.line}`, (location) => `${lastLine(location)}`],
  functions: [(fn) => `${fn.decl.start.line}`, (fn) => fn.name],
};

const FIELDS = {
  branches: ["branchMap", "b"],
  statements: ["statementMap", "s"],
  functions: ["fnMap", "f"],
};

export function addPaired(base, child) {
  const dropped = {};
  for (const [kind, passes] of Object.entries(PASSES)) {
    const [mapField, hitField] = FIELDS[kind];
    const pairs = pair(base[mapField], child[mapField], passes);
    for (const [baseId, childId] of pairs.matched) {
      base[hitField][baseId] = addHits(base[hitField][baseId], child[hitField][childId]);
    }
    dropped[kind] = pairs.unpaired;
  }
  return dropped;
}

function pair(baseMap, childMap, passes) {
  let baseLeft = inSourceOrder(baseMap);
  let childLeft = inSourceOrder(childMap);
  const matched = [];
  for (const keyOf of passes) {
    const baseGroups = groupBy(baseLeft, keyOf);
    const used = new Set();
    for (const [key, entries] of groupBy(childLeft, keyOf)) {
      const partners = baseGroups.get(key);
      if (partners?.length !== entries.length) continue;
      entries.forEach(([childId], index) => {
        const baseId = partners[index]?.[0];
        if (baseId === undefined) return;
        matched.push([baseId, childId]);
        used.add(`b${baseId}`).add(`c${childId}`);
      });
    }
    baseLeft = baseLeft.filter(([id]) => !used.has(`b${id}`));
    childLeft = childLeft.filter(([id]) => !used.has(`c${id}`));
  }
  return { matched, unpaired: childLeft.length };
}

function inSourceOrder(map) {
  return Object.entries(map).sort(([, a], [, b]) => compare(start(a), start(b)));
}

function start(entry) {
  return entry.decl?.start ?? entry.locations?.[0].start ?? entry.start;
}

function compare(a, b) {
  return a.line - b.line || (a.column ?? 0) - (b.column ?? 0);
}

function groupBy(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry[1]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}

function lastLine(location) {
  return location.end.line ?? location.start.line;
}

function addHits(base, child) {
  if (Array.isArray(base)) return base.map((hits, arm) => hits + (child?.[arm] ?? 0));
  return base + (child ?? 0);
}
