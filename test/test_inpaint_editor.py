import base64
import io

import pytest
from PIL import Image


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


@pytest.mark.usefixtures("initialize")
def test_mask_of_the_editor_is_read_as_a_greyscale_image():
    from modules.img2img import decode_inpaint_editor_mask

    mask = Image.new("RGB", (64, 32), "black")
    mask.paste((255, 255, 255), (10, 5, 20, 15))

    result = decode_inpaint_editor_mask(_data_url(mask), (64, 32))

    assert result.mode == "L"
    assert result.size == (64, 32)
    assert result.getpixel((12, 7)) == 255
    assert result.getpixel((30, 7)) == 0


@pytest.mark.usefixtures("initialize")
def test_mask_of_another_size_is_scaled_to_the_image():
    from modules.img2img import decode_inpaint_editor_mask

    mask = Image.new("L", (32, 16), 0)
    mask.paste(255, (0, 0, 16, 16))

    result = decode_inpaint_editor_mask(_data_url(mask), (64, 32))

    assert result.size == (64, 32)
    assert result.getpixel((10, 10)) == 255
    assert result.getpixel((50, 10)) == 0


@pytest.mark.usefixtures("initialize")
@pytest.mark.parametrize("data", ["", None, _data_url(Image.new("L", (8, 8), 0))])
def test_no_mask_asks_for_one(data):
    from modules.img2img import decode_inpaint_editor_mask

    with pytest.raises(ValueError, match="draw a mask first.*Inpaint\\+ tab"):
        decode_inpaint_editor_mask(data, (8, 8))


@pytest.mark.usefixtures("initialize")
def test_unreadable_mask_says_so():
    from modules.img2img import decode_inpaint_editor_mask

    with pytest.raises(ValueError, match="could not be read"):
        decode_inpaint_editor_mask("data:image/png;base64,bm90IGEgcG5n", (8, 8))
