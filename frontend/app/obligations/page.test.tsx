import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import mockTwin from "@/lib/mock/twin.json";
import { OFFLINE_REASON } from "@/lib/offline";
import type { FinancialTwin, ObligationsPayload } from "@/lib/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    getTwin: vi.fn(),
    getObligations: vi.fn(),
    createRecurringObligation: vi.fn(),
    updateRecurringObligation: vi.fn(),
    deleteRecurringObligation: vi.fn(),
    createOneTimeObligation: vi.fn(),
    updateOneTimeObligation: vi.fn(),
    deleteOneTimeObligation: vi.fn(),
    respondToClarification: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ usePathname: () => "/obligations" }));

import * as api from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { TwinProvider, useTwin } from "@/lib/state/TwinProvider";
import ObligationsPage from "./page";

const TWIN = mockTwin as unknown as FinancialTwin;
/** What a write answers with, so a test can prove the shared twin was replaced. */
const SAVED_TWIN = { ...TWIN, display_name: "Alex after the write" } as FinancialTwin;

/**
 * Deliberately small and explicit, in the order the backend serves (OB-10):
 * a detected active row, a declared paused one, an unclassified row with
 * ordered options, and one upcoming charge.
 */
const LISTING: ObligationsPayload = {
  user_id: "alex",
  as_of: "2026-09-18",
  recurring: [
    {
      id: "rec_rent",
      name: "Hokie Property Mgmt Rent",
      amount: 1200,
      frequency: "monthly",
      due_day: 1,
      active: true,
      origin: "detected",
      category_label: "Bill",
      needs_answer: false,
      options: [],
    },
    {
      id: "rec_gym",
      name: "Gym membership",
      amount: 40.4,
      frequency: "monthly",
      due_day: 3,
      active: false,
      origin: "declared",
      category_label: "Optional spending",
      needs_answer: false,
      options: [],
    },
    {
      id: "rec_transfer",
      name: "Online Transfer To",
      amount: 250,
      frequency: "monthly",
      due_day: 5,
      active: true,
      origin: "detected",
      category_label: null,
      needs_answer: true,
      options: [
        { category: "savings_transfer", label: "Savings transfer" },
        { category: "debt_repayment", label: "Debt repayment" },
        { category: "bill", label: "Bill" },
      ],
    },
  ],
  one_time: [
    {
      id: "one_dentist",
      name: "Dentist",
      amount: 180,
      due_date: "2026-10-02",
      account_id: "acc_checking",
      account_name: "Everyday Checking",
      mandatory: true,
    },
  ],
};

function loaded(data: FinancialTwin = SAVED_TWIN) {
  return { data, source: "api" as const };
}

function renderPage() {
  return render(
    <TwinProvider>
      <ObligationsPage />
    </TwinProvider>,
  );
}

/** Reads the shared twin, to prove a write's response reached the provider. */
function Probe() {
  const { twin } = useTwin();
  return <span data-testid="shared-name">{twin?.display_name ?? "none"}</span>;
}

function renderInShell() {
  return render(
    <TwinProvider>
      <AppShell>
        <ObligationsPage />
        <Probe />
      </AppShell>
    </TwinProvider>,
  );
}

function recurringTable() {
  return screen.getByRole("table", { name: "Recurring expenses" });
}

