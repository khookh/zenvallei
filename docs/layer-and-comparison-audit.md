# Layer and comparison audit

This inventory is the factual display contract for the eight base layers and seven comparisons. It distinguishes the question answered, authoritative source, physical quantity, spatial unit, display footprint, analytical observation and content placement. A map colour is never treated as analytical data.

## Shared scientific and content rules

- **Display masks:** exact 1 m display masks preserve the JaarBAK sealed footprint. Urban Atlas polygons may further restrict that footprint. Display eligibility is independent from chart eligibility.
- **Focal cover:** 10 m focal-density calculations for vegetation or sealing within 100 m use a circular 3.1416 ha denominator and the native classifications as input.
- **Landsat observations:** one analytical temperature recording is one clear 30 m Landsat Collection 2 Level-2 land-surface-temperature observation. Surface temperature is not air temperature.
- **Socioeconomic observations:** population and income comparisons use sector-level Statbel values. They describe areas, not individuals.
- **Content order:** the active context explains the map; the legend decodes it; the first panel view gives the useful result; Details explains supporting metrics; Methodology contains formulas, exclusions, provenance and limitations.

## Base layers

### 1. Heat vulnerability

- **Question:** Which Statbel sectors have higher official heat exposure, population vulnerability or combined heat vulnerability?
- **Sources and years:** Department of Care, Government of Flanders, 2026; Statbel 2024 statistical-sector geometry.
- **Map and resolution:** sector polygons, coloured by the selected official score from 0 to 10. Missing scores have a separate neutral state.
- **Metrics and denominator:** Combined, Heat and Vulnerability are relative sector classes. They are not temperatures or probabilities and have no valid regional average.
- **Aggregation and exclusions:** the application displays the published sector values without recalculation. Municipality filtering changes visibility only.
- **Charts and observations:** no standalone chart; one map observation is one sector score.
- **Legend and panel:** the legend shows the 0–10 palette and selected metric. A selected-sector panel explains the score and supporting components. Context names the producer; Methodology explains the official construction and relative interpretation.
- **Limitations:** comparisons concern the 2026 indicator model and are ecological, not individual diagnoses.
- **Prioritised improvement:** Make the relative 0–10 nature unmistakable without adding an invalid regional average.

### 2. Landsat surface temperature

- **Question:** How hot was the land surface across Zennevallei during a selected clear-sky satellite overpass in an RMI/KMI heatwave?
- **Sources and years:** NASA/USGS Landsat 8/9 Collection 2 Level-2; RMI/KMI heatwaves; six selected observations from 2020 to 2026.
- **Map and resolution:** 30 m analytical observations on the aligned EPSG:32631 grid, displayed with a fixed 15–50 °C thermal scale. Clouds use a grey grid; other missing data are transparent.
- **Metrics and denominator:** temperature in °C over clear pixels; median, mean, P10 and P90; clear, cloud and other-missing areas use the complete selected area.
- **Aggregation and exclusions:** QA cloud, shadow, cirrus, snow, fill and saturation are excluded. Region statistics are calculated from the dissolved raster footprint, not averaged from sectors.
- **Charts and observations:** a clear-sky distribution summary; one observation is one valid 30 m Landsat measurement.
- **Legend and panel:** legend gives scale, clouds, date and Brussels local time. Panel leads with median clear-sky surface temperature; Details and Methodology contain coverage, uncertainty, acquisition and QA rules.
- **Limitations:** one daytime overpass is not air temperature, a whole-heatwave average or proof of a heat-island cause.
- **Prioritised improvement:** Keep surface-versus-air-temperature meaning visible while shortening repeated caveats.

### 3. Urban Atlas 2021

