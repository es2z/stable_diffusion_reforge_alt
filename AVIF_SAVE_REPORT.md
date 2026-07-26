# reForge AVIF 保存経路・エンコーダ更新・非同期化調査

- 調査日: 2026-07-21 (JST)
- 対象コミット: `fc2b1388fcdeb65df6ba8c92543672bc3a6e9507`
- 対象環境: Windows x86-64 / Python 3.10.11
- 本書の目的: AVIF 関係の現状、更新候補、調整可能なパラメータ、保存遅延の原因、非同期化の可否を明らかにし、後続担当が本書だけで変更を実装できる状態にする
- 非目標: 本調査では依存パッケージ、Python ソース、設定値を変更しない。本ファイルだけを追加する

## 1. 結論

1. 現在の AVIF 実装は `Pillow 9.5.0` に `pillow-avif-plugin 1.4.3` を追加した構成である。AVIF の生成情報は EXIF `UserComment`、画質は JPEG と共通の `jpeg_quality`、それ以外の AVIF パラメータはプラグイン既定値のままになっている。
2. 更新候補は、調査時点の PyPI 最新版 `pillow-avif-plugin 1.5.5` とする。既存の Pillow 9.5.0は更新せず、プラグインだけ更新するのが最小リスクである。Python 3.10.11 + Pillow 9.5.0 + plugin 1.5.5 で、RGB/RGBA、EXIF UserComment、aom/SVT-AV1/rav1e、`max_threads` の動作を確認済みである。
3. ただし、1.4.3から1.5.5への更新だけでは今回の実画像による aom エンコード時間は約0.156秒から約0.149秒になっただけで、体感速度の大幅改善は期待できない。更新の主目的はバグ修正、新しいエンコーダ、将来互換性である。
4. 保存時間への効果が大きかったのは `speed` である。同じ1536×864画像、quality 80、aom では speed 6が約0.15秒、speed 8が約0.05秒、speed 10が約0.02秒だった。まず `codec` と `speed` などを Settings に公開するべきである。
5. 保存は `modules/images.py::save_image()` の中で同期実行される。エンコード、`.tmp` への書き込み、atomic replace、付随 `.txt`、保存後コールバックが完了するまで生成リクエストは戻らない。
6. 完全な fire-and-forget 非同期化は技術的には可能だが、現在の「関数から戻った時にはファイルが存在する」という契約を壊す。UI表示、手動保存、学習、拡張機能コールバック、同名ファイル処理にも影響する。既定動作には推奨しない。
7. 推奨順序は次のとおり。

   1. plugin 1.5.5へ更新する
   2. AVIF codec/speed/subsampling/max_threads を Settings に追加する
   3. 通常は `codec=auto` または `aom`、`speed=8` を起点に実画像で調整する
   4. それでも UI 応答が問題になる場合だけ、自動生成保存に限定した opt-in 非同期キューを実験する

## 2. 現在の依存関係

### 2.1 インストール済みバージョン

実際に WebUI が使用する `venv\Scripts\python.exe` で確認した。

| 項目 | 現在値 |
|---|---:|
| Python | 3.10.11 |
| Pillow | 9.5.0 |
| pillow-avif-plugin | 1.4.3 |
| libavif | 1.0.3 |
| libaom | 3.8.1 |
| dav1d | 1.3.0 |
| rav1e | 0.6.1としてランタイム表示（plugin changelog上の同梱表は0.7.0） |
| SVT-AV1 | 1.7.0 |

現在の Windows wheel では、少なくとも `aom`、`rav1e`、`svt` の3エンコーダが利用可能だった。`codec=auto` は利用可能なエンコーダからプラグインが選択し、通常は aom になる。

### 2.2 バージョン固定箇所

- `requirements.txt`
  - `Pillow` は無指定
  - `pillow-avif-plugin==1.4.3`
- `requirements_versions.txt`
  - `Pillow==9.5.0`
  - `pillow-avif-plugin==1.4.3`
- `modules/launch_utils.py`
  - `REQS_FILE` が未指定なら `requirements_versions.txt` を使う
  - 起動時に固定バージョンと環境が一致しなければ `pip install -r requirements_versions.txt` が走る

したがって、将来更新するときは最低でも両 requirements ファイルの plugin 行を同じバージョンにする。実際の通常起動を支配するのは `requirements_versions.txt` である。

`.venv` も存在するが Pillow は入っていなかった。WebUI の実行環境は `venv` であり、更新・検証時に取り違えないこと。

## 3. 現在の AVIF 保存処理

### 3.1 プラグイン登録

`modules/images.py` 冒頭で次の import を行うことで、Pillow の拡張子レジストリに AVIF を登録している。

```python
# pillow_avif needs to be imported somewhere in code for it to work
import pillow_avif  # noqa: F401
```

この import は plugin 1.5.5でも必要であり、削除しない。

### 3.2 設定の場所

`modules/shared_options.py` の `saving-images` セクションに次がある。

