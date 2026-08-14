import { describe, expect, it } from "vitest";
import {
  DELTA_STOPS,
  DELTA_ALPHA_STOPS,
  SCENARIO_COVER_OPACITY,
  SCENARIO_COVER_WITH_DELTA_OPACITY,
  createLandCoverScenarioLayer,
  scenarioDeltaColour,
  scenarioDeltaStyle,
  scenarioOperationForTarget,
  scenarioPointPopupModel,
  validateScenarioDescriptor,
  validateScenarioManifest,
  validateScenarioResult,
} from "../src/layers/land-cover-scenario-layer.js";
import {
  GROUND, applyOperation, boundsIntersect, operationBounds, sourceState,
} from "../src/layers/scenario-cover-raster.js";
import { setLanguage } from "../src/i18n.js";
import { renderSectorPanelModel } from "../src/panel.js";

describe("public land-cover scenario contract", () => {
  it("accepts only the pinned mixed-year descriptor", () => {
    const descriptor = {
      datasetId: "land-cover-scenario", kind: "scenario",
      baselineYears: { greenMap: 2021, urbanAtlas: 2021, soilSealing: 2024, landUseWater: 2025 },
      manifestUrl: "/data/official-layers/land-cover-scenario/manifest.json",
    };
    expect(validateScenarioDescriptor(descriptor)).toBe(descriptor);
    expect(() => validateScenarioDescriptor({ ...descriptor, baselineYears: { ...descriptor.baselineYears, soilSealing: 2021 } })).toThrow();
    expect(() => validateScenarioDescriptor({ ...descriptor, baselineYears: { ...descriptor.baselineYears, urbanAtlas: 2022 } })).toThrow();
  });

  it("pins the Radoux thermal support in the manifest", () => {
    const manifest = {
      schemaVersion: 7, datasetId: "land-cover-scenario",
      baselineYears: { greenMap: 2021, urbanAtlas: 2021, soilSealing: 2024, landUseWater: 2025 },
      maskResolutionMeters: 1, temperatureGridResolutionMeters: 30,
      psf: { sigmaMeters: 79.5, gridResolutionMeters: 15, kernelSize: 41 },
      methodOrder: ["radoux", "xgboost"],
      methods: {
        radoux: { source: { url: "https://doi.org/10.3390/rs17162815" } },
        xgboost: {
          available: true, modelContractVersion: 5,
          modelSha256: "model", featureArtifactSha256: "features",
          catalogManifestSha256: "catalog", inferenceGrid: { sha256: "grid" },
          source: { url: "https://github.com/khookh/zenvallei/blob/main/playground/xgboost_2026_heatwave_regression_zennevallei.ipynb" },
        },
      },
      urbanAtlasClassMaskUrl: "shared/urban-atlas-classes-2021.pmtiles",
      urbanAtlasClassIndexes: { "50000": 7 },
      analysisWaterMask: {
        url: "land-cover-scenario/analysis-water-landgebruik-2025.pmtiles",
        sha256: "abc", rendered: false, editable: false,
      },
      browserRuntime: {
        protocolVersion: 1,
        baseline: { url: "land-cover-scenario/scenario-baseline-1m.tif" },
        outputScopes: { url: "land-cover-scenario/scenario-output-scopes.bin.gz" },
      },
      limits: { submittedAreaHa: 200 },
    };
    expect(validateScenarioManifest(manifest)).toBe(manifest);
    expect(() => validateScenarioManifest({ ...manifest, psf: { ...manifest.psf, sigmaMeters: 80 } })).toThrow();
  });

  it("rejects stale or legacy scenario calculation responses", () => {
    const result = {
      schemaVersion: 7, sessionId: "session-123", revision: 2,
      deltaRasters: { radoux: { values: new ArrayBuffer(4) } },
      scopeStats: { region: { acceptedAreaHa: 1, deltaDistribution: {
        affectedThresholdC: .01, affectedCellCount: 0, bins: [],
      } } },
    };
    expect(validateScenarioResult(result, "session-123", 2)).toBe(result);
    expect(() => validateScenarioResult({ ...result, schemaVersion: 4 }, "session-123", 2)).toThrow();
    expect(() => validateScenarioResult(result, "session-123", 3)).toThrow();
  });

  it("uses stable cooling, neutral and warming colours", () => {
    expect(DELTA_STOPS[0]).toBe(-14.12);
    expect(DELTA_STOPS.at(-1)).toBe(14.12);
    expect(scenarioDeltaColour(-10.62)).toEqual([33, 102, 172]);
    expect(scenarioDeltaStyle(0).alpha).toBe(0);
    expect(scenarioDeltaStyle(-.1).alpha).toBeGreaterThan(0);
    expect(scenarioDeltaStyle(-2).alpha).toBeGreaterThan(scenarioDeltaStyle(-.5).alpha);
    expect(scenarioDeltaStyle(2).alpha).toBe(scenarioDeltaStyle(-2).alpha);
    expect(scenarioDeltaColour(10.62)).toEqual([178, 24, 43]);
    expect(scenarioDeltaColour(-100)).toEqual(scenarioDeltaColour(-10.62));
    expect(DELTA_ALPHA_STOPS.map(([value]) => value)).toEqual([
      0, .01, .025, .05, .1, .25, .5, 1, 2, 14.12,
    ]);
    const alpha = DELTA_ALPHA_STOPS.map(([, value]) => value);
    expect(alpha.every((value, index) => !index || value >= alpha[index - 1])).toBe(true);
    expect(scenarioDeltaStyle(.009).alpha).toBe(0);
    expect(scenarioDeltaStyle(.025).alpha).toBe(89);
    expect(scenarioDeltaStyle(.1).alpha).toBe(166);
    expect(scenarioDeltaStyle(.5).alpha).toBe(224);
    expect(scenarioDeltaStyle(14.12).alpha).toBe(255);
    expect(SCENARIO_COVER_OPACITY).toBe(.78);
    expect(SCENARIO_COVER_WITH_DELTA_OPACITY).toBe(.48);
  });

  it("models low vegetation as a conversion from sealed or other unsealed ground", () => {
    expect(scenarioOperationForTarget("unseal")).toEqual({ action: "convert-to-low", target: "low" });
    expect(scenarioOperationForTarget("remove-high")).toEqual({ action: "remove-high", target: null });
    expect(() => scenarioOperationForTarget("low")).toThrow();
    expect(() => scenarioOperationForTarget("bare")).toThrow();
  });

  it("finishes a valid polygon and leaves drawing mode before calculation", async () => {
    const layer = createLandCoverScenarioLayer({
      descriptor: {
        datasetId: "land-cover-scenario", kind: "scenario", available: true,
        baselineYears: { greenMap: 2021, urbanAtlas: 2021, soilSealing: 2024, landUseWater: 2025 },
        manifestUrl: "/scenario.json", assetRoot: "/assets/",
      },
      groenkaartLayer: {}, jaarbakLayer: {},
    });
    expect(layer.getRuntimeData().selectedMethod).toBe("xgboost");
    expect(layer.beginScenarioPolygon()).toBe(true);
    for (const [lng, lat] of [[4.2, 50.7], [4.21, 50.7], [4.21, 50.71]]) {
      expect(layer.handleMapClick({ lngLat: { lng, lat } })).toBe(true);
    }
    expect(await layer.finishScenarioPolygon()).toBe(false);
    expect(layer.isDrawingActive()).toBe(false);
    expect(layer.getRuntimeData().operations).toHaveLength(1);
  });

  it("derives one exclusive ground class plus optional high canopy", () => {
    const pixel = (red, green, blue, alpha = 255) => ({ data: new Uint8ClampedArray([red, green, blue, alpha]) });
    const highOverSealed = sourceState(
      pixel(31, 127, 0), pixel(232, 41, 47), pixel(1, 0, 0), 0, 21,
    );
    expect(highOverSealed).toEqual({ ground: GROUND.sealed, canopy: true, editable: true });
    const hiddenWater = sourceState(
      pixel(31, 127, 0), pixel(232, 41, 47), pixel(1, 0, 0), 0, 21,
      pixel(255, 0, 0),
    );
    expect(hiddenWater).toEqual({ ground: GROUND.sealed, canopy: true, editable: false });
    const agriculture = sourceState(
      pixel(255, 255, 0), pixel(232, 41, 47), pixel(1, 0, 0), 0, 21,
    );
    expect(agriculture).toEqual({ ground: GROUND.agriculture, canopy: false, editable: false });
    const unavailable = sourceState(
      pixel(0, 0, 0, 0), pixel(232, 41, 47), pixel(1, 0, 0), 0, 21,
    );
    expect(unavailable).toEqual({ ground: GROUND.locked, canopy: false, editable: false });
    expect(sourceState(
      pixel(31, 127, 0), pixel(232, 41, 47), pixel(0, 0, 0, 0), 0, 21,
    )).toBeNull();
  });

  it("applies ground and canopy conversions without baseline bleed-through", () => {
    const baseline = { ground: GROUND.sealed, canopy: true, editable: true };
    let state = applyOperation({ ...baseline }, baseline, { action: "convert-to-low", target: "low" });
    expect(state).toEqual({ ground: GROUND.low, canopy: true, editable: true });
    const bare = { ground: GROUND.bare, canopy: false, editable: true };
    expect(applyOperation({ ...bare }, bare, { action: "convert-to-low", target: "low" }))
      .toEqual({ ground: GROUND.low, canopy: false, editable: true });
    state = applyOperation(state, baseline, { action: "convert", target: "sealed" });
    expect(state).toEqual({ ground: GROUND.sealed, canopy: true, editable: true });
    state = applyOperation(state, baseline, { action: "remove-high", target: null });
    expect(state).toEqual({ ground: GROUND.sealed, canopy: false, editable: true });
    state = applyOperation(state, baseline, { action: "convert", target: "high" });
    expect(state).toEqual({ ground: GROUND.sealed, canopy: true, editable: true });
    state = applyOperation(state, baseline, { action: "restore", target: null });
    expect(state).toEqual(baseline);
  });

  it("keeps the latest ground operation, preserves canopy and locks unsupported cells", () => {
    const baseline = { ground: GROUND.low, canopy: true, editable: true };
    let state = applyOperation({ ...baseline }, baseline, { action: "convert", target: "sealed" });
    expect(state).toEqual({ ground: GROUND.sealed, canopy: true, editable: true });
    state = applyOperation(state, baseline, { action: "convert-to-low", target: "low" });
    expect(state).toEqual(baseline);

    const water = { ground: GROUND.water, canopy: false, editable: false };
    expect(applyOperation({ ...water }, water, { action: "convert", target: "high" })).toEqual(water);
    expect(applyOperation({ ...water }, water, { action: "convert", target: "sealed" })).toEqual(water);
  });

  it("keeps scenario inspection to Urban Atlas context and the selected visible estimate", () => {
    const value = {
      status: "available", urbanAtlasClassCode: "11100",
      deltaCByMethod: { radoux: -.42, xgboost: -.31 },
      baselineGround: "sealed", simulatedGround: "low",
      baselineHighCanopy: false, simulatedHighCanopy: false,
      outsideTrainingRange: true, editable: true,
    };
    const radoux = scenarioPointPopupModel(value, "radoux");
    expect(radoux.lines).toHaveLength(2);
    expect(radoux.lines[0]).toContain("Urban Atlas");
    expect(radoux.lines[1]).toContain("Radoux");
    expect(radoux.lines.join(" ")).not.toMatch(/ground|canopy|editable|XGBoost|training range/i);

    const xgboost = scenarioPointPopupModel(value, "xgboost");
    expect(xgboost.lines).toHaveLength(2);
    expect(xgboost.lines[1]).toContain("XGBoost");
    expect(xgboost.lines.join(" ")).not.toContain("Radoux et al. model");

    expect(scenarioPointPopupModel({ ...value, deltaCByMethod: { ...value.deltaCByMethod, radoux: .009 } }, "radoux").lines).toHaveLength(1);
    expect(scenarioPointPopupModel({ status: "available", deltaCByMethod: { radoux: 0 } }, "radoux")).toBeNull();
    expect(scenarioPointPopupModel({ status: "unavailable" }, "radoux")).toBeNull();
  });

  it("limits polygon and multipolygon work to intersecting map tiles", () => {
    const polygon = { geometry: { type: "Polygon", coordinates: [[
      [4.1, 50.7], [4.3, 50.7], [4.3, 50.8], [4.1, 50.8], [4.1, 50.7],
    ], [
      [4.15, 50.72], [4.2, 50.72], [4.2, 50.75], [4.15, 50.72],
    ]] } };
    expect(operationBounds(polygon)).toEqual([4.1, 50.7, 4.3, 50.8]);
    const multipolygon = { geometry: { type: "MultiPolygon", coordinates: [
      [[[4, 50], [4.1, 50], [4, 50.1], [4, 50]]],
      [[[5, 51], [5.1, 51], [5, 51.1], [5, 51]]],
    ] } };
    expect(operationBounds(multipolygon)).toEqual([4, 50, 5.1, 51.1]);
    expect(boundsIntersect(operationBounds(polygon), [4.2, 50.75, 4.4, 50.9])).toBe(true);
    expect(boundsIntersect(operationBounds(polygon), [5, 51, 6, 52])).toBe(false);
  });

  it("renders exact before/change/after balances and four methodology sections", () => {
    setLanguage("en");
    const html = renderSectorPanelModel({
      template: "land-cover-scenario",
      record: { scope: "region", sectorName: "Entire Zennevallei", sectorCount: 154 },
      selectedMethod: "xgboost", hasResult: true,
      manifest: {
        source: { url: "https://doi.org/10.3390/rs17162815" },
        methods: { xgboost: { available: true, smoothingSigmaMeters: 60,
          source: { url: "https://github.com/khookh/zenvallei/blob/main/playground/xgboost_2026_heatwave_regression_zennevallei.ipynb" } } },
      },
      stats: {
        acceptedAreaHa: 1.25, affectedCellCount: 4, medianDeltaC: -.2,
        strongestCoolingC: -.8, strongestWarmingC: .4,
        deltaDistribution: {
          affectedThresholdC: .01, affectedCellCount: 4, domainC: [-1, 1], binWidthC: .5,
          bins: [
            { lowerC: -1, upperC: -.5, count: 1, sharePct: 25 },
            { lowerC: -.5, upperC: 0, count: 2, sharePct: 50 },
            { lowerC: 0, upperC: .5, count: 1, sharePct: 25 },
            { lowerC: .5, upperC: 1, count: 0, sharePct: 0 },
          ],
        },
        ignoredAreaHa: .1, noChangeAreaHa: .2, outsideScopeAreaHa: 0,
        transitions: { "sealed-to-low": 1.25 },
        landCoverBalance: {
          ground: {
            low: { beforeHa: 10, changeHa: 1.25, afterHa: 11.25 },
            sealed: { beforeHa: 5, changeHa: -1.25, afterHa: 3.75 },
            agriculture: { beforeHa: 4, changeHa: 0, afterHa: 4 },
            water: { beforeHa: 1, changeHa: 0, afterHa: 1 },
            bare: { beforeHa: 2, changeHa: 0, afterHa: 2 },
          },
          highCanopy: { beforeHa: 7, changeHa: .4, afterHa: 7.4 },
          validAnalysedAreaHa: 22, lockedUnavailableAreaHa: .3,
        },
      },
    });
    expect(html).toContain("Ground composition");
    expect(html).toContain("High-vegetation canopy");
    expect(html).toContain("+1.25 ha");
    expect(html).toContain("Strongest estimated cooling");
    expect(html).toContain("Distribution of estimated temperature changes");
    expect(html).not.toContain("Locked or unsupported area");
    expect(html).toContain('data-chart-dialog-id="scenario-delta-distribution"');
    expect(html).toContain("Shared calculation");
    expect(html).not.toContain("Radoux et al. (2025) estimated");
    expect(html).toContain("2026 Heatwave XGBoost");
    expect(html).toContain("22 June 2026 at 12:33 CEST");
    expect(html).toContain("xgboost_2026_heatwave_regression_zennevallei.ipynb");
    expect(html).toContain("Limitations");
  });
});