- **Question:** Which Copernicus urban land-use and land-cover classes occupy the selected area?
- **Sources and years:** Copernicus Land Monitoring Service Urban Atlas 2021; Statbel 2024 boundaries.
- **Map and resolution:** official Urban Atlas polygons clipped for display; the vector product uses a minimum mapping unit rather than a uniform pixel resolution.
- **Metrics and denominator:** class hectares and percentage of complete Statbel area; green coverage and artificialisation are documented derived groupings.
- **Aggregation and exclusions:** polygon intersections are aggregated to sector, municipality or Zennevallei. Unclassified or uncovered area remains explicit.
- **Charts and observations:** categorical composition bars and class breakdowns; one observation is mapped polygon area in a class.
- **Legend and panel:** interactive class legend controls visibility. Panel leads with green and artificial shares, then class groups. Methodology defines group membership and mapping limitations.
- **Limitations:** the 2021 classification is not a current parcel inventory and narrow or mixed features may be generalised.
- **Prioritised improvement:** Simplify the long interactive legend without hiding surface definitions.

### 4. Soil sealing

- **Question:** Where is ground classified as sealed, and what share of the surrounding 100 m circle is sealed?
- **Sources and years:** JaarBAK, Department of Environment & Spatial Development, Government of Flanders, 2018–2024; 2024 provisional.
- **Map and resolution:** native binary 1 m sealed/unsealed classification. Density mode is a continuous 10 m analytical derivative representing a 100 m circular neighbourhood.
- **Metrics and denominator:** classification summaries use sealed hectares and percentage of complete Statbel area. Density is sealed 1 m source area divided by the complete 3.1416 ha circle.
- **Aggregation and exclusions:** source no-data is not unsealed. Density is unavailable below 95% valid source coverage; surroundings may cross administrative boundaries.
- **Charts and observations:** sealed/unsealed composition; density is queried at a map location rather than replacing the source-area panel metrics.
- **Legend and panel:** classification legend uses the official classes; density legend is a continuous red scale with radius and year. Details preserve coverage; Methodology documents the 2023 method change.
- **Limitations:** sealing is a surface classification, not permeability measured in situ or a direct temperature prediction.
- **Prioritised improvement:** Clarify the distinction between native classification and surrounding-density mode.

### 5. Flanders Green Map

- **Question:** Where are the four official vegetation/land-cover classes, and what share of a 100 m neighbourhood belongs to selected classes?
- **Sources and years:** Flanders Green Map 2018 and 2021, Agency for Nature and Forests and Digital Flanders Agency.
- **Map and resolution:** native 1 m High green, Low green, Agriculture and Non-green classes. Density mode is a 10 m focal derivative.
- **Metrics and denominator:** class hectares and percentages use complete Statbel area. Vegetation cover within 100 m equals selected class area divided by the complete 3.1416 ha circle.
- **Aggregation and exclusions:** selected classes are mutually exclusive and can be summed. At least one class remains selected; focal values require 95% source coverage.
- **Charts and observations:** four-class composition and rows; density popup reports percentage and equivalent hectares.
- **Legend and panel:** classification keeps official colours. Density uses one uninterrupted green 0–100% gradient with selected classes, year, zero and unavailable states. Methodology defines the four source classes and focal calculation.
- **Limitations:** Low/High green are height-related classifications from aerial imagery; Agriculture follows the agricultural parcel map and is not interchangeable with all vegetation.
- **Prioritised improvement:** Replace categorical-looking density presentation with continuous physical vegetation cover.

### 6. Flanders land use

- **Question:** What broad land-use class is mapped, and which 2025 agricultural uses occur on registered parcels?
- **Sources and years:** Flanders land use, Government of Flanders, 2019–2025; agricultural-use parcels, Agency for Agriculture and Fisheries, 2025.
- **Map and resolution:** 10 m land-use classification; optional parcel polygons at nominal 1:2,000 scale.
- **Metrics and denominator:** land-use classes use complete Statbel area. Agricultural headline is mapped parcel area as a percentage of complete Statbel area; crop shares use mapped agricultural parcel area.
- **Aggregation and exclusions:** parcel properties are strict finite JSON or null. Agricultural use does not imply all farming activity outside registered parcels is absent.
- **Charts and observations:** land-use composition and agricultural crop-group breakdown; one parcel click exposes official crop and production attributes.
- **Legend and panel:** mode-specific legends and panels identify the active denominator. Methodology separates raster classification from parcel registration.
- **Limitations:** general land use and parcel-level agricultural use have different geometry, scale and semantics.
- **Prioritised improvement:** Clarify the relationship between the general classification and Agricultural use.

