// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuideTour, GUIDE_OBSERVATIONS } from "../src/guide-tour.js";

const instantTiming = Object.freeze({
  regionDrawMs: 0,
  regionHoldMs: 0,
  municipalitiesMs: 0,
  municipalitiesHoldMs: 0,
  questionHoldMs: 0,
  observationHoldMs: 0,
  recordRevealMs: 0,
  reducedMotionMunicipalityHoldMs: 0,
});

function elements() {
  document.body.innerHTML = `
    <section id="root" hidden><p id="message"></p><ul id="heatwaves"></ul><time id="date"></time>
      <section id="records"><div id="grid"></div><a id="report"></a></section>
      <button id="pause"></button><button id="exit"></button><button id="explore"></button>
      <button id="retry"></button><div id="error"></div></section>`;
  return Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Guide did not reach the expected state.");
}

function build(overrides = {}) {
  const dom = elements();
  const events = [];
  const guide = createGuideTour({
    root: dom.root,
    message: dom.message,
    heatwaves: dom.heatwaves,
    date: dom.date,
    records: dom.records,
    recordGrid: dom.grid,
    reportLink: dom.report,
    pauseButton: dom.pause,
    exitButton: dom.exit,
    exploreButton: dom.explore,
    retryButton: dom.retry,
    error: dom.error,
    translate: (key) => key,
    reportUrl: () => "https://www.meteo.be/nl/report",
    enter: async () => { events.push("enter"); },
    setRegionProgress: (progress) => events.push(`region:${progress}`),
    setMunicipalityCount: (count) => events.push(`municipality:${count}`),
    prefetchObservation: (id) => events.push(`prefetch:${id}`),
    showObservation: async (id, _signal, options) => {
      events.push(`show:${id}:${options.first}`);
      return id;
    },
    leave: async () => { events.push("leave"); },
    reducedMotion: () => true,
    timing: instantTiming,
    ...overrides,
  });
  return { dom, events, guide };
}

describe("Guide me coordinator", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps geography until the first ready raster and reveals exactly four final records", async () => {
    const { dom, events, guide } = build();
    await guide.start(dom.root);
    await waitFor(() => !dom.explore.hidden);

    expect(events.filter((event) => event.startsWith("show:"))).toEqual(
      GUIDE_OBSERVATIONS.map((id, index) => `show:${id}:${index === 0}`),
    );
    expect(dom.root.dataset.stage).toBe("records");
    expect(dom.grid.querySelectorAll(".guide-record:not([hidden])")).toHaveLength(4);
    expect(dom.report.href).toBe("https://www.meteo.be/nl/report");
    expect(dom.message.textContent).toBe("guide.finalMessage");
  });

  it("retains the last stable frame while a failed observation waits for Retry", async () => {
    let attempts = 0;
    const showObservation = vi.fn(async (id) => {
      attempts += 1;
      if (attempts === 2) throw new Error("temporary range failure");
      return id;
    });
    const { dom, guide } = build({ showObservation });
    await guide.start(dom.root);
    await waitFor(() => !dom.error.hidden);
    expect(dom.date.textContent).toBe(GUIDE_OBSERVATIONS[0]);
    dom.retry.click();
    await waitFor(() => !dom.explore.hidden);
    expect(showObservation).toHaveBeenCalledTimes(5);
    expect(dom.date.textContent).toBe(GUIDE_OBSERVATIONS.at(-1));
  });
});
