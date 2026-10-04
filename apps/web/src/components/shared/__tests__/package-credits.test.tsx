import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageInfo } from "@covel/shared";
import i18n from "@/i18n";
import {
  subscribeConfirm,
  type PendingConfirm,
} from "@/lib/confirm-channel.js";
import { PackageCredits } from "../package-credits.js";

const info: PackageInfo = {
  version: "1.2.0",
  license: "CC-BY-4.0",
  author: {
    name: "Jane Doe",
    about: {
      "en-US": "I write small mystery worlds.",
      "zh-CN": "我写推理小世界。",
    },
    links: [{ label: "Community", url: "https://chat.example.com/jane" }],
  },
};

describe("PackageCredits", () => {
  let asked: PendingConfirm[];
  let unsubscribe: () => void;
  let open: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    asked = [];
    unsubscribe = subscribeConfirm((pending) => asked.push(pending));
    open = vi.spyOn(window, "open").mockReturnValue(null);
  });
  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it("shows the author, version, license and message in the reader's language", () => {
    render(<PackageCredits info={info} packageName="Tidefall" />);

    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.getByText("v1.2.0")).toBeTruthy();
    expect(screen.getByText("CC-BY-4.0")).toBeTruthy();
    expect(screen.getByText("I write small mystery worlds.")).toBeTruthy();
  });

  it("renders nothing for a package without credits", () => {
    const { container } = render(
      <PackageCredits info={undefined} packageName="Tidefall" />,
    );
    expect(container.innerHTML).toBe("");
  });

  // The address is the package author's, so the player sees where it goes and
  // agrees before anything opens.
  it("opens a link only after the player agrees to the warning", async () => {
    render(<PackageCredits info={info} packageName="Tidefall" />);

    fireEvent.click(screen.getByRole("button", { name: "Community" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(open).not.toHaveBeenCalled();
    expect(asked[0]!.message).toContain("Tidefall");
    expect(asked[0]!.message).toContain("https://chat.example.com/jane");
    expect(asked[0]!.message).toContain("chat.example.com");

    asked[0]!.resolve(false);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Community" }));
    await waitFor(() => expect(asked).toHaveLength(2));
    asked[1]!.resolve(true);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://chat.example.com/jane",
        "_blank",
        "noopener,noreferrer",
      ),
    );
  });
});