| 設定キー | 現在の意味 |
|---|---|
| `samples_format` | 通常画像の形式。選択肢に `avif` がある |
| `grid_format` | グリッド形式。選択肢に `avif` がある |
| `jpeg_quality` | JPEGとAVIF共通のquality。1～100、既定80 |
| `save_images_add_number` | 連番を付ける |
| `save_images_replace_action` | 同名ファイルを置換するか番号を追加するか |
| `export_for_4chan` | 大きな画像を追加でJPEG化する |

現在の `config.json` の主要値は次のとおり。

```text
samples_format=avif
grid_format=png
jpeg_quality=80
save_to_dirs=true
directories_filename_pattern=[date]
save_images_add_number=true
save_images_replace_action=Replace
```

`config.json` はユーザーの実行時設定であり、将来のコード実装時にも自動で書き換えない。新しい OptionInfo を追加すれば、キーがない既存設定にはコード側の既定値が使われ、ユーザーが Settings を保存した後に `config.json` へ追加される。

### 3.3 AVIF へ渡している値

`modules/images.py::save_image_with_geninfo()` の AVIF 分岐は、現在、次の引数だけを `PIL.Image.save()` に渡す。

```python
image.save(
    filename,
    format=image_format,
    quality=opts.jpeg_quality,
    exif=exif_bytes,
)
```

つまり、現在の実効値は次のとおり。

```text
quality       = config.json の jpeg_quality（現在80）
speed         = plugin既定の6
codec         = plugin既定のauto（通常aom）
subsampling   = plugin既定の4:2:0
max_threads   = plugin既定（1.4.3ではUIから指定不可）
range         = full
autotiling    = true（tile_rows/cols未指定時）
tile_rows     = 0
tile_cols     = 0
```

AVIF の生成情報は `piexif` で EXIF `UserComment` に格納される。`enable_pnginfo=false` または生成情報が `None` の場合、EXIFは渡さない。

### 3.4 同期保存の順序

`modules/images.py::save_image()` はおおむね次の順番で動く。

1. 保存先ディレクトリとファイル名を決める
2. `before_image_saved_callback(params)` を同期呼び出しする
3. 最終画像、ファイル名、生成情報をコールバックの変更後の値にする
4. `{filename_without_extension}.tmp` に同期エンコードする
5. `os.replace()` で最終ファイル名へ atomic replace する
6. `image.already_saved_as` を設定する
7. 必要なら4chan向けJPEGを作る
8. 必要なら生成情報 `.txt` を作る
9. `image_saved_callback(params)` を同期呼び出しする
10. `(fullfn, txt_fullfn)` を返す

この順序は事実上の公開契約である。特に以下のコードが「戻った時点でファイルが存在する」ことを利用する。

- `modules/ui_tempdir.py` は `image.already_saved_as` のファイルを直ちに `os.path.isfile()` と `os.path.getmtime()` で確認する
- `modules/ui_common.py` の手動 Save は返されたパスを使う
- textual inversion / hypernetwork は返されたファイルを直後の処理に使う
- `on_image_saved` 拡張コールバックは保存済みファイルを扱える前提である
- sd-dynamic-prompts は保存前コールバックで隣接CSVを書き出す

## 4. 更新候補の評価

### 4.1 推奨候補

調査時点の PyPI 最新版は `pillow-avif-plugin 1.5.5`（2026-01-22公開）である。

1.5.5 Windows cp310 wheel の実ランタイム値:

| 項目 | 1.4.3 | 1.5.5 |
|---|---:|---:|
| libavif | 1.0.3 | 1.3.0 |
| libaom | 3.8.1 | 3.13.1 |
| dav1d | 1.3.0 | 1.5.3 |
| rav1e | 0.6.1 runtime表示 | 0.8.1 |
| SVT-AV1 | 1.7.0 | 3.1.2 |

1.4.4以降では `max_threads` を `Image.save()` から渡せる。1.5系では Pillow 11.2.1互換、Python 3.13/3.14対応、向きやアニメーション関係の修正、同梱 codec の更新が入っている。今回の古い環境では Pillow 自体を上げず、pluginだけ更新する。

### 4.2 Pillow 9.5.0との互換性確認

1.5.5を一時ディレクトリへ導入し、既存 `venv` の Pillow 9.5.0から読み込ませて確認した。プロジェクト環境や requirements は変更していない。

確認済み:

- plugin import
- AVIF RGB encode/decode
- AVIF RGBA encode/decode
- EXIF UserComment の保存・再読込
- `codec=aom`
- `codec=rav1e`
- `codec=svt`
- `speed=6/8/10`
- `max_threads=2`

RGBA + EXIF smoke test の結果:

```text
plugin 1.5.5
decoded mode RGBA
decoded size (64, 64)
metadata smoke-test
encoded bytes 616
```

これは基本互換性の確認であり、全WebUI機能の回帰試験ではない。

### 4.3 将来の更新手順