### 7. Population density

- **Question:** Where do residents live at the best available public spatial detail, and what are authoritative population totals for selected areas?
- **Sources and years:** Statbel variable population grid and sector totals, 2025; Government of Flanders 100 m population-density model, 2019.
- **Map and resolution:** default cells vary from 125 m to 1 km for confidentiality; alternate model uses 100 m cells. Both map inhabitants per hectare.
- **Metrics and denominator:** panels use compatible Statbel population totals, area and inhabitants per hectare. Privacy-displaced grid cells are not summed to claim exact sector totals.
- **Aggregation and exclusions:** official sector totals reconcile to municipalities and Zennevallei. Confidential/unavailable values remain null.
- **Charts and observations:** no standalone chart; map hover reports cell population/density or modelled one-hectare population.
- **Legend and panel:** fixed blue-purple density scale, zero and unavailable states. Context and Methodology explain variable cells, displacement and the older model.
- **Limitations:** the 2019 model is finer but older and methodologically different; the two products do not form a change series.
- **Prioritised improvement:** Make the methodological difference between the 2025 grid and 2019 model immediately understandable.

### 8. Median taxable income

- **Question:** What is the published median net taxable income per declaration in each statistical sector?
- **Sources and years:** Statbel fiscal income by statistical sector, 2019–2023; Statbel 2024 geometry.
- **Map and resolution:** sector polygons in fixed nominal-euro bands, with a distinct unavailable state.
- **Metrics and denominator:** median and average net taxable income per declaration, positive declaration count, interquartile difference/coefficient/asymmetry. A declaration is not a resident or household.
- **Aggregation and exclusions:** published sector medians are never averaged into municipality medians. Confidential or absent values are null, not zero.
- **Charts and observations:** no fabricated income distribution; supporting spread indicators describe the published sector summary.
- **Legend and panel:** legend decodes fixed euro bands. Panel leads with the exact median; Details explains the mean, count and interquartile indicators; Methodology covers nominal euros and confidentiality.
- **Limitations:** income is not salary, disposable household income or wealth, and values are not inflation-adjusted.
- **Prioritised improvement:** Explain fiscal-income supporting metrics without implying a full income distribution.

## Comparisons

### 9. Heat vulnerability × income

- **Question:** How do sector heat scores vary with 2023 median taxable income in the selected municipality or Zennevallei?
- **Sources and years:** Government of Flanders heat scores 2026; Statbel income 2023; Statbel geometry 2024.
- **Map and footprint:** selected heat-score fill remains visible; `€`, `€€`, `€€€` symbols encode fixed income ranges for sectors with published income.
- **Metrics and observations:** continuous X is exact median income per declaration; fixed 0–10 Y is selected heat metric; one point is one comparable sector. No income binning is used in the scatter.
- **Aggregation and exclusions:** scope includes sectors in the selected municipality or all Zennevallei. Missing heat or income excludes a sector and is not zero.
- **Charts:** sector scatter with selected-point readout and descriptive row summaries; no causal inference.
- **Legend and panel:** heat palette and income symbols are visually separated. Persistent panel states sample size and scope; Details defines fiscal income; Methodology documents ecological interpretation.
- **Limitations:** 2026 and 2023 are temporally mismatched, scores are relative classes and sector associations do not describe individuals.
- **Prioritised improvement:** Clarify temporal mismatch and area-level interpretation beside the graph.

### 10. Heat vulnerability × population

- **Question:** How do heat scores vary among sectors of different population, and how many residents live in sectors at each score?
- **Sources and years:** Government of Flanders heat scores 2026; Statbel population 2025; Statbel geometry 2024.
- **Map and footprint:** selected heat fill plus one-to-five deterministic person symbols for fixed sector-population bands.
- **Metrics and observations:** box plots weight each comparable sector once. Bars sum residents assigned their sector's score. At-or-above shares use all comparable residents as denominator.
- **Aggregation and exclusions:** municipality scope recalculates boxes, bars and totals. Published zero population has no symbol; residents in sectors without a selected heat score are disclosed separately.
- **Charts:** vertical score box plots by five population bands; independently expandable non-cumulative resident bars for scores 0–10 with exact and cumulative hover values.
- **Legend and panel:** heat palette and person symbols are separated. Panel states comparable and excluded population. Details defines box plots and the different chart weightings.
- **Limitations:** assigning residents a sector score is an area-level summary, not individual exposure.
- **Prioritised improvement:** Add expandable cumulative at-or-above population information.

