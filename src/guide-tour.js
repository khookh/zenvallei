// A deliberately fixed story, not a reusable tour framework. The coordinator
// owns timing and cancellation; map presentation remains in map-controller.
export const GUIDE_OBSERVATIONS = Object.freeze([
  "landsat-2023-06-13",
  "landsat-2023-09-09",
  "landsat-2025-08-13",
  "landsat-2026-06-22",
]);

export const GUIDE_HEATWAVES = Object.freeze([
  "guide.heatwave.2023June",
  "guide.heatwave.2023September",
  "guide.heatwave.2025August",
  "guide.heatwave.2026June",
]);

export const GUIDE_RECORDS = Object.freeze([
  Object.freeze({ value: "guide.record.durationValue", detail: "guide.record.durationDetail" }),
  Object.freeze({ value: "guide.record.tropicalValue", detail: "guide.record.tropicalDetail" }),
  Object.freeze({ value: "guide.record.peakValue", detail: "guide.record.peakDetail" }),
  Object.freeze({ value: "guide.record.nightValue", detail: "guide.record.nightDetail" }),
]);

export const GUIDE_TIMING = Object.freeze({
  regionDrawMs: 3_200,
  regionHoldMs: 800,
  municipalitiesMs: 5_000,
  municipalitiesHoldMs: 1_000,
  questionHoldMs: 5_000,
  observationHoldMs: 3_200,
  recordRevealMs: 900,
  reducedMotionMunicipalityHoldMs: 2_200,
});

export const GUIDE_REPORT_URLS = Object.freeze({
  nl: "https://www.meteo.be/nl/klimaat/klimaat-van-belgie/klimatologisch-overzicht/2026/juni",
  en: "https://www.meteo.be/fr/climat/climat-de-la-belgique/bilans-climatologiques/2026/juin",
});

