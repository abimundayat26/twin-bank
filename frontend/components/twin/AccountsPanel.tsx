/** Every account and the total they add up to. Props only. */

import { longDate, moneyExact } from "@/lib/format";
import type { FinancialTwin } from "@/lib/types";
import { Card, Row } from "../ui";

export function AccountsPanel({ twin }: { twin: FinancialTwin }) {
  return (
    <Card title="Current balance" subtitle={`As of ${longDate(twin.as_of)}`}>
      <p className="tnum text-4xl font-semibold text-ink">{moneyExact(twin.total_balance)}</p>
      <ul className="mt-4">
        {twin.accounts.map((account) => (
          <Row
            key={account.id}
            label={account.name}
            hint={account.type === "checking" ? "Checking" : "Savings"}
            value={moneyExact(account.balance)}
          />
        ))}
      </ul>
      {/* The total is not spendable money: the reserve and the goals are
          commitments against it (SPEC section 3.1). */}
      <p className="mt-3 text-xs text-faint">
        Not all of this is free to spend. Declared goals and the emergency reserve are
        commitments against it.
      </p>
    </Card>
  );
}