後続担当が実装するときだけ、次の変更を行う。

`requirements.txt`:

```diff
-pillow-avif-plugin==1.4.3
+pillow-avif-plugin==1.5.5
```

`requirements_versions.txt`:

```diff
-pillow-avif-plugin==1.4.3
+pillow-avif-plugin==1.5.5
```

環境へ明示的に反映する場合:

```powershell
venv\Scripts\python.exe -m pip install --upgrade pillow-avif-plugin==1.5.5
```

通常は requirements を更新して WebUI を再起動すれば、`modules/launch_utils.py` が差分を検出して導入する。起動時の自動導入に任せる場合でも、初回起動ログでインストール成功を確認する。

確認コマンド:

```powershell
venv\Scripts\python.exe -c "import PIL, pillow_avif; import pillow_avif._avif as av; print(PIL.__version__); print(pillow_avif.__version__); print(av.libavif_version); print(av.AvifCodecVersions())"
```

期待値:

```text
Pillow 9.5.0
pillow_avif 1.5.5
libavif 1.3.0
aom 3.13.1 / rav1e 0.8.1 / svt 3.1.2 を含む表示
```

### 4.4 切り戻し

1. 両 requirements ファイルの plugin を `1.4.3` に戻す
2. 次を実行するか、WebUI起動時の requirements 処理に任せる

```powershell
venv\Scripts\python.exe -m pip install --force-reinstall pillow-avif-plugin==1.4.3
```

3. 後述の追加設定を実装済みでも、1.4.3は `quality/speed/codec/subsampling` を受け取れる。ただし `max_threads` のUI指定は1.4.4以降の機能なので、完全切り戻し時は `max_threads` 引数も外す
4. 既に作成した AVIF ファイルは標準AVIFであり、pluginの切り戻しによる変換は不要

## 5. AVIF エンコードパラメータ

### 5.1 通常公開するべき項目

| Pillow引数 | 値 | plugin既定 | 効果 |
|---|---|---:|---|
| `quality` | 0～100 | 75 | 高いほど高画質・大容量。現在は `jpeg_quality=80` |
| `speed` | 0～10 | 6 | 0が低速・高効率、10が最速。codec間で同じ数字の意味・品質は同一ではない |
| `codec` | `auto/aom/rav1e/svt` | `auto` | AV1 encoderを選択する |
| `subsampling` | `4:0:0/4:2:0/4:2:2/4:4:4` | 通常`4:2:0` | 色差解像度。4:4:4は文字・線画向きだが大容量になりやすい |
| `max_threads` | 0以上 | 0 | 0はライブラリへ上限を指定しない。aomは最大64 |

`quality` は既に Settings にある。安定性と既存設定互換のため、最初の実装では AVIF 専用qualityを新設せず、現在の `jpeg_quality` を使い続ける。

### 5.2 上級項目

| Pillow引数 | 意味 | 推奨 |
|---|---|---|
| `range` | YUV range。`full` または `limited` | 静止画用途では既定 `full` のまま |
| `tile_rows` | tile row数のlog2、0～6 | 通常は指定しない |
| `tile_cols` | tile column数のlog2、0～6 | 通常は指定しない |
| `autotiling` | 自動tile | 既定 `true` のまま |
| `alpha_premultiplied` | alphaがpremultipliedか | 通常 `false` |
| `qmin/qmax` | 旧quantizer指定 | libavif 1.xではqualityが主。新UIには出さない |
| `advanced` | codec固有のkey/value | codecの世代で互換性が変わるため通常UIには出さない |

「プリセット」は plugin の独立した名前付きプリセットではなく、実質的には `codec` と `speed` の組み合わせになる。SVT-AV1では `speed` がSVT presetへ渡され、aomでは速度・探索量の調整になる。ただし、SVT speed 8とaom speed 8を同品質とみなしてはいけない。

### 5.3 codec選択の考え方

- `auto`
  - 最小設定で、現在と同じ挙動
  - wheel構成に応じてpluginが選ぶ。今回の環境では通常aom
- `aom`
  - 現行の実質既定
  - 今回の静止画テストでは最速で、ファイルも小さかった
  - まず aom + speed 8 を推奨起点にする
- `svt`
  - 新版1.5.5でSVT-AV1 3.1.2へ大幅更新
  - 今回の単画像ではaomより遅く大きかった
  - 特定画像・設定では結果が変わるため、固定せず選択肢として残す
- `rav1e`
  - 選択可能にする
  - 今回はaomより遅かった

利用できない codec を明示選択した場合は、暗黙にaomへ戻さず plugin の `ValueError("Invalid saving codec")` を表示する。ユーザーが指定した設定と実ファイルのcodecが知らないうちに変わるのを防ぐためである。

## 6. 実測結果

### 6.1 方法と注意点

