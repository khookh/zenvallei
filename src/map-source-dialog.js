import { t } from "./i18n.js";
import { safeExternalUrl } from "./security.js";

function linksFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return [...template.content.querySelectorAll("a")].flatMap((anchor) => {
    const url = safeExternalUrl(anchor.getAttribute("href"));
    return url ? [{ label: anchor.textContent.trim(), url }] : [];
  });
}

function uniqueLinks(links) {
  const seen = new Set();
  return links.filter(({ label, url }) => {
    const key = `${label}|${url}`;
    if (!label || !url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Own the compact source button and modal so long attributions never cover the map. */
export function createMapSourceDialog({ config, layers }) {
  const dialog = document.createElement("dialog");
  dialog.className = "map-source-dialog";
  document.body.append(dialog);
  let button;

  const renderLinks = (items) => {
    const list = document.createElement("ul");
    items.forEach(({ label, url }) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = label;
      item.append(link);
      list.append(item);
    });
    return list;
  };

  const analyticalLinks = () => uniqueLinks([...layers.values()].flatMap((layer) => {
    // Context renderers normally receive the active sector count. Source
    // collection is application-wide, so provide the stable regional count
    // and isolate a malformed optional context from the complete dialog.
    let context;
    try { context = layer.getContext?.({ sectorCount: 154 }); } catch { context = null; }
    const contextLinks = context?.sources?.map(({ label, url }) => ({ label, url: safeExternalUrl(url) })) ?? [];
    const attributionLinks = (layer.getAttributions?.() ?? []).flatMap(linksFromHtml);
    return [...contextLinks, ...attributionLinks];
  }));

  const render = () => {
    const article = document.createElement("article");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = t("sources.title");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "map-source-dialog-close";
    close.setAttribute("aria-label", t("sources.close"));
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    header.append(title, close);

    const basemap = document.createElement("section");
    const basemapTitle = document.createElement("h3");
    basemapTitle.textContent = t("sources.basemap");
    const basemapCopy = document.createElement("p");
    basemapCopy.textContent = t("sources.basemapCopy");
    basemap.append(basemapTitle, basemapCopy, renderLinks(uniqueLinks(linksFromHtml(config.tileAttribution))));

    const data = document.createElement("section");
    const dataTitle = document.createElement("h3");
    dataTitle.textContent = t("sources.analytical");
    const dataCopy = document.createElement("p");
    dataCopy.textContent = t("sources.analyticalCopy");
    data.append(dataTitle, dataCopy, renderLinks(analyticalLinks()));
    article.append(header, basemap, data);
    dialog.replaceChildren(article);
  };

  const control = {
    onAdd() {
      const container = document.createElement("div");
      container.className = "maplibregl-ctrl maplibregl-ctrl-group map-source-control-container";
      button = document.createElement("button");
      button.type = "button";
      button.className = "map-source-control";
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "i";
      button.append(glyph);
      button.addEventListener("click", () => {
        render();
        dialog.showModal();
        dialog.querySelector(".map-source-dialog-close")?.focus();
      });
      container.append(button);
      this.updateLanguage();
      return container;
    },
    onRemove() { button?.parentElement?.remove(); },
    updateLanguage() {
      if (!button) return;
      const label = t("sources.open");
      button.setAttribute("aria-label", label);
      button.title = label;
      if (dialog.open) render();
    },
  };
  dialog.addEventListener("close", () => button?.focus());
  return { control, updateLanguage: () => control.updateLanguage(), destroy: () => dialog.remove() };
}
