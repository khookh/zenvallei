/**
 * Shared SVG chart geometry. Keeping plot bounds separate from axis and
 * readout space prevents translated labels from drifting into the data area.
 */
export function createChartLayout({ width, height, margins, xDomain, yDomain }) {
  const plot = {
    left: margins.left,
    top: margins.top,
    width: width - margins.left - margins.right,
    height: height - margins.top - margins.bottom,
  };
  const scale = (value, [minimum, maximum], start, length, invert = false) => {
    const ratio = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
    return invert ? start + length - ratio * length : start + ratio * length;
  };
  return {
    width,
    height,
    plot,
    x: (value) => scale(value, xDomain, plot.left, plot.width),
    y: (value) => scale(value, yDomain, plot.top, plot.height, true),
  };
}

export function compactEuroTick(value) {
  return `€${Math.round(value / 1_000)}k`;
}

export function landsatHistogramLayout() {
  return createChartLayout({
    width: 760,
    height: 380,
    margins: { left: 92, right: 24, top: 38, bottom: 92 },
    xDomain: [15, 50],
    yDomain: [0, 1],
  });
}

export function heatIncomeLayout() {
  return createChartLayout({
    width: 800,
    height: 680,
    margins: { left: 108, right: 58, top: 42, bottom: 112 },
    xDomain: [20_000, 55_000],
    yDomain: [0, 10],
  });
}
