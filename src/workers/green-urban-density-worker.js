let densityBands = [];
let scope = null;
let fabric = null;
let width = 0;
let height = 0;

const RAMP = [[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]];

function colourFor(value) {
  const scaled = Math.max(0, Math.min(1, value / 100)) * (RAMP.length - 1);
  const start = Math.floor(scaled);
  const end = Math.min(RAMP.length - 1, start + 1);
  const mix = scaled - start;
  return RAMP[start].map((component, index) => Math.round(
    component + (RAMP[end][index] - component) * mix,
  ));
}

self.onmessage = ({ data }) => {
  if (data.type === "initialise") {
    ({ densityBands, scope, fabric, width, height } = data);
    self.postMessage({ type: "ready" });
    return;
  }
  if (data.type !== "render") return;
  const selectedFabric = new Set(data.selectedFabricIndexes);
  const output = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 4) {
    const municipality = scope[offset];
    if (!scope[offset + 1]
      || (data.municipalityIndex && municipality !== data.municipalityIndex)
      || !selectedFabric.has(fabric[offset])) continue;
    let percentage = 0;
    let valid = true;
    for (const band of data.selectedDensityBands) {
      const encoded = densityBands[band][pixel];
      if (encoded === data.noDataValue) { valid = false; break; }
      percentage += encoded / data.encodingScale;
    }
    if (!valid) continue;
    const colour = colourFor(Math.min(100, percentage));
    output[offset] = colour[0];
    output[offset + 1] = colour[1];
    output[offset + 2] = colour[2];
    output[offset + 3] = 232;
  }
  self.postMessage({ type: "rendered", generation: data.generation, output }, [output.buffer]);
};
