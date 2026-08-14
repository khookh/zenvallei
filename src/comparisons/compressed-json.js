/** Fetch a JSON comparison index, including deterministic gzip assets.
 *
 * Static hosts do not consistently attach Content-Encoding to `.json.gz`, so
 * decompression is explicit. This keeps every exact analytical record while
 * avoiding a much larger public download.
 */
export async function fetchJsonAsset(url, label = "Comparison data") {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}.`);
  if (!url.toLowerCase().endsWith(".json.gz")) return response.json();
  // Fetch exposes the decoded body when the server supplies Content-Encoding.
  // Explicit decompression is only needed on static hosts that serve the raw
  // gzip bytes without that response header.
  if (/\bgzip\b/i.test(response.headers.get("content-encoding") ?? "")) {
    return response.json();
  }
  if (!response.body || typeof DecompressionStream !== "function") {
    throw new Error(`${label} cannot be decompressed by this browser.`);
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}