- 同一マシン上で `io.BytesIO` へ1回ずつエンコードした
- ディスク書き込みとウイルス対策ソフトの影響は含まない
- qualityは80
- subsamplingは既定4:2:0
- file sizeはエンコード後のBytesIOサイズ
- 単発測定なので厳密な性能試験ではない
- PSNR/SSIMULACRA等の画質評価は行っていない
- speedを上げたときの容量差は画像内容に強く依存する

### 6.2 実際の生成画像相当

既存出力から最新AVIFを1枚選び、ファイル名や画像内容を表示せず再エンコードした。

```text
入力: 1536 x 864, RGB
元ファイル: 約91 KiB
quality: 80
codec: aom
```

| plugin | speed | 時間 | サイズ |
|---|---:|---:|---:|
| 1.4.3 | 6 | 0.156秒 | 90 KiB |
| 1.4.3 | 8 | 0.049秒 | 125 KiB |
| 1.4.3 | 10 | 0.021秒 | 130 KiB |
| 1.5.5 | 6 | 0.149秒 | 90 KiB |
| 1.5.5 | 8 | 0.054秒 | 96 KiB |
| 1.5.5 | 10 | 0.021秒 | 126 KiB |

この画像では、1.5.5への更新だけではspeed 6の時間差は約7msだった。一方、speed 8はspeed 6の約3分の1、speed 10は約7分の1だった。

### 6.3 再現可能な合成ノイズ画像

NumPy seed 42、1024×1024 RGB一様ノイズを使った。

| plugin | codec | speed | 時間 | サイズ |
|---|---|---:|---:|---:|
| 1.4.3 | aom | 6 | 0.110秒 | 859 KiB |
| 1.4.3 | aom | 8 | 0.066秒 | 888 KiB |
| 1.4.3 | aom | 10 | 0.027秒 | 869 KiB |
| 1.4.3 | rav1e | 6 | 0.577秒 | 871 KiB |
| 1.4.3 | svt | 6 | 2.453秒 | 896 KiB |
| 1.5.5 | aom | 6 | 0.122秒 | 860 KiB |
| 1.5.5 | aom | 8 | 0.070秒 | 889 KiB |
| 1.5.5 | aom | 10 | 0.031秒 | 881 KiB |
| 1.5.5 | rav1e | 6 | 0.511秒 | 876 KiB |
| 1.5.5 | svt | 6 | 1.821秒 | 968 KiB |

合成ノイズは通常の生成画像より圧縮しにくく、画質の代表例ではない。ここでもplugin更新よりcodec/speedの差が大きい。

### 6.4 ファイル名走査

`save_images_add_number=true` のため、保存ごとに保存先の全ファイル名を走査して次の連番を探す。最大3293ファイルのディレクトリで測った。

| ファイル数 | `os.listdir` | 連番解析 |
|---:|---:|---:|
| 3293 | 約1.8ms | 約2.8ms |
| 1647 | 約1.8ms | 約2.1ms |
| 1358 | 約0.8ms | 約1.1ms |

現在の規模では連番走査は AVIF encode 約150msより十分小さく、主原因ではない。ただし、ネットワークドライブ、リアルタイムスキャン、数万ファイルのディレクトリでは再評価が必要である。

### 6.5 遅く感じる要因

- AVIF encode が同期であり、1枚ごとに約20～150ms以上ブロックする
- batch内の各画像とgridを順番に保存する
- `before_image_saved` / `image_saved` 拡張コールバックも同じ待ち時間に入る
- `save_txt=true` なら隣接テキストも同期書き込みする
- `export_for_4chan=true` で閾値を超えると、追加resizeとJPEG保存が発生する
- 保存先が低速ディスク、ネットワーク、同期フォルダ、リアルタイムウイルススキャン対象ならディスク側の遅延が加わる
- codecは内部で複数CPU threadを使うため、GPU生成中でもCPU負荷やメモリ帯域が競合し得る

## 7. 推奨する設定追加の完全仕様

この章は将来のコード変更用であり、本調査では適用していない。

### 7.1 追加する設定キー

| キー | UI | 既定値 | 選択肢・範囲 |
|---|---|---:|---|
| `avif_codec` | Dropdown | `auto` | `auto/aom/svt/rav1e` |
| `avif_speed` | Slider | 6 | 0～10、step 1 |
| `avif_subsampling` | Dropdown | `4:2:0` | `4:2:0/4:2:2/4:4:4/4:0:0` |
| `avif_max_threads` | Slider | 0 | 0～64、step 1 |

`0` thread は「single thread」ではなく「plugin/libavifへ上限を指定しない」を意味する。

### 7.2 `modules/shared_options.py` の変更

`options_templates.update(options_section(('saving-images', ...), {` 内で、現在の `jpeg_quality` の直後に次を追加する。

