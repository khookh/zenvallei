import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectIntro } from "../src/project-intro.js";

function fixture() {
  document.body.innerHTML = `
    <button id="after">About</button>
    <dialog id="intro">
      <button id="language" type="button">EN</button>
      <button id="close" type="button">Close</button>
      <button id="primary" type="button">Open map</button>
    </dialog>`;
  const dialog = document.querySelector("#intro");
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  });
  let language = "nl";
  let api;
  const onLanguageChange = vi.fn((nextLanguage) => {
    language = nextLanguage;
    api.setLanguage();
  });
  api = createProjectIntro({
    dialog,
    closeButton: document.querySelector("#close"),
    primaryButton: document.querySelector("#primary"),
    languageButton: document.querySelector("#language"),
    focusAfterClose: document.querySelector("#after"),
    getLanguage: () => language,
    translate: (key) => ({
      "language.switchEnglish": "Switch to English",
      "language.switchDutch": "Switch to Dutch",
    })[key],
    onLanguageChange,
  });
  return { api, dialog, onLanguageChange };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback) => callback());
});

describe("project introduction", () => {
  it("opens modally, focuses the primary action and restores focus after closing", () => {
    const { api, dialog } = fixture();
    api.open();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(document.querySelector("#primary"));

    document.querySelector("#primary").click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(document.querySelector("#after"));
  });

  it("switches the target language and closes on Escape cancellation", () => {
    const { api, dialog, onLanguageChange } = fixture();
    api.setLanguage();
    expect(document.querySelector("#language").textContent).toBe("EN");
    expect(document.querySelector("#language").getAttribute("aria-label")).toBe("Switch to English");
    document.querySelector("#language").click();
    expect(onLanguageChange).toHaveBeenCalledWith("en");
    expect(document.querySelector("#language").textContent).toBe("NL");

    api.open();
    const cancelEvent = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
  });
});
