# XGBoost Optuna selection, 22 June 2026

The local scenario uses one reproducible Optuna study with 50 completed trials. Every trial proposes the complete feature, booster and prediction-smoothing recipe and is evaluated across the same five sector-held-out folds with seed 42 and a 200 m target embargo.

Run:

```powershell
pnpm lst-scenario:xgboost-optuna
pnpm lst-scenario:xgboost-optuna-notebook
pnpm lst-scenario:prepare
```

The water-v5 SQLite study, CSV trial table, candidate model, prediction archive, JSON report and executed notebook are written below `.cache/local-layers/image-regression/xgboost-optuna-2026-water-v5`. This versioned location starts a completely new study for the composite-water feature contract. It may resume only interrupted water-v5 work and completes 50 successful full-fold trials.

The tracked notebook at `playground/xgboost_2026_heatwave_regression_zennevallei.ipynb` is the end-to-end reproducibility entry point. It calls the production helpers and documents, with intermediate tables and plots:

- source hashes and preprocessing eligibility;
- the geographic and temperature cohort;
- ring-based physical predictors;
- sector folds and their 200 m embargo;
- the complete Optuna history and parameter responses;
- held-out feature elimination, fold metrics and residuals;
- training the all-data deployment candidate;
- staged bundle verification and the resulting runtime artefacts.

It does not reimplement the preparation or training algorithms in notebook cells. A clean cache therefore exercises the same code used by the local scenario runtime.

The ten tuned variables are ring width, smoothing sigma, learning rate, maximum depth, minimum child weight, row sampling, column sampling, gamma and L1/L2 regularisation. The 100 m physical support, corrected five land-cover channels, cohort, folds, embargo and seed remain fixed. Water is the additive union of Urban Atlas 2021 water and Flanders Land Use 2025 class 17. Flanders water is assigned from 10 m to 1 m by nearest neighbour and has absolute upper-surface priority.

The selected score is model-selection cross-validation and is not an independent external accuracy estimate. Contract-v4 scores are retained for traceability but are not used as a promotion gate because they describe a different analytical feature contract. The v5 candidate is built in a staging directory and promoted only after its model, retained-feature artifact, catalogue and baseline-inference-grid hashes validate together; the canonical report is replaced last.

## Completed study

The fresh completed 50-trial water-v5 study used 192,595 clear Landsat observations across 154 statistical sectors. Optuna selected 5 m rings and 60 m Gaussian prediction smoothing. Leakage-aware feature elimination retained 34 of 100 predictors.

On identical held-out observations and folds, the selected candidate achieved:

- RMSE: 2.336°C.
- MAE: 1.807°C.
- R²: 0.656.
- Mean error: −0.009°C.

The all-feature optimum was 2.3265°C RMSE; the 34-feature result was 2.3361°C, a 0.0096°C degradation that remains inside the fixed 0.01°C simplification tolerance. The superseded v4 production score was 2.3428°C RMSE, but that value is reported only for traceability because it used a different water-feature contract. The verified v5 bundle replaced it without treating the difference as a promotion test.
