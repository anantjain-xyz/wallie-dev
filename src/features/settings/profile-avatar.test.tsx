// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";

import { ProfileAvatar } from "./profile-avatar";

describe("ProfileAvatar", () => {
  it("falls back to initials when the current image URL fails", () => {
    const { container, rerender } = render(
      <ProfileAvatar name="Ada Lovelace" url="https://provider.example/broken.png" />,
    );

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image!);

    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("A");

    rerender(<ProfileAvatar name="Ada Lovelace" url="https://provider.example/refreshed.png" />);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://provider.example/refreshed.png",
    );
  });
});
