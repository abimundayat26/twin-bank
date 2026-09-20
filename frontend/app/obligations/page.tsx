import { Card, PageFrame, PageHeading } from "@/components/ui";

/** FE-0 route shell only. Obligations CRUD lands in its own focused change. */
export default function ObligationsPage() {
  return (
    <PageFrame>
      <PageHeading title="Obligations">
        Review recurring expenses and upcoming obligations.
      </PageHeading>
      <Card>
        <p className="text-sm text-muted">
          Obligation management is coming next. No changes can be made from this route yet.
        </p>
      </Card>
    </PageFrame>
  );
}