function upcomingTable() {
  return screen.getByRole("table", { name: "Upcoming obligations" });
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

async function showsRent() {
  return screen.findByText("Hokie Property Mgmt Rent");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
  vi.mocked(api.getObligations).mockResolvedValue({ data: LISTING, source: "api" });
  vi.mocked(api.createRecurringObligation).mockResolvedValue(loaded());
  vi.mocked(api.updateRecurringObligation).mockResolvedValue(loaded());
  vi.mocked(api.deleteRecurringObligation).mockResolvedValue(loaded());
  vi.mocked(api.createOneTimeObligation).mockResolvedValue(loaded());
  vi.mocked(api.updateOneTimeObligation).mockResolvedValue(loaded());
  vi.mocked(api.deleteOneTimeObligation).mockResolvedValue(loaded());
  vi.mocked(api.respondToClarification).mockResolvedValue(loaded());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Obligations page loading, empty and error states", () => {
  it("shows a skeleton in each section while the listing is in flight (G-7)", () => {
    vi.mocked(api.getObligations).mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(
      screen.getByRole("status", { name: "Loading recurring expenses" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading upcoming obligations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading recurring expenses…")).toHaveClass("sr-only");
  });

  it("shows both exact empty states (OB-1, G-8)", async () => {
    vi.mocked(api.getObligations).mockResolvedValue({
      data: { ...LISTING, recurring: [], one_time: [] },
      source: "api",
    });
    renderPage();

    expect(await screen.findByText("No recurring expenses.")).toBeInTheDocument();
    expect(screen.getByText("Nothing upcoming.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the backend detail verbatim with Retry, and no fixture rows (G-9, G-14)", async () => {
    vi.mocked(api.getObligations).mockRejectedValue(
      new api.ApiError("No twin for user 'nobody'", 404),
    );
    renderPage();

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("No twin for user 'nobody'");
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    expect(screen.queryByText("Hokie Property Mgmt Rent")).not.toBeInTheDocument();
  });

  it("requests the listing again when Retry is pressed", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getObligations)
      .mockRejectedValueOnce(new api.ApiError("Try again", 500))
      .mockResolvedValueOnce({ data: LISTING, source: "api" });
    renderPage();

    await user.click((await screen.findAllByRole("button", { name: "Retry" }))[0]);

    expect(await showsRent()).toBeInTheDocument();
    expect(screen.queryByText("Try again")).not.toBeInTheDocument();
    expect(api.getObligations).toHaveBeenCalledTimes(2);
  });
});

describe("Obligations page rendering", () => {
  it("renders every recurring column from the payload (OB-3, G-2)", async () => {
    renderPage();
    await showsRent();

    const row = rowFor("Hokie Property Mgmt Rent");
    expect(within(row).getByText("Bill")).toBeInTheDocument();
    expect(within(row).getByText("$1,200")).toBeInTheDocument();
    expect(within(row).getByText("Monthly")).toBeInTheDocument();
    expect(within(row).getByText("the 1st")).toBeInTheDocument();
    expect(
      within(row).getByRole("switch", { name: "Active status for Hokie Property Mgmt Rent" }),
    ).toBeChecked();
    expect(api.getObligations).toHaveBeenCalledWith("alex");
  });

  it("renders the upcoming columns, with the twin-relative date (OB-8, G-1)", async () => {
    renderPage();
    await showsRent();

    const row = rowFor("Dentist");
    expect(within(row).getByText("$180")).toBeInTheDocument();
    expect(within(row).getByText("Everyday Checking")).toBeInTheDocument();
    const date = within(row).getByLabelText("Oct 2 (2026-10-02)");
    expect(date).toHaveTextContent("Oct 2");
    expect(date).toHaveAttribute("title", "2026-10-02");
  });

  it("keeps a paused row visible, dimmed and labelled Paused (OB-5, G-18)", async () => {
    renderPage();
    await showsRent();

    const row = rowFor("Gym membership");
    expect(row).toHaveClass("opacity-60");
    expect(within(row).getByText("Paused")).toBeInTheDocument();
    expect(
      within(row).getByRole("switch", { name: "Active status for Gym membership" }),
    ).not.toBeChecked();
  });

  it("shows the declared category, and Unclassified when there is none (OB-4)", async () => {
    renderPage();
    await showsRent();

    expect(within(rowFor("Gym membership")).getByText("Optional spending")).toBeInTheDocument();
    expect(within(rowFor("Online Transfer To")).getByText("Unclassified")).toBeInTheDocument();
  });

  it("renders the payload's order, never one of its own (OB-10)", async () => {
    renderPage();
    await showsRent();

    const names = within(recurringTable())
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(names).toEqual([
      "Hokie Property Mgmt Rent",
      "Gym membership",
      "Online Transfer To",
    ]);
  });

  it("labels every cell for the stacked mobile layout (OB-11, G-20)", async () => {
    renderPage();
    await showsRent();

    const labels = (table: HTMLElement, name: string) =>
      within(rowFor(name))
        .getAllByRole("cell")
        .map((cell) => cell.getAttribute("data-label"));

    expect(labels(recurringTable(), "Hokie Property Mgmt Rent")).toEqual([
      "Name",
      "Category",
      "Amount",
      "Frequency",
      "Due day",
      "Active",
      "Actions",
    ]);
    expect(labels(upcomingTable(), "Dentist")).toEqual([
      "Name",
      "Amount",
      "Due date",
      "Account",
      "Actions",
    ]);
  });
});

describe('Obligations page "What is this?" (OB-9)', () => {
  it("offers the backend's options in order, with no probabilities", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    const row = rowFor("Online Transfer To");
    await user.click(within(row).getByRole("button", { name: "What is this?" }));

    const select = within(row).getByRole("combobox", {
      name: "Choose category for Online Transfer To",
    });
    const options = within(select).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Choose category",
      "Savings transfer",
      "Debt repayment",
      "Bill",
    ]);
    expect(select).toHaveValue("");
    expect(select.textContent).not.toMatch(/%|0\.\d/);
  });

  it("sends the chosen category and nothing else", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    const row = rowFor("Online Transfer To");
    await user.click(within(row).getByRole("button", { name: "What is this?" }));
    await user.selectOptions(
      within(row).getByRole("combobox", { name: "Choose category for Online Transfer To" }),
      "savings_transfer",
    );

    await waitFor(() => expect(api.respondToClarification).toHaveBeenCalledTimes(1));
    expect(api.respondToClarification).toHaveBeenCalledWith(TWIN, {
      user_id: "alex",
      obligation_id: "rec_transfer",
      category: "savings_transfer",
    });
  });

  it("is not offered on a row that has an answer", async () => {
    renderPage();
    await showsRent();

    expect(
      within(rowFor("Hokie Property Mgmt Rent")).queryByRole("button", {
        name: "What is this?",
      }),
    ).not.toBeInTheDocument();
  });
});

