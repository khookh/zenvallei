// @ts-check

/**
 * Owns the opening project dialog without depending on map or data state.
 * Native dialog behaviour supplies the modal focus boundary and inert page.
 */
export function createProjectIntro({
  dialog,
  closeButton,
  primaryButton,
  languageButton,
  focusAfterClose,
  getLanguage,
  translate,
  onLanguageChange,
}) {
  if (!(dialog instanceof HTMLDialogElement)) throw new TypeError("The project introduction requires a dialog element.");
  if (![closeButton, primaryButton, languageButton].every((element) => element instanceof HTMLButtonElement)) {
    throw new TypeError("The project introduction requires its three buttons.");
  }

  const setLanguage = () => {
    const targetLanguage = getLanguage() === "nl" ? "en" : "nl";
    const label = translate(targetLanguage === "en" ? "language.switchEnglish" : "language.switchDutch");
    languageButton.textContent = targetLanguage.toUpperCase();
    languageButton.lang = targetLanguage;
    languageButton.setAttribute("aria-label", label);
    languageButton.title = label;
  };

  const close = () => {
    if (dialog.open) dialog.close();
  };

  const open = () => {
    if (dialog.open) return;
    dialog.showModal();
    requestAnimationFrame(() => primaryButton.focus({ preventScroll: true }));
  };

  closeButton.addEventListener("click", close);
  primaryButton.addEventListener("click", close);
  languageButton.addEventListener("click", () => {
    onLanguageChange(getLanguage() === "nl" ? "en" : "nl");
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (focusAfterClose instanceof HTMLElement) focusAfterClose.focus({ preventScroll: true });
  });

  return Object.freeze({ open, close, setLanguage });
}
