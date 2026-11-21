"""Route imagery must never inherit a nearby sweep's location or direction."""
import hashlib
import json

import pytest

from wfpipe.context import Context
from wfpipe.steps import thumbs


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ctx = Context(tmp_path, {"matterport_model_id": "model-a"})
    ctx.write_json(ctx.o("pois.json"), {"pois": [{"nearest_node": "a"}, {"nearest_node": "b"}]})
    ctx.write_json(ctx.o("nav_graph.json"), {
        "nodes": [{"id": "a", "kind": "sweep", "floor": "F1"},
                  {"id": "b", "kind": "sweep", "floor": "F2"}],
        "edges": [{"u": "a", "v": "b", "stairs": True}],
    })
    monkeypatch.setattr(thumbs, "_live_poi_sweep_ids", lambda *_: set())
    return ctx


def source(sweep_id):
    return {"id": sweep_id, "floor": {"id": "mp-floor"},
            "position": {"x": 1.0, "y": 2.0, "z": 3.0},
            "pano": {"position": {"x": 1.0, "y": 2.0, "z": 4.5},
                     "rotation": {"x": 0, "y": 0, "z": 0, "w": 1},
                     "skyboxes": [{"urlTemplate": "https://cdn.invalid/private-signed/<face>",
                                   "resolution": "512"}]}}


def set_sources(monkeypatch, *locations):
    monkeypatch.setattr(thumbs, "gql", lambda *_: {"data": {"model": {"locations": locations}}})


def metadata(ctx):
    return json.loads(ctx.o("thumbs/provenance.json").read_text())


def test_missing_sweep_is_not_filled_with_adjacent_stair_photo(workspace, monkeypatch):
    set_sources(monkeypatch, source("a"), source("b"))

    def download(loc, width, height, directory):
        if loc["id"] == "b":
            return False
        (directory / "a.jpg").write_bytes(b"actual-a-photo")
        return True

    monkeypatch.setattr(thumbs, "fetch_thumb", download)
    result = thumbs.run(workspace)
    assert json.loads(workspace.o("thumbs/index.json").read_text()) == ["a"]
    assert not workspace.o("thumbs/b.jpg").exists()
    assert list(metadata(workspace)["images"]) == ["a"]
    assert result["missing"] == 1
    assert result["neighbour_fallback"] == 0


def test_new_download_records_actual_source_without_claiming_route_direction(workspace, monkeypatch):
    set_sources(monkeypatch, source("a"))

    def download(loc, width, height, directory):
        (directory / f"{loc['id']}.jpg").write_bytes(b"actual-a-photo")
        return True

    monkeypatch.setattr(thumbs, "fetch_thumb", download)
    thumbs.run(workspace)
    provenance = metadata(workspace)
    record = provenance["images"]["a"]
    assert provenance["schema"] == "wayfinding.thumbnail-provenance/v1"
    assert provenance["model_id"] == record["model_id"] == "model-a"
    assert record["sweep_id"] == record["source_sweep_id"] == "a"
    assert record["floor_id"] == "F1"
    assert record["matterport_floor_id"] == "mp-floor"
    assert record["sha256"] == hashlib.sha256(b"actual-a-photo").hexdigest()
    assert record["cubemap_face"] == 1
    assert record["direction_verified"] is False
    assert record["location_position"] == source("a")["position"]
    assert record["pano_position"] == source("a")["pano"]["position"]
    assert record["pano_rotation"] == source("a")["pano"]["rotation"]
    assert "private-signed" not in json.dumps(provenance)


def test_reused_legacy_files_never_receive_exact_source_provenance(workspace, monkeypatch):
    directory = workspace.o("thumbs")
    directory.mkdir()
    # This mirrors the old fallback: two sweep filenames with one sweep's bytes.
    (directory / "a.jpg").write_bytes(b"actual-a-photo")
    (directory / "b.jpg").write_bytes(b"actual-a-photo")
    set_sources(monkeypatch, source("a"), source("b"))
    monkeypatch.setattr(thumbs, "fetch_thumb", lambda *_: pytest.fail("legacy files must not be silently redownloaded"))
    result = thumbs.run(workspace)
    assert json.loads((directory / "index.json").read_text()) == ["a", "b"]
    assert metadata(workspace)["images"] == {}
    assert result["exact_source_provenance"] == 0


@pytest.mark.parametrize("corruption", ["bytes", "model", "source_sweep", "url", "schema"])
def test_reused_provenance_rejects_changed_content_or_identity(workspace, monkeypatch, corruption):
    directory = workspace.o("thumbs")
    directory.mkdir()
    path = directory / "a.jpg"
    path.write_bytes(b"actual-a-photo")
    record = thumbs._source_provenance(source("a"), {"floor": "F1"}, "model-a", path)
    provenance = {"schema": thumbs.PROVENANCE_SCHEMA, "model_id": "model-a", "images": {"a": record}}
    if corruption == "bytes":
        path.write_bytes(b"unrelated-photo")
    elif corruption == "model":
        provenance["model_id"] = "other-model"
    elif corruption == "source_sweep":
        record["source_sweep_id"] = "b"
    elif corruption == "url":
        record["url"] = "thumbs/b.jpg"
    else:
        provenance["schema"] = "unversioned"
    workspace.write_json(directory / "provenance.json", provenance)
    set_sources(monkeypatch)
    thumbs.run(workspace)
    assert metadata(workspace)["images"] == {}


def test_valid_exact_provenance_survives_rerun_and_network_failure(workspace, monkeypatch):
    directory = workspace.o("thumbs")
    directory.mkdir()
    path = directory / "a.jpg"
    path.write_bytes(b"actual-a-photo")
    record = thumbs._source_provenance(source("a"), {"floor": "F1"}, "model-a", path)
    workspace.write_json(directory / "provenance.json", {
        "schema": thumbs.PROVENANCE_SCHEMA, "model_id": "model-a", "images": {"a": record}})

    def unavailable(*_):
        raise OSError("offline")

    monkeypatch.setattr(thumbs, "gql", unavailable)
    thumbs.run(workspace)
    assert metadata(workspace)["images"] == {"a": record}


def test_missing_or_invalid_pose_is_not_invented(workspace):
    path = workspace.o("photo.jpg")
    path.write_bytes(b"photo")
    loc = {"id": "a", "position": {"x": 0, "y": 0, "z": float("nan")},
           "pano": {"rotation": {"x": 0, "y": 0, "z": 0}}}
    record = thumbs._source_provenance(loc, {}, "model-a", path)
    assert not {"floor_id", "matterport_floor_id", "location_position", "pano_position", "pano_rotation"}.intersection(record)
    assert record["direction_verified"] is False


def test_disabled_thumbnails_clear_index_and_provenance(workspace):
    workspace.cfg["thumbs"]["enabled"] = False
    workspace.cfg.pop("matterport_model_id")
    thumbs.run(workspace)
    assert metadata(workspace)["images"] == {}
    assert json.loads(workspace.o("thumbs/index.json").read_text()) == []