export function createGuideTour({
  root, message, heatwaves, date, records, recordGrid, reportLink,
  pauseButton, exitButton, exploreButton, retryButton, error,
  translate, reportUrl, enter, setRegionProgress, setMunicipalityCount,
  prefetchObservation = () => {}, showObservation, leave,
  reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  timing = GUIDE_TIMING,
}) {
  let active = false;
  let manuallyPaused = false;
  let hiddenPaused = document.hidden;
  let generation = 0;
  let controller = null;
  let retryResolve = null;
  let messageKey = "";
  let visibleRecordCount = 0;

  const isPaused = () => manuallyPaused || hiddenPaused;
  const assertCurrent = (token) => {
    if (!active || token !== generation || controller?.signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const updatePause = () => {
    pauseButton.textContent = translate(manuallyPaused ? "guide.resume" : "guide.pause");
    pauseButton.setAttribute("aria-pressed", String(manuallyPaused));
  };
  const setMessage = (key) => {
    messageKey = key;
    message.textContent = translate(key);
  };
  const setStage = (stage) => { root.dataset.stage = stage; };
  const renderHeatwaves = () => {
    heatwaves.replaceChildren(...GUIDE_HEATWAVES.map((key) => {
      const item = document.createElement("li");
      item.textContent = translate(key);
      return item;
    }));
  };
  const renderRecords = () => {
    recordGrid.replaceChildren(...GUIDE_RECORDS.map((record, index) => {
      const item = document.createElement("article");
      item.className = "guide-record";
      item.hidden = index >= visibleRecordCount;
      const value = document.createElement("strong");
      value.textContent = translate(record.value);
      const detail = document.createElement("span");
      detail.textContent = translate(record.detail);
      item.append(value, detail);
      return item;
    }));
    reportLink.textContent = translate("guide.officialReport");
    reportLink.href = reportUrl();
  };
  const updateLanguage = () => {
    updatePause();
    root.setAttribute("aria-label", translate("guide.region"));
    records.setAttribute("aria-label", translate("guide.recordsLabel"));
    if (messageKey) message.textContent = translate(messageKey);
    renderHeatwaves();
    renderRecords();
  };

  const hold = async (milliseconds, token) => {
    let remaining = milliseconds;
    let previous = performance.now();
    while (remaining > 0) {
      assertCurrent(token);
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(40, remaining)));
      const now = performance.now();
      if (!isPaused()) remaining -= now - previous;
      previous = now;
    }
  };

  const animateRegion = async (token) => {
    if (reducedMotion()) { setRegionProgress(1); return; }
    let elapsed = 0;
    let previous = performance.now();
    while (elapsed < timing.regionDrawMs) {
      assertCurrent(token);
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      if (!isPaused()) elapsed += now - previous;
      previous = now;
      setRegionProgress(Math.min(1, elapsed / timing.regionDrawMs));
    }
  };

  const revealMunicipalities = async (token) => {
    const interval = reducedMotion() ? 0 : timing.municipalitiesMs / 7;
    for (let count = 1; count <= 7; count += 1) {
      assertCurrent(token);
      setMunicipalityCount(count);
      if (interval) await hold(interval, token);
    }
    if (reducedMotion()) await hold(timing.reducedMotionMunicipalityHoldMs, token);
  };

  const loadObservation = async (observation, index, token) => {
    while (true) {
      assertCurrent(token);
      error.hidden = true;
      try {
        const label = await showObservation(observation, controller.signal, { first: index === 0 });
        assertCurrent(token);
        date.textContent = label;
        date.hidden = false;
        return;
      } catch (loadError) {
        if (loadError.name === "AbortError") throw loadError;
        error.hidden = false;
        await new Promise((resolve) => { retryResolve = resolve; });
        retryResolve = null;
      }
    }
  };

  const run = async (token) => {
    prefetchObservation(GUIDE_OBSERVATIONS[0], controller.signal);
    setStage("region");
    setMessage("guide.regionMessage");
    await animateRegion(token);
    await hold(timing.regionHoldMs, token);

    setStage("municipalities");
    setMessage("guide.municipalitiesMessage");
    await revealMunicipalities(token);
    await hold(timing.municipalitiesHoldMs, token);

    setStage("question");
    setMessage("guide.heatQuestion");
    heatwaves.hidden = false;
    await hold(timing.questionHoldMs, token);
    heatwaves.hidden = true;

    setStage("observations");
    setMessage("guide.landsatMessage");
    for (const [index, observation] of GUIDE_OBSERVATIONS.entries()) {
      await loadObservation(observation, index, token);
      const next = GUIDE_OBSERVATIONS[index + 1];
      if (next) prefetchObservation(next, controller.signal);
      await hold(timing.observationHoldMs, token);
    }

    assertCurrent(token);
    setStage("records");
    setMessage("guide.finalHeatwaveIntro");
    records.hidden = false;
    for (let count = 1; count <= GUIDE_RECORDS.length; count += 1) {
      visibleRecordCount = count;
      renderRecords();
      await hold(timing.recordRevealMs, token);
    }
    setMessage("guide.finalMessage");
    exploreButton.hidden = false;
  };

  const start = async (returnFocus = null) => {
    if (active) return false;
    active = true;
    manuallyPaused = false;
    visibleRecordCount = 0;
    const token = ++generation;
    controller = new AbortController();
    root.hidden = false;
    root.dataset.returnFocus = returnFocus?.id ?? "";
    heatwaves.hidden = true;
    date.hidden = true;
    records.hidden = true;
    error.hidden = true;
    exploreButton.hidden = true;
    renderHeatwaves();
    renderRecords();
    updatePause();
    await enter(controller.signal);
    run(token).catch((runError) => {
      if (runError.name !== "AbortError") console.error(runError);
    });
    return true;
  };

  const exit = async () => {
    if (!active) return;
    active = false;
    generation += 1;
    controller?.abort();
    retryResolve?.();
    retryResolve = null;
    root.hidden = true;
    heatwaves.hidden = true;
    date.hidden = true;
    records.hidden = true;
    error.hidden = true;
    exploreButton.hidden = true;
    delete root.dataset.stage;
    await leave();
  };

  pauseButton.addEventListener("click", () => {
    manuallyPaused = !manuallyPaused;
    updatePause();
  });
  exitButton.addEventListener("click", exit);
  exploreButton.addEventListener("click", exit);
  retryButton.addEventListener("click", () => retryResolve?.());
  document.addEventListener("visibilitychange", () => { hiddenPaused = document.hidden; });
  document.addEventListener("keydown", (event) => {
    if (active && event.key === "Escape") { event.preventDefault(); exit(); }
  });

  return Object.freeze({
    start,
    exit,
    isActive: () => active,
    setLanguage: updateLanguage,
  });
}
