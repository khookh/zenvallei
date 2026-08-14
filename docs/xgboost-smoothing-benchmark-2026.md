# XGBoost prediction-smoothing benchmark, 22 June 2026

This historical experiment compared unsmoothed and smoothing-aware models under the superseded ground-plus-canopy contract. Its model hash is not accepted by the live tool. Contract 4 now resolves one mutually exclusive upper surface and retunes smoothing together with the full 50-trial recipe; see the [2026 heatwave training notebook](../playground/xgboost_2026_heatwave_regression_zennevallei.ipynb) and [Land-cover change tool](land-cover-lst-scenario.md) for the active result.

## Validation contract

- Five sector-grouped outer folds and four inner folds, seed 42.
- A 200 m spatial embargo for the 100 m predictors.
- Gaussian prediction smoothing candidates `σ = 0, 15, 30, 45 and 60 m`.
- Normalised masked convolution on the aligned 30 m grid, truncated at `3σ`.
- Observed Landsat temperatures are never smoothed.
- Hyperparameters, retained features and smoothing are selected using only inner held-out data.
- The production decision uses 20,000 paired bootstrap resamples of the 154 sectors.

All five outer folds selected `σ = 60 m`.

## Held-out results

| Pipeline | RMSE | MAE | R² | Mean error |
|---|---:|---:|---:|---:|
| Independently tuned, unsmoothed | 2.431°C | 1.866°C | 0.628 | −0.012°C |
| Independently tuned, smoothing-aware | 2.355°C | 1.808°C | 0.651 | −0.018°C |

Smoothing reduced pooled RMSE by 0.076°C, or 3.13%, and MAE by 0.058°C. Fold RMSE changed from 2.631 to 2.607°C, 2.590 to 2.535°C, 2.387 to 2.340°C, 2.295 to 2.173°C and 2.225 to 2.076°C.

## Promotion decision

The paired sector-bootstrap 95% interval for smoothing-aware minus unsmoothed RMSE is `−0.126°C to −0.031°C`. Because the complete interval is below zero, the predeclared promotion rule is satisfied. The production model therefore uses `σ = 60 m`.

The final booster retains seven predictors: Soil sealing at 25–50, 50–75 and 75–100 m; High canopy at 50–75 and 75–100 m; Low ground vegetation at 75–100 m; and Agriculture at 75–100 m. Its model hash is `3139b5ac3a2dfe5d13371f7ba4db2cd719cdcae1fa55bea9e0ffcaf448a4235a`.

This is an observational prediction benchmark, not evidence that changing land cover causes the fitted temperature response. Runtime scenarios smooth baseline and modified predictions identically before calculating their difference.

The complete report, predictions and executed verification notebook remain local under `.cache/local-layers/image-regression/xgboost-smoothing-benchmark-2026`.
