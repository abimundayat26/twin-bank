/**
 * The two limits the projection must respect: the emergency reserve and Alex's
 * own minimum checking balance. Declared facts, so they live on Plans.
 */

import { money } from "@/lib/format";
import type { FinancialTwin } from "@/lib/types";
import { MinimumBalanceCard } from "../MinimumBalanceCard";
import { Card, ProvenanceTag } from "../ui";

export function ConstraintsPanel({
  twin,
  isBusy = false,
  savingScope,
  onSetMinimum,
}: {
  twin: FinancialTwin;
  isBusy?: boolean;
  savingScope?: string;
  onSetMinimum: (amount: number) => void;
}) {
  const reserve = twin.constraints.find((c) => c.type === "minimum_reserve");
  const minimum = twin.constraints.find((c) => c.type === "minimum_checking_balance");

  return (
    <div className="grid gap-4">
      {reserve ? (
        <Card title="Minimum emergency reserve">
          <div className="flex items-baseline justify-between gap-4">
            <p className="tnum text-3xl font-semibold text-ink">{money(reserve.amount)}</p>
            <ProvenanceTag provenance={reserve.provenance} />
          </div>
          <p className="mt-2 text-sm text-muted">{reserve.description}</p>
        </Card>
      ) : null}

      <MinimumBalanceCard
        key={minimum?.amount ?? "unset"}
        minimum={minimum}
        isBusy={isBusy}
        savingScope={savingScope}
        onSave={onSetMinimum}
      />
    </div>
  );
}
