import { verifyAccounts } from "../account-verification.js";
import type { ProductExecution } from "../model.js";
import type { ListedRequirement } from "../requirements.js";
import type { EvidenceAccount, EvidenceGap } from "./record-types.js";

const IDS_SHOWN = 6;

interface RecordedAccount {
  readonly id: string;
  readonly status: "done" | "not-done";
  readonly check?: string;
  readonly note?: string;
  readonly reason?: string;
}

/**
 * The worker's account of each requirement `visp feature` listed, with what VISP could check
 * of it: whether the tests it names appear in the cited check's latest output as passed.
 */
export function accountEvidence(
  listed: readonly ListedRequirement[],
  accounts: readonly RecordedAccount[],
  executions: readonly ProductExecution[],
): EvidenceAccount[] {
  const verified = verifyAccounts(accounts, executions);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return listed.map((requirement): EvidenceAccount => {
    const account = byId.get(requirement.id);
    const base = { requirement: requirement.id, statement: requirement.statement };
    if (!account) return { ...base, account: "open" };
    if (account.status === "not-done")
      return { ...base, account: "not-done", reason: account.reason ?? "" };
    const checked = verified.get(requirement.id);
    return {
      ...base,
      account: "done",
      ...(account.check ? { check: account.check } : {}),
      ...(account.note ? { note: account.note } : {}),
      ...(checked ? { verification: checked.status, detail: checked.summary } : {}),
    };
  });
}

/** One gap for the accounts whose named tests VISP could not confirm; none when all could be. */
export function accountGaps(accounts: readonly EvidenceAccount[] | undefined): EvidenceGap[] {
  const claimed = (accounts ?? []).filter((entry) => entry.verification === "claimed");
  if (!claimed.length) return [];
  const done = accounts?.filter((entry) => entry.account === "done").length ?? 0;
  const ids = claimed.map((entry) => entry.requirement);
  const shown =
    ids.length > IDS_SHOWN ? `${ids.slice(0, IDS_SHOWN).join(", ")}, …` : ids.join(", ");
  const why = claimed[0]?.detail?.replace(/^claimed, not verified: /, "");
  return [
    {
      kind: "account",
      severity: "attention",
      text: `${claimed.length} of ${done} requirement accounts (${shown}) name tests VISP could not confirm in the cited check's output: claimed, not verified. For example ${why}`,
    },
  ];
}
