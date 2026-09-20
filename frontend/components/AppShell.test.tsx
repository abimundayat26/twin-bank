import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinancialTwin } from "@/lib/types";
import mockTwin from "@/lib/mock/twin.json";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, getTwin: vi.fn() };
});

const pathname = vi.fn(() => "/");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

import * as api from "@/lib/api";
import { TwinProvider } from "@/lib/state/TwinProvider";
import { AppShell } from "./AppShell";

const TWIN = mockTwin as unknown as FinancialTwin;

function renderShell() {
  return render(
    <TwinProvider>
      <AppShell>
        <main>page body</main>
      </AppShell>
    </TwinProvider>,
  );
}

beforeEach(() => {
  pathname.mockReturnValue("/");
  vi.mocked(api.getTwin).mockResolvedValue({ data: TWIN, source: "api" });
});

describe("AppShell", () => {
  it("uses the dark shell treatment for the header and navigation", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByRole("banner")).toHaveClass("bg-shell", "text-on-shell");
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu).toHaveClass("text-on-shell", "focus-visible:outline-on-shell");

    await user.click(menu);
    expect(document.querySelector("#primary-menu")).toHaveClass(
      "bg-shell",
      "text-on-shell",
    );
  });

  it("names the page the user is on", async () => {
    pathname.mockReturnValue("/simulate");
    renderShell();
    expect(await screen.findByText("Purchase Simulator")).toBeInTheDocument();
  });

  it("renders the page's own content", () => {
    renderShell();
    expect(screen.getByText("page body")).toBeInTheDocument();
  });

  it("identifies the demo user once the twin loads", async () => {
    renderShell();
    expect(await screen.findByText(/Demo user:/)).toBeInTheDocument();
  });
});

describe("provenance badge", () => {
  it("calls a connected backend serving fixture data a demo fixture", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({
      data: { ...TWIN, source: "fixture" },
      source: "api",
    });
    renderShell();
    expect(await screen.findByText("Demo fixture")).toBeInTheDocument();
    expect(screen.getByText("Backend connected")).toBeInTheDocument();
    expect(screen.queryByText("Nessie data")).not.toBeInTheDocument();
  });

  it("says Nessie data only when the twin came from Nessie", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({
      data: { ...TWIN, source: "nessie" },
      source: "api",
    });
    renderShell();
    expect(await screen.findByText("Nessie data")).toBeInTheDocument();
    expect(screen.getByText("Backend connected")).toBeInTheDocument();
  });

  it("names a twin the Databricks job built, rather than calling it unknown", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({
      data: { ...TWIN, source: "databricks" },
      source: "api",
    });
    renderShell();
    expect(await screen.findByText("Databricks build")).toBeInTheDocument();
    expect(screen.getByText("Backend connected")).toBeInTheDocument();
    expect(screen.queryByText("Data source unavailable")).not.toBeInTheDocument();
  });

  it("never claims live data while the backend is unreachable", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({
      data: { ...TWIN, source: "nessie" },
      source: "fixture",
    });
    renderShell();
    expect(await screen.findByText("Backend offline")).toBeInTheDocument();
    expect(screen.getByText("Bundled example")).toBeInTheDocument();
    expect(screen.queryByText("Nessie data")).not.toBeInTheDocument();
  });

  it("admits an unknown source rather than guessing one", async () => {
    vi.mocked(api.getTwin).mockResolvedValue({ data: { ...TWIN, source: null }, source: "api" });
    renderShell();
    expect(await screen.findByText("Data source unavailable")).toBeInTheDocument();
  });
});

describe("Nav", () => {
  it("keeps the menu closed until it is opened", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("lists every destination once opened", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link")).toHaveLength(5);
    expect(within(nav).getByRole("link", { name: /Overview/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Balance Trajectory/ })).toBeInTheDocument();
  });

  it("marks the current page, and says so in text as well as colour", async () => {
    pathname.mockReturnValue("/plans");
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const current = within(nav).getByRole("link", { name: /Plans & Assistant/ });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(within(current).getByText("Current page")).toBeInTheDocument();

    const marked = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(1);
  });

  it("closes on Escape and returns focus to the menu control", async () => {
    const user = userEvent.setup();
    renderShell();
    const button = screen.getByRole("button", { name: "Menu" });
    await user.click(button);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument(),
    );
    expect(button).toHaveFocus();
  });

  // The scrim covers the page while the drawer is open, so a control behind it
  // can be focused but neither seen nor clicked. Tab must not walk out there.
  it("keeps Tab inside the open drawer instead of stranding focus behind the scrim", async () => {
    const user = userEvent.setup();
    render(
      <TwinProvider>
        <AppShell>
          <main>
            <button type="button">Behind the scrim</button>
          </main>
        </AppShell>
      </TwinProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const panel = document.getElementById("primary-menu");
    expect(panel).not.toBeNull();

    // One full lap past the last destination and back round again.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(panel!.contains(document.activeElement)).toBe(true);
    }
    expect(screen.getByRole("button", { name: "Behind the scrim" })).not.toHaveFocus();
  });

  it("wraps Shift+Tab from the drawer's first control to its last", async () => {
    const user = userEvent.setup();
    render(
      <TwinProvider>
        <AppShell>
          <main>
            <button type="button">Behind the scrim</button>
          </main>
        </AppShell>
      </TwinProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const panel = document.getElementById("primary-menu")!;

    for (let i = 0; i < 8; i += 1) {
      await user.tab({ shift: true });
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });

  it("is reachable by keyboard alone", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.tab();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});
