let densityBands = [];
let scope = null;
let width = 0;
let height = 0;

const RAMPS = Object.freeze({
  sealed: [[255, 245, 240], [252, 187, 161], [251, 106, 74], [203, 24, 29], [103, 0, 13]],
  green: [[247, 252, 245], [199, 233, 192], [116, 196, 118], [35, 139, 69], [0, 68, 27]],
});

function colourFor(value, ramp) {
  const scaled = Math.max(0, Math.min(1, value / 100)) * (ramp.length - 1);
  const start = Math.floor(scaled);
  const end = Math.min(ramp.length - 1, start + 1);
  const mix = scaled - start;
  return ramp[start].map((component, index) => Math.round(component + (ramp[end][index] - component) * mix));
}

self.onmessage = ({ data }) => {
  if (data.type === "initialise") {
    ({ densityBands, scope, width, height } = data);
    self.postMessage({ type: "ready", generation: data.generation });
    return;
  }
  if (data.type !== "render") return;
  const output = new Uint8ClampedArray(width * height * 4);
  const ramp = RAMPS[data.palette] ?? RAMPS.green;
  for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += 4) {
    const municipality = scope[offset];
    const inside = scope[offset + 1] > 0;
    if (!inside || (data.municipalityIndex && municipality !== data.municipalityIndex)) continue;
    let percentage = 0;
    let valid = true;
    for (const band of data.selectedBands) {
      const encoded = densityBands[band][pixel];
      if (encoded === 65535) {
        valid = false;
        break;
      }
      percentage += encoded / 100;
    }
    if (!valid) continue;
    const colour = colourFor(Math.min(100, percentage), ramp);
    output[offset] = colour[0];
    output[offset + 1] = colour[1];
    output[offset + 2] = colour[2];
    output[offset + 3] = 230;
  }
  self.postMessage({ type: "rendered", generation: data.generation, output }, [output.buffer]);
};
