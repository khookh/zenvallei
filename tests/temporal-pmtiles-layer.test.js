import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ addProtocol: vi.fn() }));
vi.mock("pmtiles", () => ({ Protocol: class { tile() {} } }));

import { createTemporalPmtilesMap } from "../src/layers/temporal-pmtiles-layer.js";

class FakeMap {
  constructor() {
    this.layers = new Map();
    this.sources = new Map();
    this.listeners = new Map();
    this.sourceLoaded = false;
    this.addSourceCalls = 0;
  }

  on(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  off(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, event) { this.listeners.get(name)?.forEach((listener) => listener(event)); }
  getLayer(id) { return this.layers.get(id); }
  getSource(id) { return this.sources.get(id); }
  addSource(id, source) { this.addSourceCalls += 1; this.sources.set(id, source); }
  removeSource(id) { this.sources.delete(id); }
  addLayer(layer) { this.layers.set(layer.id, structuredClone(layer)); }
  removeLayer(id) { this.layers.delete(id); }
  isSourceLoaded() { return this.sourceLoaded; }
  setLayoutProperty(id, property, value) { this.layers.get(id).layout[property] = value; }
  setPaintProperty(id, property, value) { this.layers.get(id).paint[property] = value; }
  triggerRepaint() {}
}

const createSubject = () => createTemporalPmtilesMap({
  layerId: "test-raster",
  sourceId: "test-source",
  getArchiveUrl: () => "/test.pmtiles",
});

describe("temporal PMTiles readiness", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 206 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ignores errors from unrelated raster sources", async () => {
    const map = new FakeMap();
    const subject = createSubject();
    await subject.mount(map, {});
    const readiness = subject.whenReady();
    map.emit("error", { sourceId: "osm", error: new Error("Raster tile failed") });
    expect(subject.getReadiness().status).toBe("loading");
    map.sourceLoaded = true;
    map.emit("sourcedata", { sourceId: "test-source" });
    await expect(readiness).resolves.toBe(1);
  });

  it("re-arms a failed source when the same URL is retried", async () => {
    const map = new FakeMap();
    const subject = createSubject();
    await subject.mount(map, {});
    const firstAttempt = subject.whenReady();
    map.emit("error", { sourceId: "test-source", error: new Error("temporary failure") });
    await expect(firstAttempt).rejects.toThrow("temporary failure");
    expect(subject.getReadiness().status).toBe("error");

    const retry = subject.whenReady({ retry: true });
    expect(map.addSourceCalls).toBe(2);
    map.sourceLoaded = true;
    map.emit("sourcedata", { sourceId: "test-source" });
    await expect(retry).resolves.toBe(2);
    expect(subject.getReadiness().status).toBe("ready");
  });

  it("reasserts visibility and opacity after readiness", async () => {
    const map = new FakeMap();
    const subject = createSubject();
    await subject.mount(map, {});
    subject.setVisible(true);
    subject.setOpacity(0.2);
    map.sourceLoaded = true;
    map.emit("sourcedata", { sourceId: "test-source" });
    await subject.whenReady();
    expect(map.getLayer("test-raster").layout.visibility).toBe("visible");
    expect(map.getLayer("test-raster").paint["raster-opacity"]).toBe(0.2);
  });

  it("rejects an archive HTTP failure before trusting MapLibre's initial loaded state", async () => {
    fetch.mockResolvedValueOnce({ status: 503 });
    const map = new FakeMap();
    map.sourceLoaded = true;
    const subject = createSubject();
    await subject.mount(map, {});
    await expect(subject.whenReady()).rejects.toThrow("Raster archive HTTP 503");
    expect(subject.getReadiness().status).toBe("error");
  });
});