describe("Obligations page recurring writes", () => {
  it("adds a recurring expense from the inline row (OB-2)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(screen.getByRole("button", { name: "Add recurring expense" }));
    await user.type(screen.getByLabelText("Name"), "Gym");
    await user.type(screen.getByLabelText("Amount"), "40");
    await user.type(screen.getByLabelText("Due day"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.createRecurringObligation).toHaveBeenCalledTimes(1));
    expect(api.createRecurringObligation).toHaveBeenCalledWith("alex", {
      name: "Gym",
      amount: 40,
      due_day: 5,
      mandatory: true,
    });
  });

  it("saves an inline name edit on Enter (OB-6, G-12, G-17)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("button", { name: "Edit name for Gym membership" }),
    );
    const field = screen.getByRole("textbox", { name: "Name for Gym membership" });
    expect(screen.getByText("Editing name for Gym membership")).toHaveClass("sr-only");
    await user.clear(field);
    await user.type(field, "Climbing gym{Enter}");

    await waitFor(() => expect(api.updateRecurringObligation).toHaveBeenCalledTimes(1));
    expect(api.updateRecurringObligation).toHaveBeenCalledWith("alex", "rec_gym", {
      name: "Climbing gym",
    });
  });

  it("edits a detected row too (OB-6, PER-5)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("button", { name: "Edit amount for Hokie Property Mgmt Rent" }),
    );
    const field = screen.getByRole("spinbutton", {
      name: "Amount for Hokie Property Mgmt Rent",
    });
    await user.clear(field);
    await user.type(field, "1250{Enter}");

    await waitFor(() =>
      expect(api.updateRecurringObligation).toHaveBeenCalledWith("alex", "rec_rent", {
        amount: 1250,
      }),
    );
  });

  it("commits an inline edit on blur and discards it on Escape (G-12, G-17)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(screen.getByRole("button", { name: "Edit due day for Gym membership" }));
    const field = screen.getByRole("spinbutton", { name: "Due day for Gym membership" });
    await user.clear(field);
    await user.type(field, "12");
    await user.keyboard("{Escape}");

    expect(api.updateRecurringObligation).not.toHaveBeenCalled();
    expect(await screen.findByText("the 3rd")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit due day for Gym membership" }));
    const reopened = screen.getByRole("spinbutton", { name: "Due day for Gym membership" });
    expect(reopened).toHaveValue(3);
    await user.clear(reopened);
    await user.type(reopened, "12");
    fireEvent.blur(reopened);

    await waitFor(() =>
      expect(api.updateRecurringObligation).toHaveBeenCalledWith("alex", "rec_gym", {
        due_day: 12,
      }),
    );
  });

  it("discards a draft when the inline Cancel button is pressed", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(screen.getByRole("button", { name: "Edit name for Gym membership" }));
    const field = screen.getByRole("textbox", { name: "Name for Gym membership" });
    await user.clear(field);
    await user.type(field, "Discarded");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(api.updateRecurringObligation).not.toHaveBeenCalled();
    expect(screen.getByText("Gym membership")).toBeInTheDocument();
  });

  it("sends exactly { active } from the toggle (OB-5)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("switch", { name: "Active status for Hokie Property Mgmt Rent" }),
    );

    await waitFor(() =>
      expect(api.updateRecurringObligation).toHaveBeenCalledWith("alex", "rec_rent", {
        active: false,
      }),
    );
  });

  it("deletes a declared row after a confirmation, and offers none on a detected row (OB-7)", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await showsRent();

    expect(
      within(rowFor("Hokie Property Mgmt Rent")).queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();

    await user.click(within(rowFor("Gym membership")).getByRole("button", { name: "Delete" }));

    expect(confirm).toHaveBeenCalledWith("Delete Gym membership?");
    await waitFor(() =>
      expect(api.deleteRecurringObligation).toHaveBeenCalledWith("alex", "rec_gym"),
    );
  });

  it("does not delete when the confirmation is dismissed (G-12)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await showsRent();

    await user.click(within(rowFor("Gym membership")).getByRole("button", { name: "Delete" }));

    expect(api.deleteRecurringObligation).not.toHaveBeenCalled();
  });
});

