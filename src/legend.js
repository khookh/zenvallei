import { t } from "./i18n.js";

function legendItem(item, { score = false } = {}) {
  const container = document.createElement(score ? "div" : "span");
  if (score) container.className = "legend-item legend-score";
  const swatch = document.createElement(score ? "span" : "i");
  swatch.style.setProperty("--swatch", item.color);
  if (item.personCount) {
    swatch.classList.add("legend-person-strip");
    swatch.setAttribute("aria-hidden", "true");
    swatch.replaceChildren(...Array.from({ length: item.personCount }, () => {
      const person = document.createElement("span");
      person.className = "legend-person";
      return person;
    }));
  } else if (item.symbol) {
    swatch.classList.add("legend-symbol");
    swatch.textContent = item.symbol;
  }
  const label = document.createElement(score ? "b" : "span");
  label.textContent = item.label;
  container.append(swatch, label);
  if (item.accessibleLabel) container.setAttribute("aria-label", item.accessibleLabel);
  return container;
}

function comparisonLegend(model) {
  if (!model?.items?.length) return null;
  const section = document.createElement("section");
  section.className = "legend-comparison-section";
  const heading = document.createElement("h3");
  heading.textContent = model.title;
  const items = document.createElement("div");
  items.append(...model.items.map((item) => legendItem(item)));
  section.append(heading, items);
  return section;
}

function continuousScale(model) {
  if (!model?.gradient || !Array.isArray(model.ticks) || model.ticks.length < 2) return null;
  const figure = document.createElement("div");
  figure.className = "legend-continuous-scale";
  figure.setAttribute("role", "img");
  if (model.accessibleLabel) figure.setAttribute("aria-label", model.accessibleLabel);
  const ramp = document.createElement("span");
  ramp.className = "legend-continuous-ramp";
  ramp.classList.toggle("has-transparent-centre", Boolean(model.transparentCentre));
  ramp.style.background = model.transparentCentre
    ? `${model.gradient}, repeating-conic-gradient(#d8dfdc 0 25%, #f4f6f5 0 50%) 0 / 10px 10px`
    : model.gradient;
  ramp.setAttribute("aria-hidden", "true");
  const ticks = document.createElement("div");
  ticks.className = "legend-continuous-ticks";
  ticks.setAttribute("aria-hidden", "true");
  ticks.append(...model.ticks.map((value) => {
    const label = document.createElement("span");
    label.textContent = `${value}${model.unit ?? ""}`;
    return label;
  }));
  figure.append(ramp, ticks);
  return figure;
}

function methodSelector(model) {
  if (!model?.items?.length) return null;
  const wrapper = document.createElement("section");
  wrapper.className = "scenario-method-selector";
  const heading = document.createElement("h3");
  heading.textContent = model.title;
  const options = document.createElement("div");
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", model.title);
  model.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.scenarioMethod = item.id;
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.setAttribute("aria-pressed", String(item.selected));
    button.classList.toggle("is-selected", item.selected);
    options.append(button);
  });
  wrapper.append(heading, options);
  return wrapper;
}

function scenarioSelector(model) {
  if (!model?.items?.length) return null;
  const wrapper = document.createElement("section");
  wrapper.className = "scenario-category-selector";
  const heading = document.createElement("h3");
  heading.textContent = model.title;
  const options = document.createElement("div");
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", model.title);
  model.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.scenarioCategory = item.id;
    button.setAttribute("aria-pressed", String(item.selected));
    button.classList.toggle("is-selected", item.selected);
    const swatch = document.createElement("i");
    swatch.style.setProperty("--swatch", item.color);
    if (item.pattern) swatch.classList.add("is-patterned");
    swatch.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(swatch, label);
    options.append(button);
  });
  const delta = document.createElement("button");
  delta.type = "button";
  delta.className = "scenario-delta-toggle";
  delta.dataset.scenarioDelta = "";
  delta.disabled = Boolean(model.delta.disabled);
  delta.setAttribute("aria-pressed", String(model.delta.selected));
  delta.classList.toggle("is-selected", model.delta.selected);
  delta.textContent = model.delta.label;
  wrapper.append(heading, options, delta);
  return wrapper;
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
    header.append(select);
    if (group.items.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "comparison-surface-family-toggle";
    toggle.dataset.comparisonFamilyToggle = group.id;
    toggle.setAttribute("aria-expanded", String(group.expanded));
    toggle.setAttribute("aria-controls", `comparison-family-${group.id}`);
    toggle.setAttribute("aria-label", t(group.expanded ? "comparison.collapseFamily" : "comparison.expandFamily", { family: group.title }));
    toggle.textContent = group.expanded ? "−" : "+";
    header.append(toggle);
    }
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

function dualSelector(model) {
  const wrapper = document.createElement("section");
  wrapper.className = "comparison-dual-selector";
  Object.entries(model).forEach(([type, group]) => {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    const options = document.createElement("div");
    options.setAttribute("role", "group");
    options.setAttribute("aria-label", group.title);
    group.items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.greenUrbanSelector = type;
      button.dataset.greenUrbanValue = String(item.value);
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
    section.append(heading, options);
    wrapper.append(section);
  });
  const feedback = document.createElement("p");
  feedback.dataset.greenUrbanFeedback = "";
  feedback.setAttribute("aria-live", "polite");
  wrapper.append(feedback);
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
  if (model.layout === "scenario") {
    const categories = scenarioSelector(model.scenarioSelector);
    const scale = model.scenarioSelector?.delta?.selected ? continuousScale(model.continuousScale) : null;
    const methods = model.scenarioSelector?.delta?.selected ? methodSelector(model.methodSelector) : null;
    content.replaceChildren(
      ...(categories ? [categories] : []), ...(scale ? [scale] : []),
      ...(methods ? [methods] : []), ...(footnote ? [footnote] : []),
    );
    return;
  }
  if (model.layout === "scale") {
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    scale.append(...model.groups[0].items.map((item) => legendItem(item, { score: true })));
    const continuous = continuousScale(model.continuousScale);
    const statuses = document.createElement("div");
    statuses.className = "legend-statuses";
    statuses.append(...(model.groups[1]?.items ?? []).map((item) => legendItem(item)));
    const comparison = comparisonLegend(model.comparisonLegend);
    const surfaces = model.surfaceSelector ? surfaceSelector(model.surfaceSelector) : null;
    const density = model.densitySelector ? densitySelector(model.densitySelector) : null;
    const dual = model.dualSelector ? dualSelector(model.dualSelector) : null;
    const methods = methodSelector(model.methodSelector);
    content.replaceChildren(...(continuous ? [continuous] : [scale]), statuses, ...(methods ? [methods] : []), ...(comparison ? [comparison] : []), ...(surfaces ? [surfaces] : []), ...(density ? [density] : []), ...(dual ? [dual] : []), ...(footnote ? [footnote] : []));
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
  const comparison = comparisonLegend(model.comparisonLegend);
  content.replaceChildren(wrapper, ...(comparison ? [comparison] : []), ...(footnote ? [footnote] : []));
}
