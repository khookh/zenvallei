# UI audit: adaptive map surfaces and content hierarchy

## Scope and design references

This audit covers the welcome dialog, header, layer navigation, metric and time controls, comparison selection, context, filters, map interaction, legend, result panel, About, Methodology and attribution. Desktop and phone behaviour are assessed separately.

- [Apple Maps](https://developer.apple.com/design/human-interface-guidelines/maps): keep the map usable and avoid obscuring important content.
- [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): use a shallow hierarchy and adapt navigation to the available space.
- [Material 3 adaptive layouts](https://m3.material.io/foundations/layout/canonical-examples/overview): change pane relationships at meaningful breakpoints instead of shrinking the desktop composition.
- [W3C APG](https://www.w3.org/WAI/ARIA/apg/): keyboard and assistive-technology behaviour for disclosures, toolbars and sliders.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/): reflow, contrast, focus and non-colour communication.

## Baseline findings

| Severity | Finding | Evidence | Resolution |
| --- | --- | --- | --- |
| High | Controls, legend and results could overlap | Independent fixed positioning caused intersections at 1280×720, 1024×768, 768×1024 and phone sizes | A measured surface controller now coordinates the three surfaces and supplies actual insets to MapLibre |
| High | A persistent comparison select repeated the layer grid | Users had to select a layer name a second time from a separate menu | Compare now temporarily turns the existing layer cards into compatible targets and does not navigate away |
| Medium | English producer names varied by layer | The same public authority appeared under several translated and abbreviated names | A source-authority registry supplies canonical names and product metadata is separated from producer links |
| Medium | Compact labels were difficult to read | Several labels were below 10 px at phone widths | Captions and controls now use at least 12 px; explanatory phone copy uses at least 14 px |
| Medium | Income measures were technically labelled but under-explained | Average, declaration count and interquartile indicators lacked visible definitions | Plain-language definitions now appear next to every supporting value; formulas and cautions remain in Methodology |

## Desktop behaviour

At 1180 px and above, controls remain at the left and results at the right. The legend is measured into the safe horizontal space between them. When less than 360 px remains, it becomes a compact summary instead of overlapping either panel. Opening or minimising results does not discard the selection, scroll position or open Methodology sections.

The expected zero-intersection check covers 1440×900 and 1280×720 with controls, legend and results open. MapLibre navigation and attribution move into the measured free area instead of remaining behind the result panel. Map fitting uses the measured visible bounds rather than a fixed assumed panel width.

## Tablet and phone behaviour

Between 760 and 1179 px and below 760 px, only one major surface is expanded at a time:

- opening results collapses controls and the legend;
- expanding controls reduces results to a persistent title and value peek;
- expanding the legend collapses controls and reduces results to the peek;
- closing a surface restores the user's previous preference when enough room becomes available.

The legend reflows without a fixed minimum width. A narrow right rail keeps MapLibre navigation and attribution reachable beside compact controls. The 768×1024, 390×844 and 320×568 checks cover reflow, touch targets and result peeking. The same rules are exercised at 200% browser zoom; where vertical space is exceptionally limited, the lower-priority legend is restored after the active surface is minimised.

## Information hierarchy

1. Controls identify the active theme, layer, year and mapped quantity.
2. Context explains what is coloured, names the authoritative producer and states what this project calculated.
3. Legend defines colours, units and missing-data states.
4. The result hero presents one decision-useful primary value.
5. Details explain supporting measures in plain language.
6. Methodology contains formulas, caveats and provenance and starts closed.
7. About compares datasets and institutional responsibilities.

## Task walkthrough

- Choosing a layer, metric or year keeps the active state visible and does not depend on colour alone.
- Municipality filtering and sector search retain the official Statbel spatial unit.
- Selecting a comparison target uses the existing layer cards, announces the result and changes no map source, style or camera state.
- Sector and parcel results lead with the relevant percentage or value, then explain denominators and supporting figures.
- The active context contains only links for the selected dataset; complete attribution remains in About, Methodology and MapLibre.
- Keyboard users can enter, cancel, change and remove comparison mode and receive focus restoration and live announcements.

## Remaining recommendations

- Validate the terminology and compact task flow with first-time users on a physical phone before introducing cross-layer calculations.
- Define the statistical and spatial model for each proposed comparison before showing a coefficient or causal interpretation.
- Repeat collision, reflow, screenshot and WCAG checks whenever a category or persistent map surface is added.
