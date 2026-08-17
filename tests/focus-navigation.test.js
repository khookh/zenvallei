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

  it("supports Home and End for accessible tablists", () => {
    const buttons = [document.createElement("button"), document.createElement("button"), document.createElement("button")];
    document.body.append(...buttons);
    moveSegmentFocus({ key: "End", preventDefault: vi.fn() }, buttons, buttons[0]);
    expect(document.activeElement).toBe(buttons[2]);
    moveSegmentFocus({ key: "Home", preventDefault: vi.fn() }, buttons, buttons[2]);
    expect(document.activeElement).toBe(buttons[0]);
  });
});
