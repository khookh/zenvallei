import { t } from "./i18n.js";
import { safeExternalUrl } from "./security.js";
import { SOURCE_PRODUCTS, authorityName } from "./source-authorities.js";

export const MAP_SOURCE_PRODUCTS = Object.entries(SOURCE_PRODUCTS)
  .filter(([, product]) => product.mapDialog !== false)
  .reduce((groups, [productId, product]) => {
    let group = groups.find(({ authorityId }) => authorityId === product.authorityId);
    if (!group) {
      group = { authorityId: product.authorityId, products: [] };
      groups.push(group);
    }
    group.products.push({ productId, labelKey: product.labelKey, url: product.url });
    return groups;
  }, []);

function linksFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  return [...template.content.querySelectorAll("a")].flatMap((anchor) => {
    const url = safeExternalUrl(anchor.getAttribute("href"));
    return url ? [{ label: anchor.textContent.trim(), url }] : [];
  });
}

function renderLinks(items) {
  const list = document.createElement("ul");
  items.forEach(({ label, url }) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = safeExternalUrl(url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    item.append(link);
    list.append(item);
  });
  return list;
}

/** One explicit product registry prevents comparisons from repeating their source datasets. */
export function createMapSourceDialog({ config }) {
  const dialog = document.createElement("dialog");
  dialog.className = "map-source-dialog";
  document.body.append(dialog);
  let button;
  let returnFocusElement = null;

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
    basemap.append(basemapTitle, basemapCopy, renderLinks(linksFromHtml(config.tileAttribution)));

    const data = document.createElement("section");
    const dataTitle = document.createElement("h3");
    dataTitle.textContent = t("sources.analytical");
    const dataCopy = document.createElement("p");
    dataCopy.textContent = t("sources.analyticalCopy");
    data.append(dataTitle, dataCopy);
    MAP_SOURCE_PRODUCTS.forEach(({ authorityId, products }) => {
      const group = document.createElement("div");
      group.className = "map-source-product-group";
      const heading = document.createElement("h4");
      heading.textContent = authorityName(authorityId);
      group.append(heading, renderLinks(products.map(({ labelKey, url }) => ({ label: t(labelKey), url }))));
      data.append(group);
    });
    article.append(header, basemap, data);
    dialog.replaceChildren(article);
  };

  const open = (triggerElement = null) => {
    returnFocusElement = triggerElement instanceof HTMLElement ? triggerElement : button;
    render();
    dialog.showModal();
    dialog.querySelector(".map-source-dialog-close")?.focus();
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
      button.addEventListener("click", () => open(button));
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
  dialog.addEventListener("close", () => returnFocusElement?.focus());
  return { control, open, updateLanguage: () => control.updateLanguage(), destroy: () => dialog.remove() };
}
