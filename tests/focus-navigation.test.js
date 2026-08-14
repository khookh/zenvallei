import { describe, expect, it, vi } from "vitest";
import { moveSegmentFocus } from "../src/controllers/focus-navigation.js";

describe("segmented-control focus", () => {
  it("wraps in both directions without changing selection", () => {
    const buttons = [{ focus: vi.fn() }, { focus: vi.fn() }, { focus: vi.fn() }];
    const right = { key: "ArrowRight", preventDefault: vi.fn() };
    moveSegmentFocus(right, buttons, buttons[2]);
    expect(buttons[0].focus).toHaveBeenCalledOnce();
    expect(right.preventDefault).toHaveBeenCalledOnce();
    const left = { key: "ArrowLeft", preventDefault: vi.fn() };
    moveSegmentFocus(left, buttons, buttons[0]);
    expect(buttons[2].focus).toHaveBeenCalledOnce();
  });

  it("ignores unrelated keys", () => {
    const button = { focus: vi.fn() };
    moveSegmentFocus({ key: "Enter", preventDefault: vi.fn() }, [button], button);
    expect(button.focus).not.toHaveBeenCalled();
  });
});