### 11. Landsat × Urban Atlas

- **Question:** How do clear-sky land-surface-temperature distributions differ among selected Urban Atlas surfaces?
- **Sources and years:** Landsat observation 2020–2026; Urban Atlas 2021; RMI/KMI heatwave period.
- **Map and footprint:** selected Urban Atlas surfaces appear faintly under Landsat. Clouds retain the grey grid.
- **Metrics and observations:** one recording is one clear 30 m Landsat pixel assigned to a unique Urban Atlas class by majority of a 6×6 grid of 5 m samples.
- **Aggregation and exclusions:** mixed/tied pixels and invalid temperature are excluded. Each selected surface curve is normalised independently to its own clear observed area.
- **Charts:** 0.5 °C step histograms from 15–50 °C, with median, mean, P10–P90, clear pixel count and nominal area.
- **Legend and panel:** selectable families/classes plus thermal scale, clouds, date/time. Expanded chart states resolution, normalisation, observation and reference year.
- **Limitations:** independently normalised shapes do not represent each surface's share of total area; pixels are spatially correlated.
- **Prioritised improvement:** State surface-share normalisation more directly.

### 12. Landsat × soil sealing

- **Question:** How does land-surface temperature differ between majority-sealed and majority-unsealed observations, and how does it vary with surrounding sealed surface?
- **Sources and years:** Landsat observations; matched JaarBAK 2020–2024; RMI/KMI heatwaves.
- **Map and footprint:** complete Landsat observation at reduced opacity above exact bright-red 1 m JaarBAK sealed pixels. Unsealed map pixels are transparent.
- **Metrics and observations:** histogram classifies a 30 m Landsat observation from majority of valid 1 m JaarBAK area. Scatter X is sealed source area in a 100 m circle divided by 3.1416 ha; Y is clear Landsat °C.
- **Aggregation and exclusions:** scatter requires at least 95% valid JaarBAK density coverage and includes 0–100% surroundings without subsampling. Clouds and invalid temperatures are excluded.
- **Charts:** independently expandable sealed/unsealed 0.5 °C histogram and full-point density scatter with descriptive ordinary least squares, n, nominal area, slope, intercept and R².
- **Legend and panel:** thermal scale, clouds and a separate exact sealed 1 m key. Histogram retains both analytical class labels. Methodology distinguishes 1 m display, 10 m focal field and 30 m observations.
- **Limitations:** matched source years can differ from the Landsat year; neighbouring observations are not independent and OLS is descriptive.
- **Prioritised improvement:** Upgrade and independently expand the 100 m sealing scatter.

### 13. Landsat × Flanders Green Map

- **Question:** How does land-surface temperature vary with selected vegetation cover in the surrounding 100 m?
- **Sources and years:** Landsat heatwave observation; Flanders Green Map 2021; Urban Atlas 2021; matched JaarBAK.
- **Map and footprint:** complete Landsat status is rendered on the exact 1 m sealed footprint inside the five eligible urban-fabric classes. Graph eligibility never punches display holes.
- **Metrics and observations:** X is selected Green Map class area inside the 100 m circle divided by 3.1416 ha; Y is Landsat °C. One graph observation is one clear eligible 30 m Landsat measurement.
- **Aggregation and exclusions:** graph requires unique Urban Atlas majority, JaarBAK sealed majority and at least 80% valid vegetation-cover data. Selected Green Map classes are summed.
- **Charts:** full-point scatter and descriptive OLS; sample size, nominal area, slope per ten vegetation-cover percentage points and R².
- **Legend and panel:** continuous green-class selection is distinct from the thermal map scale. Popup reports percentage, equivalent hectares and temperature when analytically comparable; Methodology distinguishes exact display from 30 m analysis.
- **Limitations:** 2021 vegetation/land-use sources are compared with multiple Landsat years; focal and thermal observations are spatially dependent.
- **Prioritised improvement:** Remove eligibility holes and use physical vegetation-cover language.