```python
    "jpeg_quality": OptionInfo(
        80,
        "Quality for saved jpeg and avif images",
        gr.Slider,
        {"minimum": 1, "maximum": 100, "step": 1},
    ),
    "avif_codec": OptionInfo(
        "auto",
        "AVIF encoder codec",
        gr.Dropdown,
        {"choices": ("auto", "aom", "svt", "rav1e")},
    ).info("auto normally selects aom; explicit unavailable codecs fail instead of silently falling back"),
    "avif_speed": OptionInfo(
        6,
        "AVIF encoder speed (0 = slowest/best compression, 10 = fastest)",
        gr.Slider,
        {"minimum": 0, "maximum": 10, "step": 1},
    ),
    "avif_subsampling": OptionInfo(
        "4:2:0",
        "AVIF chroma subsampling",
        gr.Dropdown,
        {"choices": ("4:2:0", "4:2:2", "4:4:4", "4:0:0")},
    ),
    "avif_max_threads": OptionInfo(
        0,
        "AVIF maximum encoder threads (0 = automatic)",
        gr.Slider,
        {"minimum": 0, "maximum": 64, "step": 1},
    ),
```

注意:

- 既存の `jpeg_quality` 行を二重に残さない
- `gradio as gr` はこのファイル冒頭ですでに import 済み
- Dropdownは自由入力ではなく固定候補にし、typoを防ぐ
- 既存 `config.json` にキーがなくても OptionInfo の既定値で動く

### 7.3 `modules/images.py` の変更

`save_image_with_geninfo()` の `elif extension.lower() == '.avif':` 分岐で、最後の `image.save(...)` を次に置き換える。

```python
        image.save(
            filename,
            format=image_format,
            quality=opts.jpeg_quality,
            exif=exif_bytes,
            codec=opts.avif_codec,
            speed=opts.avif_speed,
            subsampling=opts.avif_subsampling,
            max_threads=opts.avif_max_threads,
        )
```

他形式の `image.save()` へ AVIF 引数を渡さない。PNG/JPEG/WebP/GIF の挙動を変えないためである。

### 7.4 推奨プリセット例

コードに名前付きpresetを実装する必要はない。Settings値として記載する。

| 目的 | codec | speed | subsampling | max_threads |
|---|---|---:|---|---:|
| 現在互換 | auto | 6 | 4:2:0 | 0 |
| 推奨開始点 | aom | 8 | 4:2:0 | 0 |
| UI待ち最小 | aom | 10 | 4:2:0 | 0 |
| 線画・文字の色保持 | aom | 8 | 4:4:4 | 0 |
| SVT比較 | svt | 8 | 4:2:0 | 0 |
| CPU使用制限 | aom | 8 | 4:2:0 | 4～8 |

qualityは全例で現在値80を起点とする。

## 8. 非同期保存の可否

### 8.1 技術的には可能

AVIF encode はnative codec処理が主体なので、Pythonの `ThreadPoolExecutor` で別threadへ移せる。GPU samplingが終わる前後でCPU encodeを重ねたり、UI requestを先に返したりすること自体は可能である。

ただし、「別threadで実行できる」と「安全に非同期化できる」は同じではない。

### 8.2 単純な非同期化をしてはいけない理由

`save_image()` の中の `_atomically_save_image()` だけを `executor.submit()` に置き換えて即returnすると、次が壊れる。

1. `image.already_saved_as` が指すファイルがまだ存在しない
2. UIが `getmtime()` する時点でファイルがなく、別の一時PNG保存へフォールバックする
3. 返された `fullfn` を直後に開く学習・拡張機能が失敗する
4. `image_saved_callback` を保存前に呼ぶか、別threadで遅れて呼ぶことになる
5. 保存例外が元requestへ届かない
6. 同時に次の連番を計算すると、まだ存在しないqueued fileと同じ名前を選ぶ
7. WebUI終了時にqueued fileが失われる
8. PIL imageやprocessing objectをqueueが保持し、RAM/VRAM解放が遅れる
9. codec自身が全CPU coreを使うため、複数workerでかえって遅くなる可能性がある
10. 同じファイルへ `.tmp` を使うとworker同士が衝突する

### 8.3 安全性優先なら同期のまま

Settings でspeedを6から8へ変えるだけで、今回の実画像では約0.15秒から約0.05秒になった。これは保存契約を一切変えない。

単画像を生成し、UIへ表示すると同時に確実にディスク保存したい場合、最終的には保存完了を待つ必要がある。完全な安全性を保ったまま単画像の見かけ上の待ち時間をゼロにすることはできない。

### 8.4 実験する場合の限定仕様

非同期化を実装するなら、以下をすべて満たす opt-in 機能にする。

- 既定 `avif_async_save=false`
- AVIFだけ対象
- `modules/processing.py` の通常自動保存呼び出しだけが明示的に `async_save=True` を渡す
- 手動 Save、Extras、training、textual inversion、hypernetwork、extensionからの直接呼び出しは同期のまま
- workerは1個
- runningを含む未完了jobは最大2個
- queue満杯時はsubmit側を待たせ、メモリを無制限に増やさない
- enqueue前にファイル名を予約する
- enqueue前に `params.image.copy()` と `dict(params.pnginfo)` を作り、呼び出し側が後で変更しても影響しないようにする
- `before_image_saved_callback` はcaller thread上で同期実行する
- encode、atomic replace、`.txt`、`image_saved_callback` はjob内でこの順に実行する
- 成功するまで `image.already_saved_as` を設定しない
- 失敗時は予約 `.tmp` を削除し、エラーをログと次回flushへ残す
- restart/stop時は新規submitを止め、queueをdrainする