describe("Obligations page one-time writes", () => {
  async function openAddRow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Add upcoming obligation" }));
  }

  it("adds an upcoming obligation against the account id, not its name (OB-2)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await openAddRow(user);
    await user.type(screen.getByLabelText("Name"), "Tuition");
    await user.type(screen.getByLabelText("Amount"), "900");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-11-01" } });
    await user.selectOptions(screen.getByLabelText("Account"), "acc_savings");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.createOneTimeObligation).toHaveBeenCalledTimes(1));
    expect(api.createOneTimeObligation).toHaveBeenCalledWith("alex", {
      name: "Tuition",
      amount: 900,
      due_date: "2026-11-01",
      account_id: "acc_savings",
      mandatory: true,
    });
  });

  it("edits an upcoming obligation inline (OB-8)", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(within(rowFor("Dentist")).getByRole("button", { name: "Edit" }));
    const amount = screen.getByLabelText("Amount");
    await user.clear(amount);
    await user.type(amount, "210");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.updateOneTimeObligation).toHaveBeenCalledWith("alex", "one_dentist", {
        name: "Dentist",
        amount: 210,
        due_date: "2026-10-02",
        account_id: "acc_checking",
        mandatory: true,
      }),
    );
  });

  it("deletes an upcoming obligation after a confirmation (OB-7)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await showsRent();

    await user.click(within(rowFor("Dentist")).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(api.deleteOneTimeObligation).toHaveBeenCalledWith("alex", "one_dentist"),
    );
  });
});