### 14. Flanders Green Map × income

- **Question:** Does mean surrounding vegetation cover over sealed urban fabric vary with sector median taxable income?
- **Sources and years:** Flanders Green Map 2021; Urban Atlas 2021; JaarBAK 2021; Statbel income 2023.
- **Map and footprint:** exact 1 m sealed pixels inside the five urban-fabric classes, coloured continuously by selected 100 m vegetation cover; income glyphs overlay sectors.
- **Metrics and observations:** X is exact sector income; Y is the exact-sealed-area-weighted mean of selected 10 m focal cover values. One point is one eligible sector.
- **Aggregation and exclusions:** each 10 m density value is weighted by eligible native 1 m area. A sector requires at least 0.10 ha and published income.
- **Charts:** sector scatter with descriptive OLS, eligible area, slope per €10,000 and R².
- **Legend and panel:** uninterrupted green 0–100% gradient, valid zero and unavailable state, selected classes, plus separated income symbols. Methodology defines weighting and four reference years.
- **Limitations:** the comparison is ecological, temporally mismatched and sensitive to the 100 m focal definition.
- **Prioritised improvement:** Use a continuous green scale while preserving the correct exact footprint.

### 15. Landsat × income

- **Question:** How does mean clear-sky land-surface temperature over sealed urban fabric vary with sector median taxable income?
- **Sources and years:** Landsat selected observation; Urban Atlas 2021; matched JaarBAK; Statbel income 2023.
- **Map and footprint:** Landsat is rendered on the same exact 1 m sealed urban-fabric display footprint as the Green Map–income reference; income glyphs overlay sectors.
- **Metrics and observations:** X is exact median income per declaration. Y is mean Landsat °C for clear 30 m observations with Urban Atlas urban-fabric majority and JaarBAK sealed majority. One point is one sector.
- **Aggregation and exclusions:** minimum ten eligible clear Landsat observations per sector; Green Map availability plays no role. Municipality scope filters points and recalculates OLS.
- **Charts:** sector scatter with descriptive OLS, clear-observation count, nominal observed area, slope per €10,000 and R².
- **Legend and panel:** thermal scale/cloud state and separated income symbols. Popup gives exact temperature over the displayed footprint; Methodology states source years, pixel-to-sector aggregation and ecological limitations.
- **Limitations:** one heatwave overpass and 2023 fiscal income are temporally mismatched; surface temperature and sector income cannot establish individual or causal effects.
- **Prioritised improvement:** Correct its footprint and remove the unrelated Green Map eligibility dependency.

## Display-contract verification matrix

| Contract | Required evidence |
| --- | --- |
| Footprint | Standalone JaarBAK and every exact-mask comparison agree at fixed locations; Green Map–income is the reference sealed-urban footprint |
| Layer order | Basemap, exact source mask or comparison base, analytical raster, Statbel outlines and interactions |
| Colour | Source classifications remain categorical; focal density/cover is continuous; zero is distinct from unavailable |
| Missing states | Cloud, other Landsat gaps, source no-data and outside-scope are separately encoded |
| Cross-surface agreement | Map, legend, popup, graph and panel use the same year, unit, denominator and selected classes |
| Scope | Sector selection highlights; municipality and Zennevallei recompute supported summaries without fabricating invalid aggregates |
| State | Reverse entry, timeline, mode and comparison removal restore the initiating layer, year, viewport and focus |
| Language | English and Dutch expose equivalent variables, units, source roles and limitations |

Fixed-location visual checks compare standalone JaarBAK, Green Map × income, Landsat × Green Map and Landsat × income at desktop, mobile and 200% zoom. Automated tests additionally verify continuous interpolation, exact-mask membership, analytical exclusions, every eligible scatter observation, dialog focus and bilingual labels.
