"""Discoverable contracts for every local data-preparation command."""

from __future__ import annotations

from dataclasses import dataclass
from importlib import import_module
from pathlib import Path


@dataclass(frozen=True)
class DatasetSpec:
    """One layer, comparison, or local tool produced by the Python pipeline."""

    dataset_id: str
    kind: str
    summary: str
    dependencies: tuple[str, ...]
    accepts_source_overrides: bool
    published: bool
    handler_module: str
    handler_name: str
    generic_dataset_id: str | None = None

    @property
    def cache_output(self) -> str:
        return f".cache/local-layers/{self.dataset_id}"

    @property
    def source_policy(self) -> str:
        return "YEAR=path overrides accepted" if self.accepts_source_overrides else "prepared inputs only"

    def prepare(self, sources: dict[int, Path]) -> None:
        if sources and not self.accepts_source_overrides:
            raise ValueError(f"{self.dataset_id} accepts no --source overrides.")
        handler = getattr(import_module(self.handler_module), self.handler_name)
        if self.generic_dataset_id is not None:
            handler(self.generic_dataset_id, sources)
        else:
            handler(sources) if self.accepts_source_overrides else handler()


DATASET_SPECS = (
    DatasetSpec("jaarbak", "layer", "Soil sealing by reference year.", (), True, True,
                "greenwave_local_layers.pipeline", "prepare", "jaarbak"),
    DatasetSpec("groenkaart", "layer", "High- and low-green cover by reference year.", (), True, True,
                "greenwave_local_layers.pipeline", "prepare", "groenkaart"),
    DatasetSpec("landgebruik", "layer", "Flanders land-use classes and agricultural detail.", (), True, True,
                "greenwave_local_layers.landgebruik", "prepare_landgebruik"),
    DatasetSpec("landsat-temperature", "layer", "Clear/cloud-masked Landsat surface temperature.", (), False, True,
                "greenwave_local_layers.landsat", "prepare_landsat_temperature"),
    DatasetSpec("landsat-urban-atlas", "comparison", "Landsat temperature by Urban Atlas class.",
                ("landsat-temperature", "urban-atlas"), False, True,
                "greenwave_local_layers.landsat_urban_atlas", "prepare_landsat_urban_atlas"),
    DatasetSpec("landsat-jaarbak", "comparison", "Landsat temperature and soil-sealing density.",
                ("landsat-temperature", "jaarbak"), False, True,
                "greenwave_local_layers.landsat_jaarbak", "prepare_landsat_jaarbak"),
    DatasetSpec("sealed-urban-comparisons", "comparison", "Green, income, and Landsat comparisons in urban fabric.",
                ("groenkaart", "jaarbak", "landsat-temperature", "income"), False, True,
                "greenwave_local_layers.sealed_urban_comparisons", "prepare_sealed_urban_comparisons"),
    DatasetSpec("groenkaart-population", "comparison", "Green cover and modelled population profiles.",
                ("groenkaart", "population"), False, True,
                "greenwave_local_layers.groenkaart_population", "prepare_groenkaart_population"),
    DatasetSpec("landsat-population", "comparison", "Landsat temperature and modelled population profiles.",
                ("landsat-temperature", "population"), False, True,
                "greenwave_local_layers.landsat_population", "prepare_landsat_population"),
    DatasetSpec("jaarbak-socioeconomic", "comparison", "Soil-sealing density with population and income.",
                ("jaarbak", "population", "income", "urban-atlas"), False, True,
                "greenwave_local_layers.jaarbak_socioeconomic", "prepare_jaarbak_socioeconomic"),
    DatasetSpec("land-cover-scenario", "local tool", "Counterfactual land-cover change and estimated delta LST.",
                ("groenkaart", "jaarbak", "landgebruik", "landsat-temperature"), False, False,
                "greenwave_local_layers.lst_scenario", "prepare_lst_scenario"),
)

DATASETS_BY_ID = {spec.dataset_id: spec for spec in DATASET_SPECS}


def dataset_ids() -> tuple[str, ...]:
    return tuple(spec.dataset_id for spec in DATASET_SPECS)


def dataset_spec(dataset_id: str) -> DatasetSpec:
    try:
        return DATASETS_BY_ID[dataset_id]
    except KeyError as error:
        raise ValueError(f"Unknown dataset {dataset_id!r}.") from error


def format_dataset_list() -> str:
    rows = ["DATASET                       KIND        LIVE  SUMMARY"]
    for spec in DATASET_SPECS:
        rows.append(
            f"{spec.dataset_id:<29} {spec.kind:<11} "
            f"{'yes' if spec.published else 'local':<5} {spec.summary}"
        )
    return "\n".join(rows)


def format_dataset_description(spec: DatasetSpec) -> str:
    dependencies = ", ".join(spec.dependencies) if spec.dependencies else "direct official source"
    return "\n".join((
        f"Dataset: {spec.dataset_id}",
        f"Kind: {spec.kind}",
        f"Purpose: {spec.summary}",
        f"Inputs: {dependencies}",
        f"Source policy: {spec.source_policy}",
        f"Cache output: {spec.cache_output}",
        f"Distribution: {'published static assets' if spec.published else 'local runtime only'}",
    ))
