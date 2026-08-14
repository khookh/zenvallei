# XGBoost spatial-support benchmark, 22 June 2026

This non-production experiment compares land-cover context within 100 m,
150 m and 200 m for predicting clear Landsat land-surface temperature across
Zennevallei. It was executed on 12 August 2026 with XGBoost 3.2.0 on CUDA.

## Comparable experiment

- One strict common cohort: 186,449 Landsat observations in all 154 Statbel
  sectors, each with complete valid land-cover data through 200 m.
- Five land-cover classes in contiguous 25 m rings: Soil sealing, High green,
  Low green, Agriculture and Water.
- One 40-predictor matrix. The 100 m and 150 m models use its exact first 20
  and 30 columns.
- Five outer and four inner sector-grouped folds, seed 42.
- One 400 m train/test embargo for all radii, preventing two 200 m predictor
  supports from overlapping.
- Independent bounded tuning, early stopping and leakage-safe backward feature
  elimination for each radius.
- Primary comparison: 20,000 paired bootstrap resamples of the 154 sectors.

The explicit geometry audit found a minimum outer-fold train/test centre
distance of 400.344 m; every outer and inner partition passed the 400 m rule.

The production 100 m score of RMSE 2.434°C is context only. It used a broader
100 m-complete cohort and a 200 m embargo, so it is not the benchmark baseline.

## Held-out results

| Radius | Predictors before selection | RMSE | MAE | R² | Mean error |
|---|---:|---:|---:|---:|---:|
| 100 m | 20 | 2.514°C | 1.905°C | 0.597 | −0.101°C |
| 150 m | 30 | 2.503°C | 1.884°C | 0.600 | −0.075°C |
| 200 m | 40 | 2.464°C | 1.861°C | 0.613 | −0.074°C |

The 200 m model is numerically best. Relative to 100 m, its RMSE is lower by
0.050°C, or 1.99%. Relative to 150 m, its RMSE is lower by 0.039°C, or 1.57%.
The 150 m improvement over 100 m is only 0.011°C, or 0.43%.

## Paired sector-bootstrap decision

| Comparison | Candidate minus baseline RMSE | 95% interval | Supported? |
|---|---:|---:|---|
| 150 m vs 100 m | −0.011°C | [−0.054, +0.037]°C | No |
| 200 m vs 100 m | −0.050°C | [−0.102, +0.0047]°C | No |
| 200 m vs 150 m | −0.039°C | [−0.086, +0.0038]°C | No |

Under the predeclared rule, a radius is better only if the complete paired 95%
RMSE interval is below zero. Neither 150 m nor 200 m meets that rule. The
200 m result is close, and its MAE improvement over 100 m is supported, but
the primary RMSE decision remains negative.

## Conclusion

Increasing support to 150 m does not materially improve prediction. The 200 m
model provides a small numerical improvement, not a large one, and it is not
statistically supported under the selected sector-bootstrap RMSE rule.
Therefore this benchmark does not justify replacing the production 100 m
model. The production booster and runtime scenario assets were not modified.

The complete machine-readable report, fold details, retained features, models
and out-of-fold predictions are stored locally under
`.cache/local-layers/image-regression/xgboost-radius-benchmark-2026`. The
executed verification notebook is
`playground/landsat_image_regression_xgboost_kfold.ipynb`.
