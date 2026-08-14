"""Regression tests for CRH/Dutilleul spatial inference."""

import base64
import io
import zlib

import numpy as np
from affine import Affine
from scipy.ndimage import gaussian_filter

from greenwave_local_layers.spatial_inference import (
    spatial_modified_t_test,
    spatial_modified_t_test_lattice,
)


# SpatialPack 0.4-1's bundled ``murray`` dataset, losslessly compressed as CSV.
# Keeping the upstream fixture frozen here avoids making R a test dependency.
MURRAY_FIXTURE = "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"


def _coordinates(mask):
    rows, columns = np.nonzero(mask)
    return np.column_stack((columns + .5, -(rows + .5)))


def test_matches_spatialpack_murray_fixture():
    raw = zlib.decompress(base64.b64decode(MURRAY_FIXTURE)).decode()
    values = np.loadtxt(io.StringIO(raw), delimiter=",", skiprows=1)
    result = spatial_modified_t_test(values[:, 0], values[:, 1], values[:, 2:4])
    assert result["observationCount"] == 253
    assert result["effectiveSampleSize"] == 156.06173792
    assert result["pValue"] == 0.0


def test_fft_matches_brute_force_for_a_masked_raster():
    random = np.random.default_rng(42)
    y = random.normal(size=(12, 13))
    x = .4 * y + random.normal(size=y.shape)
    mask = random.random(y.shape) > .15
    direct = spatial_modified_t_test(x[mask], y[mask], _coordinates(mask), nclass=5)
    fft = spatial_modified_t_test_lattice(
        x, y, mask, Affine.translation(0, 0) * Affine.scale(1, -1), nclass=5,
    )
    assert fft == direct


def test_autocorrelation_reduces_the_effective_sample():
    random = np.random.default_rng(7)
    latent = gaussian_filter(random.normal(size=(40, 40)), sigma=4)
    x = latent + gaussian_filter(random.normal(size=latent.shape), sigma=2) * .15
    y = latent * .6 + gaussian_filter(random.normal(size=latent.shape), sigma=3) * .4
    result = spatial_modified_t_test_lattice(x, y, np.ones(x.shape, dtype=bool), Affine.scale(30, -30))
    assert result["status"] == "available"
    assert 10 <= result["effectiveSampleSize"] < result["observationCount"]


def test_independent_fields_return_a_complete_contract():
    random = np.random.default_rng(99)
    x = random.normal(size=(30, 31))
    y = random.normal(size=x.shape)
    result = spatial_modified_t_test_lattice(x, y, np.ones(x.shape, dtype=bool), Affine.scale(30, -30))
    assert result["method"] == "crh-dutilleul-modified-t"
    assert result["hypothesis"] == "pearson-r-equals-zero"
    assert result["sidedness"] == "two-sided"
    assert result["distanceClassCount"] == 13
    assert result["status"] == "available"
    assert 0 <= result["pValue"] <= 1


def test_constant_and_insufficient_inputs_explain_unavailable_inference():
    coordinates = np.column_stack((np.arange(12), np.zeros(12)))
    constant = spatial_modified_t_test(np.ones(12), np.arange(12), coordinates)
    insufficient = spatial_modified_t_test(np.arange(9), np.arange(9), coordinates[:9])
    assert constant["status"] == "undefined-variance"
    assert constant["pValue"] is None
    assert insufficient["status"] == "insufficient-observations"
    assert insufficient["observationCount"] == 9
