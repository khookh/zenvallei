from pathlib import Path

import pytest

from greenwave_local_layers.cli import main
from greenwave_local_layers.dataset_registry import (
    DATASET_SPECS,
    dataset_ids,
    dataset_spec,
    format_dataset_description,
)


def test_registry_has_unique_ordered_dataset_contracts():
    assert len(dataset_ids()) == len(set(dataset_ids())) == 10
    assert tuple(spec.dataset_id for spec in DATASET_SPECS) == dataset_ids()
    assert dataset_spec("land-cover-scenario").published is False
    assert all(spec.cache_output.startswith(".cache/local-layers/") for spec in DATASET_SPECS)


def test_registry_description_exposes_scientific_pipeline_boundaries():
    text = format_dataset_description(dataset_spec("landsat-jaarbak"))
    assert "landsat-temperature" in text
    assert "jaarbak" in text
    assert "prepared inputs only" in text
    assert ".cache/local-layers/landsat-jaarbak" in text


def test_cli_lists_and_describes_without_preparing(capsys):
    main(["--list"])
    listed = capsys.readouterr().out
    assert "landsat-temperature" in listed
    assert "land-cover-scenario" in listed
    main(["--describe", "groenkaart"])
    described = capsys.readouterr().out
    assert "YEAR=path overrides accepted" in described


def test_non_override_dataset_rejects_sources(tmp_path):
    source = tmp_path / "source.tif"
    source.touch()
    with pytest.raises(SystemExit):
        main(["--dataset", "landsat-temperature", "--source", f"2026={source}"])
