# Stable Diffusion WebUI reForge ExtraNetworks 仮想化実装ガイド

**実装方式:** フロントエンド仮想スクロール (推奨方法A)

---

## 目次

1. [概要](#概要)
2. [現在のコード分析](#現在のコード分析)
3. [実装アーキテクチャ](#実装アーキテクチャ)
4. [詳細実装手順](#詳細実装手順)
5. [テスト戦略](#テスト戦略)

---

## 概要

### 実装方針

JavaScriptで**仮想スクロール（Virtual Scrolling）**機能を実装します。この方式では：

- 全3000個のカード要素をDOMに保持するのではなく
- スクロール可視領域内のカードだけをDOMに動的に生成
- スクロール時に不要なカードをDOMから削除し、新しいカードを追加
- フィルター・ソート機能はメモリ内データに対して実行

### 期待される効果

| メトリクス | 現在 | 最適化後 | 改善 |
|-----------|------|---------|------|
| 初期DOM要素数 | 3000+ | 50-100 | **30-60倍削減** |
| 初期レンダリング時間 | 10秒+ | 0.5秒 | **20倍高速化** |
| メモリ使用量 | 100+ MB | 20-30 MB | **3-5倍削減** |
| スクロール滑らかさ | 10-20 FPS | 60+ FPS | **3-6倍向上** |

---

## 現在のコード分析

### 問題点の詳細

#### 1. extraNetworks.js の applyFilter() 関数

**現在のコード (行49-69):**

```javascript
var applyFilter = function(force) {
    var searchTerm = search.value.toLowerCase();

    // ❌ 問題1: 全3000カード要素をループ
    gradioApp().querySelectorAll('#' + tabname + '_extra_tabs div.card')
        .forEach(function(elem) {

        // ❌ 問題2: 各カード内の全テキストを抽出（重い）
        var text = Array.prototype.map.call(
            elem.querySelectorAll('.search_terms, .description'),
            function(t) { return t.textContent.toLowerCase(); }
        ).join(" ");

        var visible = text.indexOf(searchTerm) != -1;

        // ❌ 問題3: クラス切り替えで再レイアウト
        if (visible) {
            elem.classList.remove("hidden");
        } else {
            elem.classList.add("hidden");
        }
    });

    applySort(force);
};
```

**パフォーマンスの問題:**
- O(n) の複雑性で n=3000
- 毎回ユーザーが文字を入力するたびに実行
- DOM操作による再レイアウト（reflow）発生

#### 2. extraNetworks.js の applySort() 関数

**現在のコード (行71-105):**

```javascript
var applySort = function(force) {
    var cards = gradioApp().querySelectorAll('#' + tabname_full + ' div.card');
    var parent = gradioApp().querySelector('#' + tabname_full + "_cards");

    // ❌ 問題1: 全3000要素をJavaScriptメモリに読み込み
    var sortedCards = Array.from(cards);

    // ❌ 問題2: 全要素のソート計算
    sortedCards.sort(function(cardA, cardB) {
        var a = cardA.dataset[sortKeyDataField];
        var b = cardB.dataset[sortKeyDataField];
        if (!isNaN(a) && !isNaN(b)) {
            return parseInt(a) - parseInt(b);
        }
        return (a < b ? -1 : (a > b ? 1 : 0));
    });

    if (reverse) {
        sortedCards.reverse();
    }

    // ❌ 問題3: DOM全削除と再構成
    parent.innerHTML = '';
    var frag = document.createDocumentFragment();
    sortedCards.forEach(function(card) {
        frag.appendChild(card);
    });
    parent.appendChild(frag);
};
```

**パフォーマンスの問題:**
- DOM操作による大規模な再レイアウト
- 全アイテムを一度にメモリに読み込み
- アニメーション/トランジション不可

#### 3. HTMLテンプレート構造

**現在 (extra-networks-pane.html):**

```html
<div id='{tabname}_{extra_networks_tabname}_pane'
     class='extra-network-pane'>
    <!-- コントロール -->
    <div class="extra-network-control">...</div>

    <!-- ❌ ここに3000個全てのカード -->
    <div id="{tabname}_{extra_networks_tabname}_cards">
        <!-- 全カード要素が直接配置 -->
        <div class="card">...</div>
        <div class="card">...</div>
        ...
        <div class="card">...</div>  <!-- 3000番目 -->
    </div>
</div>
```

---

## 実装アーキテクチャ

### データレイヤー

```javascript
// allCardsData: フィルター・ソート前の全データ
// filteredCardsData: フィルター後のデータ
// sortedCardsData: ソート後のデータ

window.extraNetworksState = {
    [tabname_full]: {
        allCards: [],           // 全カードメタデータ
        filteredCards: [],      // フィルター後
        sortedCards: [],        // ソート後
        searchTerm: '',
        sortKey: 'default',
        sortDir: 'Ascending',
        virtualList: null,      // VirtualScroller インスタンス
    }
};
```

### 描画レイヤー

```
scrollイベント
    ↓
VirtualScroller.onScroll()
    ↓
calculateVisibleRange() [開始行, 終了行を計算]
    ↓
renderVisibleItems() [DOMに追加するアイテムを抽出]
    ↓
updateDOM() [DOMを更新]
```

### イベントフロー

```
ユーザー入力 (search, sort, filter)
    ↓
applyFilter() / applySort()
    ↓
メモリ内データ更新 (filteredCards, sortedCards)
    ↓
virtualList.setItems(sortedCards)
    ↓
VirtualScroller がスクロール位置を基に再計算
    ↓
DOMが更新される
```

---

## 詳細実装手順

### ステップ1: 新しいJavaScriptファイルの作成

**ファイル:** `javascript/virtual-scroll.js`

```javascript
/**
 * VirtualScroller: 大量のアイテムを効率的に表示する仮想スクロール実装
 */

class VirtualScroller {
    constructor(options) {
        this.container = options.container;           // スクロールコンテナ
        this.items = options.items || [];             // 全アイテムデータ
        this.itemHeight = options.itemHeight || 200;  // アイテムの固定高さ
        this.buffer = options.buffer || 5;            // スクロール時の追加バッファ行数
        this.renderItem = options.renderItem;         // アイテム描画関数

        this.scrollTop = 0;
        this.containerHeight = 0;
        this.visibleStartIndex = 0;
        this.visibleEndIndex = 0;
        this.itemsContainer = null;
        this.scrollListener = null;

        this.init();
    }

    init() {
        // スクロールコンテナのセットアップ
        this.container.style.overflow = 'auto';
        this.container.style.height = this.container.style.height || '600px';

        // アイテムコンテナの作成
        this.itemsContainer = document.createElement('div');
        this.itemsContainer.className = 'virtual-items-container';
        this.container.appendChild(this.itemsContainer);

        // スクロールリスナー
        this.scrollListener = this.onScroll.bind(this);
        this.container.addEventListener('scroll', this.scrollListener);

        // 初期レンダリング
        this.updateVisibleRange();
        this.render();
    }

    setItems(items) {
        /**
         * アイテムリストを更新
         * 通常、フィルター・ソート後に呼ばれる
         */
        this.items = items || [];

        // スクロール位置をリセット
        this.container.scrollTop = 0;
        this.scrollTop = 0;

        // 仮想リストの高さを再計算
        this.updateContainerHeight();

        // 再レンダリング
        this.updateVisibleRange();
        this.render();
    }

    updateContainerHeight() {
        /**
         * 仮想リストコンテナの高さを設定
         * この高さでスクロールバーのサイズが決まる
         */
        const totalHeight = this.items.length * this.itemHeight;
        this.itemsContainer.style.height = totalHeight + 'px';
    }

    updateVisibleRange() {
        /**
         * スクロール位置から表示されるべきアイテムの範囲を計算
         */
        this.scrollTop = this.container.scrollTop;
        this.containerHeight = this.container.clientHeight;

        // バッファを含む開始・終了インデックスを計算
        this.visibleStartIndex = Math.max(
            0,
            Math.floor(this.scrollTop / this.itemHeight) - this.buffer
        );

        this.visibleEndIndex = Math.min(
            this.items.length,
            Math.ceil((this.scrollTop + this.containerHeight) / this.itemHeight) + this.buffer
        );
    }

    render() {
        /**
         * 見える範囲のアイテムだけをDOMに追加
         */
        const fragment = document.createDocumentFragment();
        const offsetTop = this.visibleStartIndex * this.itemHeight;

        // オフセットコンテナを作成（スクロール時の位置合わせ用）
        const offsetDiv = document.createElement('div');
        offsetDiv.style.transform = `translateY(${offsetTop}px)`;
        offsetDiv.className = 'virtual-items-offset';

        // 見える範囲のアイテムをレンダリング
        for (let i = this.visibleStartIndex; i < this.visibleEndIndex; i++) {
            const item = this.items[i];
            if (item) {
                const itemElement = this.renderItem(item, i);
                offsetDiv.appendChild(itemElement);
            }
        }

        // DOMを更新
        this.itemsContainer.innerHTML = '';
        this.itemsContainer.appendChild(offsetDiv);
    }

    onScroll() {
        /**
         * スクロールイベントハンドラ
         * 効率的に再描画するため、範囲が変わった時だけ実行
         */
        const previousStartIndex = this.visibleStartIndex;

        this.updateVisibleRange();

        // 範囲が変わった場合だけ再描画
        if (this.visibleStartIndex !== previousStartIndex) {
            this.render();
        }
    }

    destroy() {
        /**
         * クリーンアップ
         */
        if (this.scrollListener) {
            this.container.removeEventListener('scroll', this.scrollListener);
        }
        this.itemsContainer.innerHTML = '';
    }
}
```

### ステップ2: extraNetworks.js の修正

**ファイル:** `javascript/extraNetworks.js`

**修正1: グローバル変数の追加 (行186-188付近)**

```javascript
// 既存コード
var extraNetworksApplyFilter = {};
var extraNetworksApplySort = {};
var activePromptTextarea = {};

// 追加
var extraNetworksVirtualScrollers = {};  // VirtualScroller インスタンス
var extraNetworksCardData = {};          // カードのメタデータキャッシュ
```

**修正2: setupExtraNetworksForTab() 関数の主要部分を置き換え**

以下のコードを検索して置き換えます：

```javascript
// 削除対象：行49-115（applyFilter, applySort の古い実装）

// 追加する新しい実装：
        var filterData = {};
        var applyFilter = function(force) {
            var searchTerm = search.value.toLowerCase();

            // ❌ 新しい方式: DOMではなくデータをフィルター
            filterData.searchTerm = searchTerm;

            var filtered = extraNetworksCardData[tabname_full].filter(function(card) {
                if (!searchTerm) return true;

                // 検索対象のテキストを結合
                var searchText = (
                    (card.name || '') + ' ' +
                    (card.description || '') + ' ' +
                    (card.search_terms || '')
                ).toLowerCase();

                return searchText.indexOf(searchTerm) !== -1;
            });

            // フィルター結果でVirtualScrollerを更新
            var virtualScroller = extraNetworksVirtualScrollers[tabname_full];
            if (virtualScroller) {
                virtualScroller.setItems(filtered);
            }

            applySort(force);
        };

        var applySort = function(force) {
            var virtualScroller = extraNetworksVirtualScrollers[tabname_full];
            if (!virtualScroller) return;

            var items = virtualScroller.items;
            var activeSearchElem = gradioApp()
                .querySelector('#' + tabname_full + "_controls .extra-network-control--sort.extra-network-control--enabled");
            var sortKey = activeSearchElem ? activeSearchElem.dataset.sortkey : "default";
            var sortKeyDataField = "sort" + sortKey.charAt(0).toUpperCase() + sortKey.slice(1);
            var reverse = sort_dir.dataset.sortdir == "Descending";

            // データレベルでソート（DOM操作ではなく）
            var sortedItems = items.slice().sort(function(itemA, itemB) {
                var a = itemA[sortKeyDataField] || itemA['sort' + sortKey];
                var b = itemB[sortKeyDataField] || itemB['sort' + sortKey];

                if (!isNaN(a) && !isNaN(b)) {
                    return parseInt(a) - parseInt(b);
                }
                return (a < b ? -1 : (a > b ? 1 : 0));
            });

            if (reverse) {
                sortedItems.reverse();
            }

            // ソート結果をVirtualScrollerに渡す
            virtualScroller.setItems(sortedItems);
        };
```

### ステップ3: VirtualScroller インスタンスの作成

**ファイル:** `javascript/extraNetworks.js`

**修正3: VirtualScroller の初期化 (setupExtraNetworksForTab 内)**

```javascript
        // VirtualScroller の初期化
        function initializeVirtualScroller(tabname_full, cardElements) {
            // カードのメタデータを抽出
            var cardsMetadata = Array.from(cardElements).map(function(cardElem) {
                return {
                    element: cardElem,
                    name: cardElem.dataset.name || '',
                    sortDefault: cardElem.dataset.sortDefault || '',
                    sortName: cardElem.dataset.sortName || '',
                    sortPath: cardElem.dataset.sortPath || '',
                    sortDate_created: cardElem.dataset.sortDate_created || '',
                    sortDate_modified: cardElem.dataset.sortDate_modified || '',
                    search_terms: cardElem.querySelector('.search_terms')?.textContent || '',
                    description: cardElem.querySelector('.description')?.textContent || '',
                };
            });

            // カードデータをキャッシュ
            extraNetworksCardData[tabname_full] = cardsMetadata;

            // VirtualScroller を作成
            var cardsContainer = gradioApp()
                .querySelector('#' + tabname_full + '_cards');

            var virtualScroller = new VirtualScroller({
                container: cardsContainer,
                items: cardsMetadata,
                itemHeight: 250,  // カードの高さ（CSSの値と合わせる）
                buffer: 3,        // 上下3行分バッファ
                renderItem: function(item, index) {
                    // カード要素をクローンして返す
                    var clone = item.element.cloneNode(true);
                    return clone;
                }
            });

            extraNetworksVirtualScrollers[tabname_full] = virtualScroller;
        }

        // 初期化を実行
        var cardElements = gradioApp()
            .querySelectorAll('#' + tabname_full + ' div.card');
        if (cardElements.length > 0) {
            // 元のカード要素を隠す
            cardElements.forEach(function(elem) {
                elem.style.display = 'none';
            });

            initializeVirtualScroller(tabname_full, cardElements);
        }
```

### ステップ4: HTMLテンプレートの最小限の修正

**ファイル:** `html/extra-networks-pane.html`

**修正: スクロールコンテナのスタイル追加 (行81)**

```html
<div id='{tabname}_{extra_networks_tabname}_cards'
     style="height: 600px; overflow-y: auto; border: 1px solid #ccc;">
</div>
```

**またはCSSで:**

```css
#txt2img_lora_cards,
#img2img_lora_cards,
/* その他のページ */
{
    height: 600px;
    overflow-y: auto;
    border: 1px solid var(--border-color-primary);
}
```

---

## テスト戦略

### ステップ1: 単体テスト

**テスト項目:**

1. **VirtualScroller の機本機能**
   ```javascript
   // テストケース
   test('VirtualScroller renders visible items only', () => {
       const items = Array.from({length: 1000}, (_, i) => ({id: i, name: `Item ${i}`}));
       const vs = new VirtualScroller({...});
       expect(vs.itemsContainer.children.length).toBeLessThan(50);  // バッファ含む
   });
   ```

2. **フィルター動作**
   ```javascript
   test('applyFilter updates virtual list correctly', () => {
       search.value = 'test';
       applyFilter();
       // virtualScroller.items が正しくフィルターされていることを確認
   });
   ```

3. **ソート動作**
   ```javascript
   test('applySort sorts items correctly', () => {
       applySort();
       // items が正しくソートされていることを確認
   });
   ```

### ステップ2: インテグレーションテスト

**テスト環境:**

1. **ダミーLoRA作成**
   ```bash
   # テスト用に3000個のダミーファイルを作成
   for i in {1..3000}; do
       touch "models/Lora/test_lora_${i}.safetensors"
   done
   ```

2. **ブラウザテスト**
   - txt2img/img2img タブで LoRA ページを開く
   - スクロール動作確認
   - 検索フィルター動作確認
   - ソート動作確認
   - カード選択動作確認

### ステップ3: パフォーマンステスト

**計測方法:**

```javascript
// ブラウザ DevTools Console で実行

// 初期読み込み時間
console.time('Initial Load');
// ページロード
console.timeEnd('Initial Load');

// スクロール性能（FPS）
// DevTools > Performance タブで Profile

// メモリ使用量
// DevTools > Memory タブで Snapshot

// ソート性能
console.time('Sort');
applySort();
console.timeEnd('Sort');

// フィルター性能
console.time('Filter');
search.value = 'test';
applyFilter();
console.timeEnd('Filter');
```

**期待値:**

| テスト項目 | 期待値 |
|-----------|--------|
| 初期ロード | < 1秒 |
| スクロール | 60+ FPS |
| フィルター | < 50ms |
| ソート | < 100ms |
| メモリ | < 50MB |

---

## デバッグ方法

### VirtualScroller デバッグ

```javascript
// VirtualScroller インスタンスにデバッグメソッドを追加

VirtualScroller.prototype.debug = function() {
    console.log('VirtualScroller Debug Info:');
    console.log('  Total Items:', this.items.length);
    console.log('  Visible Range:', this.visibleStartIndex, '-', this.visibleEndIndex);
    console.log('  Visible Count:', this.visibleEndIndex - this.visibleStartIndex);
    console.log('  Container Height:', this.containerHeight);
    console.log('  Scroll Top:', this.scrollTop);
    console.log('  DOM Elements:', this.itemsContainer.querySelectorAll('.card').length);
};

// 使用方法
extraNetworksVirtualScrollers['txt2img_lora'].debug();
```

### パフォーマンスプロファイリング

```javascript
// Chrome DevTools で Profiling

// 1. DevTools を開く (F12)
// 2. Performance タブ
// 3. Record button を押す
// 4. スクロール/フィルター実行
// 5. Stop button を押す
// 6. Main thread フレーム分析

// 見るべきポイント:
// - Rendering セクションのサイズ
// - Scripting セクションの実行時間
// - Layout thrashing の有無
```

---

## 互換性考慮事項

### ブラウザ互換性

| ブラウザ | 対応 | 備考 |
|---------|------|------|
| Chrome | ✅ | ES6対応 |
| Firefox | ✅ | ES6対応 |
| Safari | ✅ | ES6対応 |
| Edge | ✅ | ES6対応 |
| IE11 | ❌ | Gradioが対応していないため不要 |

### Gradio 互換性

- VirtualScroller はGradioコンポーネントの外で独立して動作
- Gradio の更新で影響なし
- HTML変更は最小限

### 既存拡張機能への影響

- JavaScriptコンビニ追加のみ
- Pythonコード変更なし
- 既存拡張の動作に影響なし

---

## トラブルシューティング

### 問題1: スクロール時にカードが空白になる

**原因:** `itemHeight` が実際のカード高さと異なる

**解決:**
```javascript
// CSSで実際の高さを確認
const cardHeight = window.getComputedStyle(
    document.querySelector('.card')
).height;
console.log('Actual card height:', cardHeight);

// VirtualScroller 初期化時に調整
itemHeight: parseInt(cardHeight)
```

### 問題2: フィルター後にスクロール位置がおかしい

**原因:** フィルター後、スクロール位置がリセットされていない

**解決:**
```javascript
// setItems() メソッド内でスクロール位置をリセット
this.container.scrollTop = 0;
```

### 問題3: メモリリーク

**原因:** destroy() メソッドが呼ばれていない

**解決:**
```javascript
// ページ遷移時にクリーンアップ
function cleanup() {
    Object.values(extraNetworksVirtualScrollers).forEach(vs => vs.destroy());
    extraNetworksVirtualScrollers = {};
    extraNetworksCardData = {};
}
```

---

## 今後の最適化案

### フェーズ2 以降

1. **Pythonバックエンド ペーション**
   - 最初は100個だけ取得
   - スクロール時に追加取得
   - ネットワーク往復を最適化

2. **画像遅延読み込みの最適化**
   - 見える範囲の画像だけ読み込み
   - `IntersectionObserver` 活用

3. **キャッシング戦略**
   - フィルター結果をメモリキャッシュ
   - ソート結果をメモリキャッシュ

4. **IndexedDB 活用**
   - メタデータをローカルキャッシュ
   - 初期ロード高速化

---

**実装ガイド終了**

