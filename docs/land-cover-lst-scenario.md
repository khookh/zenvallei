# Land-cover change tool

The local-only **Land-cover change tool** estimates how user-drawn land-cover changes could alter daytime land-surface temperature (ΔLST). The live tool has two estimators: the transferable Radoux et al. relationship and, when its artifacts verify, **2026 Heatwave XGBoost**. Both are exploratory counterfactuals, not absolute-temperature forecasts.

## Prepare and run

```powershell
pnpm local-data:setup
pnpm local-data:prepare -- --dataset jaarbak
pnpm local-data:prepare -- --dataset groenkaart
pnpm landsat-heat:prepare
pnpm urban-atlas:prepare -- --source "C:\path\to\urban-atlas"
pnpm lst-scenario:xgboost-optuna
pnpm lst-scenario:xgboost-notebook
pnpm lst-scenario:prepare
pnpm dev:local-data
```

The water-v5 50-trial Optuna study starts in a new versioned cache and is resumable only within that feature contract. Source hashes or an analytical-surface-contract change invalidate the catalogue, feature cache, model and baseline grid. Schema 6 advertises XGBoost only when the contract-5 report, model, retained-feature artifact, catalogue and inference-grid hashes reconcile. The public model source is the executed [2026 heatwave training notebook](../playground/xgboost_2026_heatwave_regression_zennevallei.ipynb).

The heatwave-mean modules, notebook and package commands remain offline research. They are not loaded, listed or calculated by the live tool, and their old artifacts are rejected by contract 5.

## Baseline and upper-surface contract

Green Map is a categorical 1 m raster: High and Low vegetation cannot overlap in its source. The editor keeps latent ground below High vegetation only so **Remove high vegetation** can reveal it. Both Radoux and XGBoost use one mutually exclusive analytical upper surface with this priority:

1. Water, the union of Urban Atlas 2021 water and Flanders Land Use 2025 class 17, locked.
2. Agriculture, from Green Map, locked.
3. High vegetation.
4. Sealed surface.
5. Low vegetation.
6. Other unsealed ground, used as the implicit XGBoost remainder and a Radoux bare-soil proxy.
7. Invalid or out-of-scope cells, locked.

Before the upper-surface correction, 53,597,197 High cells (97.07% of High) were also counted as Low and 1,617,623 (2.93%) as Sealed. Contract 5 prevents those combinations and gives composite water absolute priority: the five explicit XGBoost channels sum to at most one at every location. Flanders Land Use water is resampled from 10 m to the 1 m modelling grid by nearest neighbour. It is used analytically and locks edits, but is not painted on the live map because its boundary resolution is coarse.

Operations are ordered and the latest applicable polygon wins. Convert to Low or Sealed changes latent ground; Add or Remove High changes canopy; Restore resets both. Agriculture, water and unavailable cells never change. The area ledger reports converted, locked, no-op and outside-scope areas identically for both estimators.

## Radoux calculation and audit

The literature method follows [Radoux et al. (2025)](https://doi.org/10.3390/rs17162815):

`ΔLST = Σ cᵢ × (p'ᵢ − pᵢ)`

| Scenario class | Paper proxy | Coefficient |
| --- | --- | ---: |
| High vegetation | Broadleaf trees | −7.42°C |
| Low vegetation | Permanent herbaceous vegetation | −2.07°C |
| Sealed surface | Sealed surface | +3.20°C |
| Other unsealed | Bare soil | +6.70°C |

Exact changed 1 m areas become mutually exclusive 15 m fractions, are convolved with the paper's normalised 41 × 41 Gaussian footprint (`σ = 79.5 m`), and are sampled on the aligned 30 m Landsat grid. The coefficient-difference calculation and kernel match the publication.

The audit also found unavoidable proxy loss: the paper distinguishes built-up, rail, sealed, crop-bare, bare, water, broadleaf, needleleaf, herbaceous and crop vegetation, while the editor uses four changeable local proxies. All High is treated as broadleaf, all Low as permanent herbaceous, built/rail/sealed are not separated, and non-green unsealed is a broad bare-soil proxy. Reprojection to the shared Lambert/Landsat grids is a local adaptation. These limits are disclosed rather than hidden.

## 2026 Heatwave XGBoost

The model uses all 192,595 clear, finite 22 June 2026 Landsat observations with complete valid 100 m surroundings across 154 sectors. Predictors are exclusive fractions of Sealed, High, Low, Agriculture and composite Water in radial rings; Other unsealed is the remainder. The earlier vector audit estimated about 109.1 ha Urban Atlas water, 193.5 ha Flanders water and 72.3 ha overlap. After the specified nearest-neighbour assignment, the exact 1 m model-grid audit is 108.91 ha Urban Atlas water, 193.42 ha Flanders water, 70.89 ha overlap and 231.44 ha union; these centre-assigned raster areas are the values used by training and inference.

One seed-42 Optuna TPE study tunes exactly 50 successful recipes over five sector-held-out folds. It tests ring widths 5, 10, 20, 25 and 50 m; smoothing `σ = 0, 15, 30, 45 and 60 m`; learning rate 0.01–0.20; depth 2–8; child weight 1–32; row sampling 0.60–1.00; column sampling 0.50–1.00; gamma 0–5; L1 1e-8–10; and L2 1e-3–30. Boosting uses at most 3,000 rounds with 80-round early stopping.

Whole sectors are held out and training centres within 200 m of the test-sector union are embargoed. Backward permutation elimination removes a feature only when pooled spatial RMSE stays within 0.01°C of the best all-feature score. Observed Landsat temperatures are never smoothed.

The corrected production result is:

| Metric | Value |
| --- | ---: |
| Held-out RMSE | 2.336°C |
| Held-out MAE | 1.807°C |
| Held-out R² | 0.656 |
| Ring width | 5 m |
| Retained features | 34 |
| Prediction smoothing | σ 60 m |
| Baseline scenario centres | 194,673 |

Model SHA-256: `7aab4f678d101e57a61f3125788935e00807db3f97293a9dc2b993786c059dbc`.

Runtime ΔLST is the modified prediction minus this model's own verified baseline prediction. Combinations outside any retained training-feature range are flagged. Cross-validation measures observational prediction, not counterfactual uncertainty or causality.

## Additional land-use feature audit

The current model uses Soil sealing 2024, Green Map 2021 High/Low/Agriculture and the composite Urban Atlas/Flanders Land Use water channel. A separate residual audit of the other Landgebruik 2025 classes found warmer residuals for commercial (+1.892°C), industry (+1.246°C) and recreation (+0.725°C), and cooler residuals for forest (−0.694°C). An optimistic class-only correction reduced RMSE by only about 0.043°C.

Future work may benchmark immutable functional context such as residential/built form, economic use, transport, recreation and agricultural infrastructure. Crop parcels and mutable cover labels are not added because 2025 crop rotation and phenology may not represent June 2026. A same-date vegetation index would be a stronger future phenology input. No extra land-use predictor was added in this correction.

## Display and interpretation

The combined map may display patterned High canopy over its hidden ground to explain editing, but both calculations consume only the resulting upper surface. The ΔLST overlay is transparent below 0.01°C; opacity and mark styling are presentation aids, not statistical weights. The previous valid result stays visible during recalculation.

Neither estimator predicts air temperature, thermal comfort, personal exposure or causality. Radoux transfers proxy coefficients from Liège, Namur and Verviers. XGBoost learns one clear Zennevallei daytime acquisition using 2021/2024 static predictors. Botanical composition, shade geometry, soil moisture, irrigation, crop stage and future weather remain outside the tool.
