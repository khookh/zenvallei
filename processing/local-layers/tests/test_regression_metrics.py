import numpy as np
import pytest

from greenwave_local_layers.regression_metrics import regression_metrics


def test_regression_metrics_use_predicted_minus_observed_error():
    result = regression_metrics([1.0, 2.0, 3.0], [2.0, 2.0, 2.0])
    assert result["count"] == 3
    assert result["rmse_c"] == pytest.approx(np.sqrt(2 / 3))
    assert result["mae_c"] == pytest.approx(2 / 3)
    assert result["mean_error_c"] == pytest.approx(0)
    assert result["r2"] == pytest.approx(0)


def test_regression_metrics_reject_invalid_vectors():
    with pytest.raises(ValueError, match="non-empty"):
        regression_metrics([], [])
    with pytest.raises(ValueError, match="finite"):
        regression_metrics([1.0], [np.nan])
