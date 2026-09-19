/**
 * A destination that exists but has not been filled yet.
 *
 * Says what will live here and where the feature is today, rather than showing
 * a control that looks active and does nothing: SPEC section 15.1 forbids a
 * planned capability from being presented as an available one.
 */

import Link from "next/link";
import { Card } from "./ui";

export function PagePlaceholder({
  title,
  purpose,
  whereItIsNow = "Overview",
  whereItIsNowHref = "/",
}: {
  title: string;
  purpose: string;
  /** The page that has this feature today. */
  whereItIsNow?: string;
  whereItIsNowHref?: string;
}) {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <Card title={title}>
        <p className="text-sm text-muted">{purpose}</p>
        <p className="mt-3 text-sm text-faint">
          This page is not filled in yet.{" "}
          <Link
            href={whereItIsNowHref}
            className="text-baseline underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-baseline"
          >
            {whereItIsNow}
          </Link>{" "}
          still has this today.
        </p>
      </Card>
    </main>
  );
}
