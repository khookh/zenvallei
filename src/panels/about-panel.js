import { t } from "../i18n.js";
import { escapeHtml } from "../score-utils.js";
import { safeExternalUrl } from "../security.js";
import { SOURCE_PRODUCTS } from "../source-authorities.js";

const safeHref = (value) => escapeHtml(safeExternalUrl(value));

function aboutLayerRow(key, label, source = null) {
  return `<li class="about-layer-row">
    <strong>${escapeHtml(label)}</strong>
    <span>${escapeHtml(t(`about.${key}Question`))}</span>
    <small>${escapeHtml(t(`about.${key}Summary`))}</small>
    ${source ? `<a href="${safeHref(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a>` : ""}
  </li>`;
}

export function renderAboutPanel(model) {
  const { urbanAtlas, provenance, officialLayers } = model;
  const sectorCount = provenance?.output?.sectorCount ?? 154;
  return `
    <div class="panel-hero panel-hero--about">
      <p class="panel-eyebrow">${escapeHtml(t("about.eyebrow", { count: sectorCount }))}</p>
      <h2 id="panel-title">${escapeHtml(t("about.title"))}</h2>
      <p class="about-intro">${escapeHtml(t("about.intro"))}</p>
      <p class="about-scope">${escapeHtml(t("about.scope", { count: sectorCount }))}</p>
    </div>
    <div class="panel-body about-body">
      <section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.startKicker"))}</p><h3>${escapeHtml(t("about.howTo"))}</h3></div>
        <ol class="about-steps">
          <li><span>1</span><p>${escapeHtml(t("about.step1"))}</p></li>
          <li><span>2</span><p>${escapeHtml(t("about.step2"))}</p></li>
          <li><span>3</span><p>${escapeHtml(t("about.step3"))}</p></li>
        </ol>
      </section>
      <section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.layersKicker"))}</p><h3>${escapeHtml(t("about.layersTitle"))}</h3></div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryHeat"))}</h4>
          <ul class="about-layer-index">
            ${aboutLayerRow("landsat", t("layers.landsatTemperature"))}
            ${aboutLayerRow("heat", t("layers.heat"))}
          </ul>
        </div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryLandGreen"))}</h4>
          <ul class="about-layer-index">
            ${aboutLayerRow("urbanAtlas", t("layers.urbanAtlas", { year: urbanAtlas?.activeYear ?? 2021 }))}
            ${aboutLayerRow("jaarbak", t("layers.jaarbak", { year: officialLayers?.jaarbak?.defaultYear ?? 2024 }))}
            ${aboutLayerRow("groenkaart", t("layers.groenkaart", { year: officialLayers?.groenkaart?.defaultYear ?? 2021 }))}
          </ul>
        </div>
        <div class="about-layer-category">
          <h4 class="about-category-title">${escapeHtml(t("about.categoryDemography"))}</h4>
          <ul class="about-layer-index">
            ${aboutLayerRow("population", t("layers.population"))}
            ${aboutLayerRow("income", t("layers.income"))}
          </ul>
        </div>
      </section>
      ${officialLayers?.["land-cover-scenario"] ? `<section>
        <div class="section-heading"><p class="section-kicker">${escapeHtml(t("about.toolKicker"))}</p><h3>${escapeHtml(t("about.toolTitle"))}</h3></div>
        <ul class="about-layer-index">
          ${aboutLayerRow("scenario", t("scenario.toolLabel"), {
            label: t(SOURCE_PRODUCTS.xgboost.labelKey), url: SOURCE_PRODUCTS.xgboost.url,
          })}
        </ul>
      </section>` : ""}
      <section class="about-note about-project">
        <p class="section-kicker">${escapeHtml(t("about.projectKicker"))}</p>
        <h3>${escapeHtml(t("about.projectTitle"))}</h3>
        <p>${escapeHtml(t("project.summary"))}</p>
        <p>${escapeHtml(t("project.privacy"))}</p>
        <div class="about-actions">
          <a href="https://github.com/khookh/zenvallei" target="_blank" rel="noopener noreferrer">${escapeHtml(t("intro.github"))}</a>
          <a href="mailto:stefanodonne@gmail.com">${escapeHtml(t("intro.contact"))}</a>
          <button type="button" data-open-map-sources>${escapeHtml(t("about.openSources"))}</button>
        </div>
      </section>
    </div>`;
}
