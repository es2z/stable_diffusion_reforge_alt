import concurrent.futures
import os
import threading

import pytest


@pytest.mark.usefixtures("initialize")
def test_save_images_parallel_uses_one_worker_per_request(monkeypatch):
    from modules import images

    test_batch_size = 8
    barriers = [threading.Barrier(test_batch_size), threading.Barrier(test_batch_size)]
    worker_ids = [set(), set()]
    worker_ids_lock = threading.Lock()

    def fake_save_image(**request):
        with worker_ids_lock:
            worker_ids[request["batch"]].add(threading.get_ident())
        barriers[request["batch"]].wait(timeout=5)
        return request["index"]

    monkeypatch.setattr(images, "save_image", fake_save_image)

    first_results = images.save_images_parallel([{"batch": 0, "index": index} for index in range(test_batch_size)])
    second_results = images.save_images_parallel([{"batch": 1, "index": index} for index in range(test_batch_size)])

    assert first_results == list(range(test_batch_size))
    assert second_results == list(range(test_batch_size))
    assert len(worker_ids[0]) == test_batch_size
    assert worker_ids[1] == worker_ids[0]


@pytest.mark.usefixtures("initialize")
def test_sequence_numbers_are_unique_during_parallel_saves(tmp_path):
    from modules import images

    request_count = 64
    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
        sequence_numbers = list(executor.map(
            lambda _: images.get_next_sequence_number_threadsafe(str(tmp_path), ""),
            range(request_count),
        ))

    assert len(set(sequence_numbers)) == request_count
    assert sorted(sequence_numbers) == list(range(request_count))


def _save_request(tmp_path, index, extension="png"):
    from PIL import Image

    return {
        "image": Image.new("RGB", (64, 64), (index * 20 % 256, 0, 0)),
        "path": str(tmp_path),
        "basename": "",
        "seed": 1000 + index,
        "prompt": f"prompt {index}",
        "extension": extension,
        "info": f"prompt {index}\nSteps: 1, Seed: {1000 + index}",
    }


def _files(tmp_path):
    return sorted(x.name for x in tmp_path.iterdir() if not x.name.startswith("."))


@pytest.fixture
def background_saving(monkeypatch):
    """Turns saving in the background on, with one image written at a time, and lets the test hold the writing back."""
    from modules import images, shared

    monkeypatch.setitem(shared.opts.data, "save_images_async", True)
    monkeypatch.setitem(shared.opts.data, "save_images_async_workers", 1)
    monkeypatch.setitem(shared.opts.data, "save_to_dirs", False)

    gate = threading.Event()
    original = images.save_image_with_geninfo

    def held_back(*args, **kwargs):
        assert gate.wait(timeout=30)
        return original(*args, **kwargs)

    monkeypatch.setattr(images, "save_image_with_geninfo", held_back)

    yield gate

    gate.set()
    assert images.wait_for_background_saves(timeout=30)


@pytest.mark.usefixtures("initialize")
def test_deferred_save_chooses_the_name_first_and_writes_later(tmp_path, monkeypatch):
    from modules import images, shared

    monkeypatch.setitem(shared.opts.data, "save_to_dirs", False)

    first = _save_request(tmp_path, 0)
    second = _save_request(tmp_path, 1)

    write_first = images.save_image(**first, defer=True)
    write_second = images.save_image(**second, defer=True)
    assert _files(tmp_path) == []

    # written in the other order: the names were given out when the saves were prepared
    fullfn_second, _ = write_second()
    fullfn_first, _ = write_first()

    assert _files(tmp_path) == ["00000-1000-prompt 0.png", "00001-1001-prompt 1.png"]
    assert first["image"].already_saved_as == fullfn_first
    assert second["image"].already_saved_as == fullfn_second

    from PIL import Image
    with Image.open(fullfn_second) as saved:
        assert saved.info["parameters"] == second["info"]