このモードでは `save_image(..., async_save=True)` の返すパスは「予約済みだが、まだ存在しない可能性がある」。この契約はdocstringへ明記し、内部の通常生成以外には使わせない。

## 9. 非同期実装の自己完結仕様

この章は「非同期化まで行う」と別途判断した場合だけ使う。まず第7章までを実装・評価し、必要性が残った場合に進む。

### 9.1 設定

`modules/shared_options.py` のAVIF設定群へ追加:

```python
    "avif_async_save": OptionInfo(
        False,
        "Save automatically generated AVIF images asynchronously (experimental)",
    ).info("manual saves, Extras, and training remain synchronous; queued saves may finish after the UI response"),
```

worker数は設定化しない。AV1 encoder自体がmultithreadなので1固定とする。

### 9.2 新規 `modules/async_image_save.py`

次の責務だけを持つ。画像形式、ファイル命名、EXIF、コールバックの知識は持たせず、callableを有界実行する。

```python
from __future__ import annotations

from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
import threading
from typing import Callable

from modules import errors


class AsyncImageSaveManager:
    def __init__(self, max_pending: int = 2):
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="avif-save",
        )
        self._slots = threading.BoundedSemaphore(max_pending)
        self._lock = threading.Lock()
        self._futures: set[Future] = set()
        self._failures: deque[BaseException] = deque()
        self._accepting = True

    def submit(self, job: Callable[[], None]) -> Future:
        with self._lock:
            if not self._accepting:
                raise RuntimeError("AVIF save queue is shutting down")

        # Bounded backpressure. Includes running and queued work.
        self._slots.acquire()

        try:
            future = self._executor.submit(job)
        except BaseException:
            self._slots.release()
            raise

        with self._lock:
            self._futures.add(future)

        future.add_done_callback(self._done)
        return future

    def _done(self, future: Future) -> None:
        try:
            future.result()
        except BaseException as exc:
            with self._lock:
                self._failures.append(exc)
            errors.report("Asynchronous AVIF save failed", exc_info=True)
        finally:
            with self._lock:
                self._futures.discard(future)
            self._slots.release()

    def raise_failures(self) -> None:
        with self._lock:
            if not self._failures:
                return
            exc = self._failures.popleft()
        raise RuntimeError("A previous asynchronous AVIF save failed") from exc

    def flush(self) -> None:
        while True:
            with self._lock:
                pending = tuple(self._futures)
            if not pending:
                break
            for future in pending:
                # _done records the original exception.
                try:
                    future.result()
                except BaseException:
                    pass
        self.raise_failures()

    def shutdown(self, wait: bool = True) -> None:
        with self._lock:
            self._accepting = False
        if wait:
            self.flush()
        self._executor.shutdown(wait=wait, cancel_futures=not wait)
```

### 9.3 `modules/images.py` へのmanager追加

import群へ:

```python
import atexit
import threading

from modules.async_image_save import AsyncImageSaveManager
```

module scopeへ遅延初期化を追加:

```python
_async_save_manager = None
_async_save_manager_lock = threading.Lock()


def get_async_save_manager():
    global _async_save_manager
    with _async_save_manager_lock:
        if _async_save_manager is None:
            _async_save_manager = AsyncImageSaveManager(max_pending=2)
    return _async_save_manager


def flush_async_image_saves():
    manager = _async_save_manager
    if manager is not None:
        manager.flush()


def shutdown_async_image_saves(wait=True):
    global _async_save_manager
    with _async_save_manager_lock:
        manager = _async_save_manager
        _async_save_manager = None
    if manager is not None:
        manager.shutdown(wait=wait)


atexit.register(shutdown_async_image_saves, True)
```

`save_image()` のsignature末尾へ後方互換のkeyword引数を追加:

```python
def save_image(
    image,
    path,
    basename,
    seed=None,
    prompt=None,
    extension='png',
    info=None,
    short_filename=False,
    no_prompt=False,
    grid=False,
    pnginfo_section_name='parameters',
    p=None,
    existing_info=None,
    forced_filename=None,
    suffix="",
    save_to_dirs=None,
    async_save=False,
):
```

docstringに追加:

```text
async_save:
    Experimental. Only core automatic AVIF saves may set this true.
    The returned filename is reserved, but the file may not exist yet.
```

### 9.4 保存jobへ移す範囲

既存の次の処理はcaller側に残す。

- filename生成
- directory作成
- `ImageSaveParams` 作成
- `before_image_saved_callback`
- callbackが変更したimage/filename/infoの確定

