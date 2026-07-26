import concurrent.futures
import threading

import pytest


@pytest.mark.usefixtures("initialize")
def test_save_images_parallel_uses_one_worker_per_request(monkeypatch):
    from modules import images

    request_count = 8
    barrier = threading.Barrier(request_count)
    worker_ids = set()
    worker_ids_lock = threading.Lock()

    def fake_save_image(**request):
        with worker_ids_lock:
            worker_ids.add(threading.get_ident())
        barrier.wait(timeout=5)
        return request["index"]

    monkeypatch.setattr(images, "save_image", fake_save_image)

    results = images.save_images_parallel([{"index": index} for index in range(request_count)])

    assert results == list(range(request_count))
    assert len(worker_ids) == request_count


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
