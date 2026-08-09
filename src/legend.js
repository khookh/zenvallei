import { t } from "./i18n.js";

function legendItem(item, { score = false } = {}) {
  const container = document.createElement(score ? "div" : "span");
  if (score) container.className = "legend-item legend-score";
  const swatch = document.createElement(score ? "span" : "i");
  swatch.style.setProperty("--swatch", item.color);
  const label = document.createElement(score ? "b" : "span");
  label.textContent = item.label;
  container.append(swatch, label);
  return container;
}

function surfaceSelector(model) {
  const wrapper = document.createElement("section");
  wrapper.className = "comparison-surface-selector";
  const heading = document.createElement("h3");
  heading.textContent = model.title;
  const help = document.createElement("p");
  help.textContent = model.help;
  const groups = document.createElement("div");
  groups.className = "comparison-surface-groups";
  model.groups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "comparison-surface-family";
    const header = document.createElement("div");
    header.className = "comparison-surface-family-header";
    const select = document.createElement("button");
    select.type = "button";
    select.dataset.comparisonSeries = group.family.key;
    select.className = "comparison-surface-family-select";
    select.setAttribute("aria-pressed", String(group.family.selected));
    select.classList.toggle("is-selected", group.family.selected);
    const swatch = document.createElement("i");
    swatch.style.setProperty("--swatch", group.family.color);
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = group.title;
    select.append(swatch, label);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "comparison-surface-family-toggle";
    toggle.dataset.comparisonFamilyToggle = group.id;
    toggle.setAttribute("aria-expanded", String(group.expanded));
    toggle.setAttribute("aria-controls", `comparison-family-${group.id}`);
    toggle.setAttribute("aria-label", t(group.expanded ? "comparison.collapseFamily" : "comparison.expandFamily", { family: group.title }));
    toggle.textContent = group.expanded ? "−" : "+";
    header.append(select, toggle);
    const options = document.createElement("div");
    options.className = "comparison-surface-options";
    options.id = `comparison-family-${group.id}`;
    options.hidden = !group.expanded;
    group.items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.comparisonSeries = item.key;
      button.className = "comparison-surface-button";
      button.setAttribute("aria-pressed", String(item.selected));
      button.classList.toggle("is-selected", item.selected);
      const itemSwatch = document.createElement("i");
      itemSwatch.style.setProperty("--swatch", item.color);
      itemSwatch.setAttribute("aria-hidden", "true");
      const itemLabel = document.createElement("span");
      itemLabel.textContent = item.label;
      button.append(itemSwatch, itemLabel);
      options.append(button);
    });
    section.append(header, options);
    groups.append(section);
  });
  const feedback = document.createElement("p");
  feedback.className = "comparison-surface-feedback";
  feedback.dataset.comparisonFeedback = "";
  feedback.setAttribute("aria-live", "polite");
  wrapper.append(heading, help, groups, feedback);
  return wrapper;
}

function densitySelector(model) {
  const wrapper = document.createElement("section");
  wrapper.className = "density-class-selector";
  const heading = document.createElement("h3");
  heading.textContent = model.title;
  const options = document.createElement("div");
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", model.title);
  model.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.densityClass = String(item.code);
    button.setAttribute("aria-pressed", String(item.selected));
    button.classList.toggle("is-selected", item.selected);
    const swatch = document.createElement("i");
    swatch.style.setProperty("--swatch", item.color);
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(swatch, label);
    options.append(button);
  });
  const feedback = document.createElement("p");
  feedback.dataset.densityFeedback = "";
  feedback.setAttribute("aria-live", "polite");
  wrapper.append(heading, options, feedback);
  return wrapper;
}

/** Render a complete legend view model without knowing which layer produced it. */
export function renderLegendModel({ title, note, content }, model) {
  title.textContent = model.title;
  note.textContent = model.note ?? "";
  const footnote = model.footnote ? document.createElement("p") : null;
  if (footnote) {
    footnote.className = "legend-footnote";
    footnote.textContent = model.footnote;
  }
  if (model.layout === "scale") {
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    scale.append(...model.groups[0].items.map((item) => legendItem(item, { score: true })));
    const statuses = document.createElement("div");
    statuses.className = "legend-statuses";
    statuses.append(...(model.groups[1]?.items ?? []).map((item) => legendItem(item)));
    if (model.comparisonSeries?.length) statuses.append(...model.comparisonSeries.map((item) => legendItem(item)));
    const surfaces = model.surfaceSelector ? surfaceSelector(model.surfaceSelector) : null;
    const density = model.densitySelector ? densitySelector(model.densitySelector) : null;
    content.replaceChildren(scale, statuses, ...(surfaces ? [surfaces] : []), ...(density ? [density] : []), ...(footnote ? [footnote] : []));
    return;
  }
  const hasGroups = model.groups.some((group) => group.title);
  const wrapper = document.createElement("div");
  wrapper.className = hasGroups ? "urban-atlas-legend" : "land-cover-legend";
  model.groups.forEach((group) => {
    if (!group.items.length) return;
    if (!hasGroups) {
      wrapper.append(...group.items.map((item) => legendItem(item)));
      return;
    }
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    const items = document.createElement("div");
    items.append(...group.items.map((item) => legendItem(item)));
    section.append(heading, items);
    wrapper.append(section);
  });
  content.replaceChildren(wrapper, ...(footnote ? [footnote] : []));
}