その直後でeligibilityを決める。

```python
    use_async = (
        async_save
        and shared.opts.avif_async_save
        and extension.lower() == ".avif"
        and forced_filename is None
        and opts.save_images_add_number
    )
```

`forced_filename` または連番なしを同期へfallbackするのは、queued job同士の同名競合を避けるためである。

非同期時は次をcaller側で行う。

```python
    image_to_save = params.image.copy()
    pnginfo_to_save = dict(params.pnginfo)
    info_to_save = info
    final_path = params.filename
    final_without_extension, final_extension = os.path.splitext(final_path)
    reserved_temp_path = f"{final_without_extension}.tmp"

    # Reserve the numbered name before another save scans the directory.
    with open(reserved_temp_path, "xb"):
        pass
```

既に `.tmp` があれば次の連番を選び直す必要がある。単純に上書きしてはいけない。実装時には、現在の連番決定から予約までを最大500回の同じloop内へまとめ、`open(..., "xb")` が成功した候補だけ採用する。通常の最終AVIFに加えて予約 `.tmp` も `get_next_sequence_number()` の走査対象になり、先頭の数値が同じ形式なので次の保存は別番号を選べる。

jobは次の順序にする。

```python
    def save_job():
        try:
            save_image_with_geninfo(
                image_to_save,
                info_to_save,
                reserved_temp_path,
                final_extension,
                existing_pnginfo=pnginfo_to_save,
                pnginfo_section_name=pnginfo_section_name,
            )
            os.replace(reserved_temp_path, final_path)

            if opts.save_txt and info_to_save is not None:
                with open(f"{final_without_extension}.txt", "w", encoding="utf8") as file:
                    file.write(f"{info_to_save}\n")

            # File now exists. Use callback params whose values are snapshots.
            saved_params = script_callbacks.ImageSaveParams(
                image_to_save,
                p,
                final_path,
                pnginfo_to_save,
            )
            script_callbacks.image_saved_callback(saved_params)
        except BaseException:
            try:
                if os.path.exists(reserved_temp_path):
                    os.remove(reserved_temp_path)
            except OSError:
                pass
            raise

    get_async_save_manager().raise_failures()
    get_async_save_manager().submit(save_job)
    return final_path, None
```

重要:

- 上記は通常AVIF自動保存用の骨格である
- 現在ある4chan向け追加JPEG処理を非同期対象に含めない。`export_for_4chan` の条件に該当する画像は同期へfallbackさせるのが安全
- async jobが `p` を保持する。queueを2件に制限していても大きなprocessing objectを長時間保持しないかメモリ計測する
- 既存の同期経路はそのまま残し、`use_async=false` なら現在と完全に同じ順序で処理する

### 9.5 `modules/processing.py` の明示的な opt-in

通常サンプルの自動保存呼び出しだけに追加する。

現在:

```python
images.save_image(
    image,
    p.outpath_samples,
    "",
    p.seeds[i],
    p.prompts[i],
    opts.samples_format,
    info=infotext(i),
    p=p,
)
```

変更後:

```python
images.save_image(
    image,
    p.outpath_samples,
    "",
    p.seeds[i],
    p.prompts[i],
    opts.samples_format,
    info=infotext(i),
    p=p,
    async_save=opts.avif_async_save,
)
```

このファイルには同型の処理が2系統あり、調査時点では通常サンプル保存が概ね1094行目と2976行目にある。両方を変更する。

最初は以下を非同期にしない。

- before face restoration
- before color correction
- before highres fix
- mask / mask composite
- grid
- init image

主出力だけで安全性を評価してから対象を広げる。

### 9.6 UI上の見え方

非同期jobがUI画像のserializeより先に終われば、従来どおり最終ファイルを使える。終わっていなければ `modules/ui_tempdir.py` は保存済みAVIFを見つけられず、表示用の一時PNGを同期生成する可能性がある。その場合、AVIF待ちを隠してもPNG encodeが増え、期待ほど速くならない。

この問題を避けるためにUI直前で `flush_async_image_saves()` を呼ぶと安全になるが、単画像では結局AVIF完了を待つため、応答時間改善はほぼ消える。これが非同期化を既定に推奨しない主理由である。

### 9.7 終了・再起動

`atexit` は通常プロセス終了の保険になるが、UI restartではプロセスが残るため明示的にdrainする。

`webui.py::webui_worker()` 内、`server_command == "stop"` の `shared.demo.close()` より前、およびrestartの `shared.demo.close()` より前に次を追加する。

```python
from modules import images

images.shutdown_async_image_saves(wait=True)
```

restart後に次のsaveが走ればmanagerは遅延再作成される。

API-onlyモードの停止経路は `api.launch()` 側に委ねられているため、少なくとも `atexit` を残す。将来API-onlyの明示shutdown hookを追加できる場合も同じ `shutdown_async_image_saves(wait=True)` を呼ぶ。

