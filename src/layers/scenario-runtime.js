/** Promise-based boundary around the public, session-only scenario worker. */
export function createScenarioRuntime({ manifest, assetRoot }) {
  const worker = new Worker(new URL("./scenario-runtime-worker.js", import.meta.url), { type: "module" });
  let sequence = 0;
  const pending = new Map();

  worker.addEventListener("message", ({ data }) => {
    const request = pending.get(data?.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event.message || "The scenario worker stopped unexpectedly.");
    pending.forEach(({ reject }) => reject(error));
    pending.clear();
  });

  const request = (command, payload = {}, signal) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { resolve, reject });
    const abort = () => {
      pending.delete(requestId);
      worker.postMessage({ command: "cancel", requestId });
      reject(new DOMException("The scenario request was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ command, requestId, payload });
  });

  const init = request("init", {
    manifest,
    assetRoot: new URL(assetRoot, window.location.origin).href,
  });
  return {
    async simulate(payload, signal) { await init; return request("simulate", payload, signal); },
    async inspect(payload, signal) { await init; return request("inspect", payload, signal); },
    destroy() { worker.terminate(); pending.clear(); },
  };
}
