"""Command-line entry point for local official data preparation."""

from __future__ import annotations

import argparse
from pathlib import Path

from .pipeline import prepare, update_index


def parse_source(values: list[str]) -> dict[int, Path]:
    sources = {}
    for value in values:
        if "=" not in value:
            raise argparse.ArgumentTypeError("--source must use YEAR=path.")
        year, path = value.split("=", 1)
        source = Path(path).expanduser()
        if not year.isdigit() or not source.exists():
            raise argparse.ArgumentTypeError(f"Invalid source {value!r}.")
        sources[int(year)] = source
    return sources


def main(argv=None):
    parser = argparse.ArgumentParser(description="Prepare local Greenwave raster layers.")
    parser.add_argument(
        "--dataset",
        choices=(
            "all", "jaarbak", "groenkaart", "landgebruik", "landsat-temperature",
            "landsat-urban-atlas", "landsat-jaarbak", "groenkaart-urban-atlas",
        ),
        default="all",
    )
    parser.add_argument("--source", action="append", default=[], metavar="YEAR=PATH")
    arguments = parser.parse_args(argv)
    sources = parse_source(arguments.source)
    if arguments.dataset == "all" and sources:
        parser.error("Use --source with one explicit --dataset so the year cannot be assigned to the wrong product.")
    datasets = (
        "jaarbak", "groenkaart", "landgebruik", "landsat-temperature",
        "landsat-urban-atlas", "landsat-jaarbak", "groenkaart-urban-atlas",
    ) if arguments.dataset == "all" else (arguments.dataset,)
    for dataset_id in datasets:
        print(f"Preparing {dataset_id}…", flush=True)
        if dataset_id == "landsat-temperature":
            if sources:
                parser.error("Landsat source overrides are not supported; the command caches signed COG windows.")
            from .landsat import prepare_landsat_temperature
            prepare_landsat_temperature()
        elif dataset_id == "landsat-urban-atlas":
            if sources:
                parser.error("The Landsat-Urban Atlas comparison reuses prepared data and accepts no source override.")
            from .landsat_urban_atlas import prepare_landsat_urban_atlas
            prepare_landsat_urban_atlas()
        elif dataset_id == "landsat-jaarbak":
            if sources:
                parser.error("The Landsat-JaarBAK comparison reuses prepared data and accepts no source override.")
            from .landsat_jaarbak import prepare_landsat_jaarbak
            prepare_landsat_jaarbak()
        elif dataset_id == "groenkaart-urban-atlas":
            if sources:
                parser.error("The Green Map-Urban Atlas comparison reuses prepared data and accepts no source override.")
            from .groenkaart_urban_atlas import prepare_groenkaart_urban_atlas
            prepare_groenkaart_urban_atlas()
        elif dataset_id == "landgebruik":
            from .landgebruik import prepare_landgebruik
            prepare_landgebruik(sources)
        else:
            prepare(dataset_id, sources)
        update_index()
    update_index()
    print("Local manifests and PMTiles are ready below .cache/local-layers.")


if __name__ == "__main__":
    main()