describe("Obligations page validation (G-11)", () => {
  async function openRecurringAddRow() {
    const user = userEvent.setup();
    renderPage();
    await showsRent();
    await user.click(screen.getByRole("button", { name: "Add recurring expense" }));
    return user;
  }

  it("refuses a blank name", async () => {
    const user = await openRecurringAddRow();
    await user.type(screen.getByLabelText("Amount"), "40");
    await user.type(screen.getByLabelText("Due day"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Enter a name.")).toBeInTheDocument();
    expect(api.createRecurringObligation).not.toHaveBeenCalled();
  });

  it("refuses an amount of zero or less", async () => {
    const user = await openRecurringAddRow();
    await user.type(screen.getByLabelText("Name"), "Gym");
    await user.type(screen.getByLabelText("Amount"), "0");
    await user.type(screen.getByLabelText("Due day"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Amount must be greater than $0.")).toBeInTheDocument();
    expect(api.createRecurringObligation).not.toHaveBeenCalled();
  });

  it("refuses a due day outside 1 to 31", async () => {
    const user = await openRecurringAddRow();
    await user.type(screen.getByLabelText("Name"), "Gym");
    await user.type(screen.getByLabelText("Amount"), "40");
    await user.type(screen.getByLabelText("Due day"), "32");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Due day must be a whole number from 1 to 31."),
    ).toBeInTheDocument();
    expect(api.createRecurringObligation).not.toHaveBeenCalled();
  });

  it("refuses a one-time date on or before as_of, and one beyond 730 days", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();
    await user.click(screen.getByRole("button", { name: "Add upcoming obligation" }));
    await user.type(screen.getByLabelText("Name"), "Tuition");
    await user.type(screen.getByLabelText("Amount"), "900");
    await user.selectOptions(screen.getByLabelText("Account"), "acc_checking");

    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-09-18" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Due date must be after 2026-09-18.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2028-09-18" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Due date must be on or before 2028-09-17."),
    ).toBeInTheDocument();

    expect(api.createOneTimeObligation).not.toHaveBeenCalled();
  });

  it("bounds the date field itself to the same window", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();
    await user.click(screen.getByRole("button", { name: "Add upcoming obligation" }));

    const date = screen.getByLabelText("Due date");
    expect(date).toHaveAttribute("min", "2026-09-19");
    expect(date).toHaveAttribute("max", "2028-09-17");
  });
});

describe("Obligations page write failures", () => {
  it("shows the backend's message verbatim, in the section that wrote (G-9)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createRecurringObligation).mockRejectedValue(
      new api.ApiError("An active recurring obligation named 'Gym' already exists", 422),
    );
    renderPage();
    await showsRent();

    await user.click(screen.getByRole("button", { name: "Add recurring expense" }));
    await user.type(screen.getByLabelText("Name"), "Gym");
    await user.type(screen.getByLabelText("Amount"), "40");
    await user.type(screen.getByLabelText("Due day"), "5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("An active recurring obligation named 'Gym' already exists"),
    ).toBeInTheDocument();
  });

  it("reports a stale write and reloads the twin (G-16)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteRecurringObligation).mockRejectedValue(
      new api.ApiError("Unknown recurring obligation 'rec_gym'", 404),
    );
    // A distinct object, so the reloaded twin really re-reads the listing.
    vi.mocked(api.getTwin)
      .mockResolvedValueOnce({ data: TWIN, source: "api" })
      .mockResolvedValue({ data: { ...TWIN }, source: "api" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await showsRent();

    await user.click(within(rowFor("Gym membership")).getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText("That changed. Please review and try again."),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.getTwin).toHaveBeenCalledTimes(2));
    // The message survives the refetch it triggers.
    await waitFor(() => expect(api.getObligations).toHaveBeenCalledTimes(2));
    expect(
      screen.getByText("That changed. Please review and try again."),
    ).toBeInTheDocument();
  });

  it("reports a 409 conflict as stale as well", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateRecurringObligation).mockRejectedValue(
      new api.ApiError("Detected payments can be paused, not deleted.", 409),
    );
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("switch", { name: "Active status for Hokie Property Mgmt Rent" }),
    );

    expect(
      await screen.findByText("That changed. Please review and try again."),
    ).toBeInTheDocument();
  });
});

