// Fixed samples from cmocean 4.0.3 `thermal` (MIT licence). Keeping the table
// local makes every heatwave directly comparable and avoids a runtime package.
export const COMPARISON_THERMAL = Object.freeze([
  [0, [4, 35, 51]],
  [0.125, [25, 51, 124]],
  [0.25, [86, 59, 156]],
  [0.375, [131, 80, 143]],
  [0.5, [177, 95, 130]],
  [0.625, [223, 112, 100]],
  [0.75, [249, 147, 65]],
  [0.875, [249, 198, 65]],
  [1, [232, 250, 91]],
]);

export function thermalColor(encoded) {
  const position = Math.max(0, Math.min(1, Number(encoded) / 255));
  const rightIndex = Math.max(1, COMPARISON_THERMAL.findIndex(([stop]) => stop >= position));
  const [left, leftColor] = COMPARISON_THERMAL[rightIndex - 1];
  const [right, rightColor] = COMPARISON_THERMAL[rightIndex];
  const amount = right === left ? 0 : (position - left) / (right - left);
  return leftColor.map((channel, index) => Math.round(channel + amount * (rightColor[index] - channel)));
}

export const comparisonHeatGradient = () => `linear-gradient(90deg, ${COMPARISON_THERMAL
  .map(([stop, color]) => `rgb(${color.join(" ")}) ${stop * 100}%`).join(", ")})`;

export const comparisonLegendItems = () => COMPARISON_THERMAL.map(([position, color]) => ({
  label: String(Math.round(15 + position * 35)),
  value: String(Math.round(15 + position * 35)),
  color: `rgb(${color.join(" ")})`,
}));
