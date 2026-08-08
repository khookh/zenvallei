"""Deterministic tests for focal surface-density preparation."""

import math

import numpy as np
import pytest

from greenwave_local_layers.density import (
    ENCODING_NODATA,
    circular_kernel,
    encode_percentage,
    focal_density,
)


def test_circular_kernel_matches_the_100_m_circle_area():
    kernel = circular_kernel(samples=40)
    represented_area = float(kernel.sum()) * 100.0
    assert kernel.shape == (21, 21)
    assert represented_area == pytest.approx(math.pi * 100 * 100, rel=0.002)


def test_focal_density_uses_complete_circle_and_combines_classes():
    kernel = np.ones((3, 3), dtype=np.float32)
    classes = np.stack([
        np.full((7, 7), 0.5, dtype=np.float32),
        np.full((7, 7), 0.25, dtype=np.float32),
        np.full((7, 7), 0.25, dtype=np.float32),
    ])
    densities, coverage = focal_density(classes, np.ones((7, 7), dtype=np.float32), kernel)
    assert densities[:, 3, 3].tolist() == pytest.approx([50.0, 25.0, 25.0])
    assert densities[:, 3, 3].sum() == pytest.approx(100.0)
    assert coverage[3, 3] == pytest.approx(100.0)


def test_focal_density_rejects_insufficient_source_coverage():
    kernel = np.ones((1, 1), dtype=np.float32)
    density, coverage = focal_density(
        np.ones((1, 2, 2), dtype=np.float32),
        np.full((2, 2), 0.94, dtype=np.float32),
        kernel,
    )
    assert np.isnan(density).all()
    assert np.isnan(coverage).all()


def test_percentage_encoding_preserves_hundredths_and_no_data():
    encoded = encode_percentage(np.array([[0.0, 12.345, 100.0, np.nan]], dtype=np.float32))
    assert encoded.tolist() == [[0, 1234, 10000, ENCODING_NODATA]]