describe("Obligations page shared state and double submits", () => {
  it("replaces the shared twin with the one the write returned (OB-12)", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderInShell();
    await showsRent();
    expect(screen.getByTestId("shared-name")).toHaveTextContent(TWIN.display_name);

    await user.click(within(rowFor("Gym membership")).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByTestId("shared-name")).toHaveTextContent("Alex after the write"),
    );
    // A write refreshes the twin, so the listing is read again (OB-12).
    await waitFor(() => expect(api.getObligations).toHaveBeenCalledTimes(2));
  });

  it("sends one mutation for a double-clicked commit (G-15)", async () => {
    const user = userEvent.setup();
    let release = (value: { data: FinancialTwin; source: "api" }) => {
      void value;
    };
    vi.mocked(api.deleteRecurringObligation).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await showsRent();

    const remove = within(rowFor("Gym membership")).getByRole("button", { name: "Delete" });
    await user.dblClick(remove);

    expect(api.deleteRecurringObligation).toHaveBeenCalledTimes(1);
    release(loaded());
    await waitFor(() => expect(api.getObligations).toHaveBeenCalledTimes(2));
    expect(api.deleteRecurringObligation).toHaveBeenCalledTimes(1);
  });

  it("disables the other controls while a write is in flight (G-15)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateRecurringObligation).mockReturnValue(new Promise(() => {}));
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("switch", { name: "Active status for Hokie Property Mgmt Rent" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add recurring expense" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Add upcoming obligation" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Active status for Gym membership" }),
    ).toBeDisabled();
  });
});

describe("Obligations page offline (G-10)", () => {
  beforeEach(() => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "fixture" });
  });

  it("shows the saved twin's obligations without requesting the listing", async () => {
    renderPage();

    expect(await screen.findByText("Hokie Property Mgmt Rent")).toBeInTheDocument();
    expect(screen.getByText("Verizon Wireless")).toBeInTheDocument();
    expect(screen.getByText("Nothing upcoming.")).toBeInTheDocument();
    expect(api.getObligations).not.toHaveBeenCalled();
  });

  it("keeps the banner up and disables every write control with that reason", async () => {
    renderInShell();
    await showsRent();

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(OFFLINE_REASON);

    for (const name of ["Add recurring expense", "Add upcoming obligation"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", OFFLINE_REASON);
    }

    const toggle = screen.getByRole("switch", {
      name: "Active status for Hokie Property Mgmt Rent",
    });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", OFFLINE_REASON);

    const edit = screen.getByRole("button", {
      name: "Edit name for Hokie Property Mgmt Rent",
    });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", OFFLINE_REASON);

    const ask = screen.getByRole("button", { name: "What is this?" });
    expect(ask).toBeDisabled();
    expect(ask).toHaveAttribute("title", OFFLINE_REASON);

    expect(banner).toBeInTheDocument();
  });

  it("writes nothing when a disabled control is clicked anyway", async () => {
    const user = userEvent.setup();
    renderPage();
    await showsRent();

    await user.click(
      screen.getByRole("switch", { name: "Active status for Hokie Property Mgmt Rent" }),
    );

    expect(api.updateRecurringObligation).not.toHaveBeenCalled();
  });
});
