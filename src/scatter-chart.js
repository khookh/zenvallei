/** Draw large pixel scatter clouds without placing tens of thousands of SVG nodes in the DOM. */
export function mountPixelScatterCharts(root, model) {
  root.querySelectorAll("canvas[data-pixel-scatter-canvas]").forEach((canvas) => {
    const points = canvas.dataset.pixelScatterSource === "densityScatter"
      ? model.densityScatter.pixelPoints
      : model?.pixelPoints;
    if (!Array.isArray(points) && !ArrayBuffer.isView(points)) return;
    const context = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const left = Number(canvas.dataset.plotLeft);
    const top = Number(canvas.dataset.plotTop);
    const plotWidth = Number(canvas.dataset.plotWidth);
    const plotHeight = Number(canvas.dataset.plotHeight);
    const xMin = Number(canvas.dataset.xMin);
    const xMax = Number(canvas.dataset.xMax);
    const yMin = Number(canvas.dataset.yMin);
    const yMax = Number(canvas.dataset.yMax);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(26,94,104,0.18)";
    const draw = (xValue, yValue) => {
      const x = left + (xValue - xMin) / Math.max(1e-9, xMax - xMin) * plotWidth;
      const y = top + plotHeight - (yValue - yMin) / Math.max(1e-9, yMax - yMin) * plotHeight;
      if (x < left || x > left + plotWidth || y < top || y > top + plotHeight) return;
      context.fillRect(x - .7, y - .7, 1.4, 1.4);
    };
    if (ArrayBuffer.isView(points)) {
      for (let index = 0; index < points.length; index += 2) draw(points[index], points[index + 1]);
    } else {
      for (const [xValue, yValue] of points) draw(xValue, yValue);
    }
  });
}
