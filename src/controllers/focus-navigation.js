/** Move focus inside a horizontal segmented control without changing state. */
export function moveSegmentFocus(event, buttons, currentButton) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key) || !buttons.length) return;
  event.preventDefault();
  const currentIndex = buttons.indexOf(currentButton);
  const direction = event.key === "ArrowRight" ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}
