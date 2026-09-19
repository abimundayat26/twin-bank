/** Product header. Carries the pitch and says plainly where the data came from. */

import type { DataSource } from "@/lib/api";
import { Badge } from "./ui";

export function Header({
  userName,
  source,
  isMock,
}: {
  userName?: string;
  source?: DataSource;
  isMock?: boolean;
}) {
  return (
    <header className="border-b border-line bg-surface/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5">
        <div>
          <p className="text-xl font-semibold tracking-tight text-ink">TwinBank</p>
          <p className="text-sm text-muted">
            Your bank knows what happened.{" "}
            <span className="text-baseline">TwinBank shows what happens next.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {userName ? <Badge>Demo user: {userName}</Badge> : null}
          {source ? (
            <Badge tone={source === "api" ? "good" : "caution"}>
              {source === "api" ? "Live backend" : "Offline fixtures"}
            </Badge>
          ) : null}
          {isMock ? <Badge tone="caution">Mocked simulation</Badge> : null}
        </div>
      </div>
    </header>
  );
}