## 10. テスト仕様

### 10.1 plugin更新

1. WebUI起動時にplugin 1.5.5が導入される
2. Pillowは9.5.0のまま
3. import時にDLL load errorがない
4. `Image.registered_extensions()[".avif"]` がAVIFを返す
5. 既存1.4.3で作成したAVIFを読める
6. 1.5.5で作成したAVIFを一般的なviewerとplugin 1.4.3で読める

### 10.2 設定UI

1. 新規configでは既定値 `auto/6/4:2:0/0`
2. 既存configにキーがなくても起動する
3. Settings保存・再起動後に値が保持される
4. aom/svt/rav1eを切り替えると実際のencodeが成功する
5. wheelにないcodecを選んだ環境では明示エラーになる
6. speed 0、6、8、10の境界
7. max_threads 0、1、64の境界
8. subsampling全候補

### 10.3 画像とメタデータ

最低限、各codecで次を試す。

- RGB 512×512
- RGB 1536×864
- RGBA 512×512
- grayscale
- 生成情報あり/なし
- `enable_pnginfo=true/false`
- quality 1/80/100
- AVIF再読込
- EXIF UserCommentを `piexif` で復元し、元のgeneration infoと一致
- alpha channelが保持される
- `.tmp` が成功後に残らない

### 10.4 WebUI経路

- txt2img 1枚
- txt2img batch 4枚
- img2img 1枚
- hires fix
- ADetailer
- grid PNG
- grid AVIF
- mask / mask composite
- Extras
- UIの手動 Save
- API `save_images=true`
- textual inversion preview
- hypernetwork preview
- sd-dynamic-promptsの隣接CSV
- `on_before_image_saved` が画像・filename・pnginfoを変更する拡張
- `on_image_saved` が保存ファイルを直ちに開く拡張

### 10.5 ファイル命名

- `save_images_add_number=true/false`
- `save_images_replace_action=Replace/Add number suffix`
- 同じseed/promptの連続保存
- `forced_filename`
- 既存最終ファイル
- 既存 `.tmp`
- 100件を連続保存して重複・欠落・残存 `.tmp` がない

### 10.6 非同期専用

- async offで現在と完全に同じ同期順序
- async onでもPNG/JPEG/WebPは同期
- queue 2件を超えるとbackpressureが働く
- workerは常に1個
- encode中に次画像を投入できる
- encoderを意図的に失敗させ、エラーがログと `raise_failures()` に残る
- 失敗後に予約 `.tmp` が消える
- restart時に全jobが完了してからexecutorが閉じる
- stop時に全jobが完了する
- UI応答時に最終AVIFがない場合の一時PNG挙動
- async保存中のRAM増加
- async on/offで総生成時間、UI応答時間、CPU使用率を比較
- 強制終了ではjob喪失があり得ることを仕様として確認

### 10.7 性能測定

同一画像で最低5回、初回をwarm-upとして除き、中央値を記録する。

比較軸:

- plugin 1.4.3 / 1.5.5
- codec auto/aom/svt/rav1e
- speed 6/8/10
- 512×512、1024×1024、1536×864、現在よく使う最大解像度
- encode時間
- UI request全体時間
- file size
- CPU使用率
- peak RAM
- 必要ならSSIMULACRA2等による画質評価

## 11. 採用判断

### plugin 1.5.5

**採用推奨。** Pillowを上げずにcodecライブラリと修正を取り込める。今回のsmoke testでは既存環境との基本互換性が確認できた。ただし、速度向上そのものは限定的である。

### AVIF設定UI

**採用推奨。** `codec` を固定せず `auto/aom/svt/rav1e` から選択可能にし、`speed/subsampling/max_threads` も渡せるようにする。既定値は現在互換にする。

初期推奨値:

```text
quality=80
codec=aom または auto
speed=8
subsampling=4:2:0
max_threads=0
```

画質と容量は実画像で確認し、問題があればspeed 6へ戻す。

### 非同期保存

**現時点では既定実装を非推奨。** 同期契約とUIの既存ファイル利用が強く結びついており、単画像では安全に待つ限り利得が小さい。speed 8/10で先に改善する。

それでも必要なら、第8～9章の限定仕様で実験し、`avif_async_save=false` を既定にする。手動保存や学習へ適用範囲を広げない。

## 12. 参照資料

- [pillow-avif-plugin PyPI](https://pypi.org/project/pillow-avif-plugin/)
- [pillow-avif-plugin GitHub](https://github.com/fdintino/pillow-avif-plugin)
- [pillow-avif-plugin CHANGELOG](https://github.com/fdintino/pillow-avif-plugin/blob/main/CHANGELOG.rst)
- [Pillow AVIF format options](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#avif)
- [Pillow AvifImagePlugin source/documentation](https://pillow.readthedocs.io/en/stable/_modules/PIL/AvifImagePlugin.html)
- [libavif releases](https://github.com/AOMediaCodec/libavif/releases)

