import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
  it("renders the placeholder and reports typed input", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} placeholder="Search connections…" />);

    const input = screen.getByPlaceholderText("Search connections…");
    fireEvent.change(input, { target: { value: "prod" } });
    expect(onChange).toHaveBeenCalledWith("prod");
  });

  it("shows a clear button only when there is a value, and clears on click", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput value="" onChange={onChange} />);
    // No value → no clear button.
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<SearchInput value="prod" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
