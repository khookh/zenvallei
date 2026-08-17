/** Move focus inside a horizontal segmented control without changing state. */
export function moveSegmentFocus(event, buttons, currentButton) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !buttons.length) return;
  event.preventDefault();
  if (event.key === "Home") { buttons[0].focus(); return; }
  if (event.key === "End") { buttons.at(-1).focus(); return; }
  const currentIndex = buttons.indexOf(currentButton);
  const direction = event.key === "ArrowRight" ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}
