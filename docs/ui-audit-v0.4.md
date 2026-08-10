# UI audit: legends and result panels

## References and review rule

The map remains the primary workspace. Panels adapt to the available space, important controls remain visible and advanced detail is disclosed only when needed.

- [Apple Maps](https://developer.apple.com/design/human-interface-guidelines/maps): overlays and controls must not prevent normal map interaction.
- [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars): keep navigation shallow and adapt it when space is limited.
- [Apple disclosure controls](https://developer.apple.com/design/human-interface-guidelines/disclosure-controls): keep likely actions visible and disclose advanced detail.
- [W3C APG](https://www.w3.org/WAI/ARIA/apg/) and [WCAG 2.2](https://www.w3.org/TR/WCAG22/): keyboard behaviour, reflow, focus, contrast and non-colour communication.

Scientific displays must name variables, units, reference years, sample sizes and exclusions. Plain-language interpretation comes first; formulas, provenance and limitations belong in Methodology.

The factual map, metric, denominator, chart and limitation inventory now lives in [Layer and comparison audit](layer-and-comparison-audit.md). This UI audit evaluates placement and interaction only, avoiding a second, potentially divergent description of the scientific contracts.

## Content placement

| Surface | Contains | Does not repeat |
| --- | --- | --- |
| Active context | Mapped quantity, producer, reference year and our processing | Full formulas or complete provenance |
| Legend | Colour or symbol meaning, unit and unavailable state | General dataset introduction |
| Result hero | Area and one primary result or comparison title | Supporting diagnostics |
| Result body | Short interpretation and the useful measurements or charts | Source history |
| Details | Supporting metrics and how to read unfamiliar charts | Every source link |
| Methodology | Formula, denominator, exclusions, uncertainty and provenance | First-glance instructions |
| About | Dataset comparison and institutional responsibilities | Sector-specific results |

## Findings and applied corrections

| Severity | Finding | Correction |
| --- | --- | --- |
| High | Independent controls, legend and results previously collided at tablet and phone sizes | The measured map-surface controller retains one expanded major surface when space is limited and supplies actual padding to MapLibre |
| High | Persistent comparisons could be validated in the wrong runtime mode | Product-contract and browser tests now pin public and local comparison targets separately |
| Medium | Chart interaction was hard-coded to the income comparison | Sector-point and bar navigation now use shared comparison-chart hooks without changing the scientific models |
| Medium | Repeating a human symbol as text would depend on the platform font and could be mistaken for decoration | Population comparison symbols use deterministic map sprites, repeated visual icons in the legend and complete textual labels |
| Medium | Heat-population charts can imply the same weighting | The box plots state that every sector counts once; the second chart states that residents are summed |
| Medium | Comparison explanations could repeat the same caveat in context, legend and panel | Context explains the comparison, the legend only decodes it, Details explains chart reading and Methodology contains limitations |
| Medium | Directional comparison controls made the same analysis discoverable from only one participant | One explicit seven-pair table now discovers every functional comparison from either linked layer and restores the initiating state |
| Medium | About and the expanded MapLibre attribution strip competed with map controls | About is now a permanent header action; a bilingual modal source view replaces the overlapping attribution strip while retaining every link |
| Medium | Green, temperature and income could be compared over unlike surfaces | The three new scatter comparisons share one explicit sealed urban-fabric eligibility rule and disclose its spatial and temporal limits |

## Layer and comparison checklist

Every active legend was checked for a descriptive title, units or class meaning, selected year and explicit missing state. Long Urban Atlas controls remain interactive but contain no source narrative. Density legends identify their radius and selected classes. Landsat comparisons distinguish surface temperature from air temperature and keep cloud and no-data states separate.

Every result panel was checked for one useful first result, natural English and Belgian Dutch, complete-area denominators where applicable, closed Methodology and safe source attribution. Persistent comparison panels can be minimised, retain chart state and return after About closes.

Comparison legends use a visual divider between the primary map scale and secondary symbols or selectors. Green Map keeps **Show density** and **Compare** as peer actions. Sealed-urban scatter plots state their analytical unit, eligible surface, source years, sample size and descriptive OLS result without repeating the full method in the first view.

The heat-population comparison adds two complementary views:

- vertical box plots in which every comparable Statbel sector counts once;
- population bars in which published residents are summed by score.

The interface does not calculate a regression, correlation or individual heat exposure.

## Acceptance evidence

Automated checks cover desktop and phone operation, keyboard navigation, WCAG A/AA, English and Dutch, 200% zoom and screenshots at 1440×900, 1024×768, 390×844 and 320×568. A comparison release must have no panel collision, clipped axis label, hidden active control, unexplained symbol, console error or failed same-origin request.

## Remaining recommendation

Run a short first-time-user session on a physical phone before publishing the heat-population comparison. Ask the participant to identify what the people symbols mean, explain the difference between the two charts and find the source years without opening Methodology first.
