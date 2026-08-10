import { formatNumber, t } from "./i18n.js";
import { surroundingAreaHa } from "./comparisons/sealed-urban-shared.js";

function pointAt(points, index) {
  return ArrayBuffer.isView(points)
    ? [points[index * 2], points[index * 2 + 1]]
    : points[index];
}

function pointCount(points) {
  return ArrayBuffer.isView(points) ? Math.floor(points.length / 2) : points.length;
}

function pointReadout(comparisonId, xValue, yValue) {
  if (comparisonId === "landsat-jaarbak-density") {
    return t("soilComparison.densityPointReadout", {
      density: formatNumber(xValue, 1),
      area: formatNumber(surroundingAreaHa(xValue), 2),
      temperature: formatNumber(yValue, 1),
    });
  }
  if (comparisonId === "landsat-groenkaart") {
    return t("landsatGreen.pointReadout", {
      density: formatNumber(xValue, 1),
      area: formatNumber(surroundingAreaHa(xValue), 2),
      temperature: formatNumber(yValue, 1),
    });
  }
  return `${formatNumber(xValue, 1)} · ${formatNumber(yValue, 1)}`;
}

/** Draw and inspect large scatter clouds without adding one DOM node per observation. */
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
    const comparisonId = canvas.dataset.comparisonId;
    const bucketSize = 12;
    const buckets = new Map();
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(26,94,104,0.18)";
    const draw = (xValue, yValue, pointIndex) => {
      const x = left + (xValue - xMin) / Math.max(1e-9, xMax - xMin) * plotWidth;
      const y = top + plotHeight - (yValue - yMin) / Math.max(1e-9, yMax - yMin) * plotHeight;
      if (x < left || x > left + plotWidth || y < top || y > top + plotHeight) return;
      context.fillRect(x - .7, y - .7, 1.4, 1.4);
      const key = `${Math.floor((x - left) / bucketSize)}:${Math.floor((y - top) / bucketSize)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(pointIndex);
    };
    if (ArrayBuffer.isView(points)) {
      for (let index = 0; index < points.length; index += 2) draw(points[index], points[index + 1], index / 2);
    } else {
      points.forEach(([xValue, yValue], index) => draw(xValue, yValue, index));
    }

    const stage = canvas.closest(".sealed-scatter-stage");
    const hitArea = stage?.querySelector("[data-pixel-scatter-hit]");
    const output = stage?.closest(".sealed-urban-scatter")?.querySelector("[data-scatter-output]");
    if (!hitArea || !output) return;
    const count = pointCount(points);
    let keyboardIndex = 0;
    const showPoint = (index) => {
      if (!count) return;
      keyboardIndex = Math.max(0, Math.min(count - 1, index));
      const [xValue, yValue] = pointAt(points, keyboardIndex);
      output.textContent = pointReadout(comparisonId, xValue, yValue);
    };
    hitArea.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? keyboardIndex + 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? keyboardIndex - 1
          : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
      if (next == null) return;
      event.preventDefault();
      showPoint(next);
    });
    hitArea.addEventListener("focus", () => showPoint(keyboardIndex));
    hitArea.addEventListener("pointermove", (event) => {
      const bounds = hitArea.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !count) return;
      const chartX = left + (event.clientX - bounds.left) / bounds.width * plotWidth;
      const chartY = top + (event.clientY - bounds.top) / bounds.height * plotHeight;
      const xValue = xMin + (chartX - left) / plotWidth * (xMax - xMin);
      const yValue = yMax - (chartY - top) / plotHeight * (yMax - yMin);
      // Find the nearest observation in data space. Throttle to one lookup per
      // animation frame; this keeps the complete scientific point set intact.
      if (hitArea.dataset.lookupPending) return;
      hitArea.dataset.lookupPending = "true";
      requestAnimationFrame(() => {
        delete hitArea.dataset.lookupPending;
        let nearest = keyboardIndex;
        let distance = Infinity;
        const bucketX = Math.floor((chartX - left) / bucketSize);
        const bucketY = Math.floor((chartY - top) / bucketSize);
        for (let radius = 0; radius <= 2 && distance === Infinity; radius += 1) {
          for (let xOffset = -radius; xOffset <= radius; xOffset += 1) {
            for (let yOffset = -radius; yOffset <= radius; yOffset += 1) {
              const candidates = buckets.get(`${bucketX + xOffset}:${bucketY + yOffset}`) ?? [];
              for (const index of candidates) {
                const [candidateX, candidateY] = pointAt(points, index);
                const dx = (candidateX - xValue) / Math.max(1e-9, xMax - xMin);
                const dy = (candidateY - yValue) / Math.max(1e-9, yMax - yMin);
                const candidateDistance = dx * dx + dy * dy;
                if (candidateDistance < distance) { distance = candidateDistance; nearest = index; }
              }
            }
          }
        }
        if (distance !== Infinity) showPoint(nearest);
      });
    });
  });
}