@pytest.mark.usefixtures("initialize")
def test_background_saves_return_before_the_files_are_written(tmp_path, background_saving):
    from modules import images

    requests = [_save_request(tmp_path, index) for index in range(5)]

    futures = images.save_images_parallel(requests)

    assert len(futures) == 5
    assert _files(tmp_path) == []
    assert images.background_saves_unfinished() == 5
    assert not images.wait_for_background_saves(timeout=0.2)

    background_saving.set()

    assert images.wait_for_background_saves(timeout=30)
    assert images.background_saves_unfinished() == 0
    assert _files(tmp_path) == [f"{index:05}-{1000 + index}-prompt {index}.png" for index in range(5)]
    assert [future.result()[0] for future in futures] == [request["image"].already_saved_as for request in requests]


@pytest.mark.usefixtures("initialize")
def test_background_saves_wait_when_too_many_images_pile_up(tmp_path, background_saving):
    from modules import images

    # one image is written at a time, and 16 may wait
    requests = [_save_request(tmp_path, index) for index in range(19)]
    thread = threading.Thread(target=images.save_images_in_background, args=(requests,))
    thread.start()
    thread.join(timeout=2)

    assert thread.is_alive()
    assert images.background_saves_unfinished() == 16

    background_saving.set()
    thread.join(timeout=30)

    assert not thread.is_alive()
    assert images.wait_for_background_saves(timeout=30)
    assert len(_files(tmp_path)) == 19


@pytest.mark.usefixtures("initialize")
def test_a_failed_background_save_does_not_stop_the_others(tmp_path, background_saving, monkeypatch):
    from modules import images

    held_back = images.save_image_with_geninfo

    def fail_for_one(image, geninfo, *args, **kwargs):
        if "prompt 1" in geninfo:
            raise OSError("disk full")
        return held_back(image, geninfo, *args, **kwargs)

    monkeypatch.setattr(images, "save_image_with_geninfo", fail_for_one)
    background_saving.set()

    futures = images.save_images_in_background([_save_request(tmp_path, index) for index in range(3)])

    assert images.wait_for_background_saves(timeout=30)
    assert [future.result() is None for future in futures] == [False, True, False]
    assert _files(tmp_path) == ["00000-1000-prompt 0.png", "00002-1002-prompt 2.png"]


@pytest.mark.usefixtures("initialize")
def test_a_job_ends_when_its_files_are_written_but_frees_the_queue_before(tmp_path, background_saving):
    from modules import call_queue, images, progress

    requests = [_save_request(tmp_path, index) for index in range(3)]

    def generate(id_task):
        images.save_images_parallel(requests)
        return [request["image"] for request in requests], "", ""

    def other_job():
        return ["other"]

    id_task = "task(test-background-saving)"
    results = []
    job = threading.Thread(target=lambda: results.append(call_queue.wrap_gradio_gpu_call(generate, extra_outputs=[None, "", ""])(id_task)))
    job.start()
    job.join(timeout=2)

    # generating is over, the files are not written: the job has not returned ...
    assert job.is_alive()
    assert _files(tmp_path) == []

    # ... the browser is told that it is still busy ...
    status = progress.progressapi(progress.ProgressRequest(id_task=id_task))
    assert status.active and not status.completed
    assert status.textinfo == "Saving images..."

    # ... and the next job in the queue runs
    assert call_queue.wrap_queued_call(other_job)() == ["other"]
    assert job.is_alive()

    background_saving.set()
    job.join(timeout=30)

    assert not job.is_alive()
    assert len(_files(tmp_path)) == 3
    assert all(image.already_saved_as for image in results[0][0])

    status = progress.progressapi(progress.ProgressRequest(id_task=id_task))
    assert status.completed and not status.active


@pytest.mark.usefixtures("initialize")
def test_saving_stays_in_step_when_background_saving_is_off(tmp_path, monkeypatch):
    from modules import images, shared

    monkeypatch.setitem(shared.opts.data, "save_images_async", False)
    monkeypatch.setitem(shared.opts.data, "save_to_dirs", False)

    results = images.save_images_parallel([_save_request(tmp_path, index) for index in range(3)])

    assert sorted(os.path.basename(fullfn) for fullfn, _ in results) == _files(tmp_path)
    assert len(_files(tmp_path)) == 3
    assert images.background_saves_unfinished() == 0
