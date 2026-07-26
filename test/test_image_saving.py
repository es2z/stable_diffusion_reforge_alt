import concurrent.futures
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
