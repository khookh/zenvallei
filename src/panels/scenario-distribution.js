import { formatNumber, t } from "../i18n.js";
import { escapeHtml } from "../score-utils.js";

function signedTemperature(value) {
  if (!Number.isFinite(value)) return t("value.notAvailable");
  const formatted = formatNumber(Math.abs(value), 2);
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}°C`;
}

export function scenarioDeltaHistogram(stats, { expanded = false } = {}) {
  const distribution = stats?.deltaDistribution;
  const bins = distribution?.bins ?? [];
  if (!bins.length || !distribution?.affectedCellCount) {
    return `<p class="scenario-distribution-empty">${escapeHtml(t("scenario.distributionEmpty"))}</p>`;
  }
  const width = expanded ? 1100 : 440;
  const height = expanded ? 610 : 330;
  const plot = expanded
    ? { left: 105, top: 38, width: 925, height: 440 }
    : { left: 66, top: 28, width: 342, height: 220 };
  const [minimum, maximum] = distribution.domainC;
  const maximumShare = Math.max(...bins.map((bin) => Number(bin.sharePct) || 0), .1);
  const yMagnitude = 10 ** Math.floor(Math.log10(maximumShare));
  const yMaximum = Math.ceil(maximumShare / yMagnitude) * yMagnitude;
  const x = (value) => plot.left + (value - minimum) / Math.max(.000001, maximum - minimum) * plot.width;
  const y = (value) => plot.top + plot.height - value / yMaximum * plot.height;
  const prefix = `scenario-delta-distribution-${expanded ? "expanded" : "inline"}`;
  const xTicks = [minimum, minimum / 2, 0, maximum / 2, maximum]
    .filter((value, index, values) => !index || Math.abs(value - values[index - 1]) > 1e-9);
  const yTicks = [0, yMaximum / 2, yMaximum];
  let interactiveIndex = 0;
  const bars = bins.map((bin, binIndex) => {
    const share = Number(bin.sharePct) || 0;
    const left = x(bin.lowerC);
    const right = x(bin.upperC);
    const top = y(share);
    const midpoint = (bin.lowerC + bin.upperC) / 2;
    const colour = midpoint < 0 ? "#2166ac" : midpoint > 0 ? "#b2182b" : "#6f7778";
    if (!bin.count) {
      return `<rect x="${left}" y="${plot.top + plot.height}" width="${Math.max(1, right - left - .5)}" height="0" fill="${colour}" aria-hidden="true"/>`;
    }
    const tabindex = interactiveIndex++ ? "-1" : "0";
    const label = t("scenario.distributionBinLabel", {
      lower: signedTemperature(bin.lowerC), upper: signedTemperature(bin.upperC),
      count: bin.count, share: formatNumber(share, 2),
    });
    return `<rect x="${left}" y="${top}" width="${Math.max(1, right - left - .5)}" height="${plot.top + plot.height - top}" fill="${colour}" tabindex="${tabindex}" role="graphics-symbol" data-histogram-bin data-focus-key="${prefix}-bin-${binIndex}" data-histogram-label="${escapeHtml(label)}" data-histogram-x="${(left + right) / 2}" aria-label="${escapeHtml(label)}"/>`;
  }).join("");
  return `<div class="scenario-delta-distribution ${expanded ? "is-expanded" : ""}" data-comparison-chart>
    ${expanded ? "" : `<div class="sealed-scatter-actions"><button class="comparison-chart-expand" type="button" data-expand-comparison-chart data-dialog-target="scenario-delta-distribution" aria-label="${escapeHtml(t("chart.expandNamed", { chart: t("scenario.distributionTitle") }))}">${escapeHtml(t("chart.expand"))}</button></div>`}
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${prefix}-title ${prefix}-description">
      <title id="${prefix}-title">${escapeHtml(t("scenario.distributionTitle"))}</title>
      <desc id="${prefix}-description">${escapeHtml(t("scenario.distributionDescription", { count: distribution.affectedCellCount }))}</desc>
      ${yTicks.map((tick) => `<line class="chart-grid" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${y(tick)}" y2="${y(tick)}"/><text class="chart-axis-label" x="${plot.left - 10}" y="${y(tick) + 4}" text-anchor="end">${escapeHtml(formatNumber(tick, tick < 1 ? 1 : 0))}%</text>`).join("")}
      ${bars}
      <line class="scenario-distribution-zero" x1="${x(0)}" x2="${x(0)}" y1="${plot.top}" y2="${plot.top + plot.height}"/>
      <line class="chart-axis" x1="${plot.left}" x2="${plot.left + plot.width}" y1="${plot.top + plot.height}" y2="${plot.top + plot.height}"/>
      ${xTicks.map((tick) => `<text class="chart-axis-label" x="${x(tick)}" y="${plot.top + plot.height + 24}" text-anchor="middle">${escapeHtml(formatNumber(tick, 2))}</text>`).join("")}
      <text class="chart-axis-title" x="${plot.left + plot.width / 2}" y="${height - 18}" text-anchor="middle">${escapeHtml(t("scenario.distributionXAxis"))}</text>
      <text class="chart-axis-title" transform="translate(${expanded ? 27 : 18} ${plot.top + plot.height / 2}) rotate(-90)" text-anchor="middle">${escapeHtml(t("scenario.distributionYAxis"))}</text>
    </svg>
    <output class="comparison-chart-output" data-histogram-output aria-live="polite">${escapeHtml(t("scenario.distributionExplore"))}</output>
  </div>`;
}
