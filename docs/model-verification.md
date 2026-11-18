# モデル固定・P0検証記録

確認日: 2026-11-18。対象は設計書指定の2モデル、実行形式は q8 / CPU WASM。

## 取得物

| 論理名 | ONNX配布元 | 固定コミット | 実取得量 | 元モデルのパラメータ数 |
| --- | --- | --- | ---: | ---: |
| `toEnglish` | `Xenova/opus-mt-mul-en` | `72a05e47cee89c718a9db4dc70d02fef3bc39de8` | 118,351,797 bytes (112.87 MiB) | 77,518,848 |
| `fromEnglish` | `Xenova/opus-mt-en-mul` | `e57f9759f8e1e9ed97067bfc11e53e1eab63e57e` | 118,280,580 bytes (112.80 MiB) | 77,487,104 |

両方の取得量は合計236,632,377 bytes (225.67 MiB)。アプリ本体・WASMランタイム・ブラウザの管理領域は別途必要。ロード時のRAM量を表す数値ではない。

必要ファイルだけを実際に取得し、各ファイルのバイト数とSHA-256を計算した。さらに、固定コミットのHugging Face APIが返すLFS SHA-256、または通常ファイルのGit blob SHA-1と照合した。全14ファイルの固定値は [`model-manifest.json`](../packages/model-manager/src/model-manifest.json) を参照する。`main`を実行時に解決しない。

各モデルに含めたのは次の7ファイル。

- `config.json`
- `generation_config.json`
- `tokenizer.json`
- `tokenizer_config.json`
- `special_tokens_map.json`
- `onnx/encoder_model_quantized.onnx`
- `onnx/decoder_model_merged_quantized.onnx`

SentencePieceの元ファイル、FP32、q4、非merged decoder、過去状態専用decoderなどは取得対象に含めない。Transformers.jsが必要ファイル以外を要求した場合は、許可されていない取得へフォールバックせずエラーにする。

## 0.4B制約の確認方法

サイズを4で割る推定は使用していない。元PyTorchチェックポイントのtensorメタデータを読み、実際の各テンソルのshapeの積を合計した。共有パラメータはstorage ID・offset・shape・strideの一致で一度だけ数え、bufferの`final_logits_bias`を除いた。固定位置埋め込みなど、学習対象外でもモデルparameterとして登録される重みは含む。

| 元チェックポイント | 固定コミット | state tensors | 重複除外後のparameter tensors | 除外buffer要素数 |
| --- | --- | ---: | ---: | ---: |
| `Helsinki-NLP/opus-mt-mul-en` | `848eae0c1676cfce9bb791c200e8228e5a6396ff` | 258 | 255 | 64,172 |
| `Helsinki-NLP/opus-mt-en-mul` | `07ab277b060b29b7208dc0a198327eeeea92224d` | 258 | 255 | 64,110 |

両方とも次の3キーは同じstorageの共有embeddingであり、三重計上していない。

- `model.shared.weight`
- `model.encoder.embed_tokens.weight`
- `model.decoder.embed_tokens.weight`

legacy形式のチェックポイントでは先頭128 KiB以内に全tensorのメタデータが収まる。重み本体は読み込まず、Python標準ライブラリの制限付きUnpicklerで`OrderedDict`と無害なtensor metadataコンストラクタのみを許可した。任意のcheckpointコードやPyTorchのデシリアライザを実行していない。

読み取り範囲のSHA-256:

| モデル | 先頭131,072 bytesのSHA-256 |
| --- | --- |
| mul-en | `3f32538e5027a0b0d83fe697149643348cf62155556c368e533b6f944fcd66a5` |
| en-mul | `983ae7e6e2e30d4bc2d40962fcffac96bcc1c8b02f89c894c51e1647483750b7` |

この方法で各モデルが400,000,000要素以下であることを確認した。ただし、設計書に例示されたPyTorchモデルをinstantiateして`sum(p.numel())`を呼ぶ手順そのものは未実施であり、チェックポイントの実shapeから共有・bufferを区別する代替検証である。量子化しても元モデルのパラメータ数は減らない。

## 言語指定

固定済み`fromEnglish`の`tokenizer.json`には以下の制御トークンが存在する。

| 宛先 | prefix | vocabulary ID |
| --- | --- | ---: |
| 日本語 | `>>jpn<<` | 836 |
| ロシア語 | `>>rus<<` | 905 |

これらは`added_tokens`ではなくUnigram vocabulary内の要素。Transformers.js 3.8.1の`MarianTokenizer._encode_text`は文頭の言語prefixを取り除いて本文をtokenizeした後、制御トークンを先頭に追加する。[固定バージョンの実装](https://github.com/huggingface/transformers.js/blob/3.8.1/src/tokenizers.js) と [元モデルカード](https://huggingface.co/Helsinki-NLP/opus-mt-en-mul/blob/07ab277b060b29b7208dc0a198327eeeea92224d/README.md) を確認した。

vocabularyへの存在とライブラリの処理確認だけでは、実際の目的言語出力の品質を保証しない。デスクトップChromeでの6方向の実推論とオフライン再起動の結果は下記に記録した。iPhone・Android実機、推論ピークRAM、母語話者による品質評価は未確認。

## ブラウザ実推論・オフライン検証

2026-11-18、Chrome `157.0.8103.79`、Darwin `25.6.0`、arm64、システムメモリ16 GiBで実施。CPU WASM、q8、1スレッド、`num_beams: 1`、入力最大192トークン、出力最大256新規トークンの条件。

[`tests/models/real-models.spec.ts`](../tests/models/real-models.spec.ts) は **1 passed (47.8秒)**。翻訳そのものは実際のONNXモデルをWeb Worker内で実行し、mock出力を使用していない。

- 本物のモデル取得処理を通し、全14ファイルのSHA-256をブラウザ内で検証して保存した。
- 最初の推論後にWorkerを終了し、通信遮断状態の新しいWorkerで6方向各10文、合計60文を実行した。処理失敗・空出力・期待文字体系との不一致は0件だった。
- オフラインでアプリ画面を開き直し、さらに文書・Workerの再起動後にも保存済みモデルで推論できた。
- モデル削除後は不足エラーで拒否し、再取得して利用可能状態へ戻せた。
- 推論中・オフライン再起動中の外部リクエストは0件。初回取得14件と再取得7件はすべて固定manifestのURLへのGETで、リクエスト本文は0件だった。

この自動テストでは、モデル取得URLへの応答をPlaywrightでローカルの実取得済みファイルに置き換えた。実インストーラ・ハッシュ・キャッシュ・推論・Workerは本物だが、ブラウザから配布元への全ファイル直接ダウンロード試験とは区別する。同じ開発セッションで別途、両モデルの固定`config.json`とq8 encoderに対する`Range: bytes=0-1023`の直接取得4件が、実Chromeから`206`、`type: cors`で成功した。重みのリダイレクト先は`us.aws.cdn.hf.co`だった。

比較用の追跡対象baselineは [`model-evaluation.json`](model-evaluation.json)。実際の60件の入力・出力・中間英語・所要時間、固定モデルrevision、実行環境、診断結果、外部リクエスト件数を保持する。生のPlaywright reportとtraceは`test-results/models/`に生成される。

### 参考性能値

| 方向 | 件数 | p50 | p95 |
| --- | ---: | ---: | ---: |
| ja → en | 10 | 226.10 ms | 1,172.70 ms |
| ru → en | 10 | 174.10 ms | 458.30 ms |
| en → ja | 10 | 285.15 ms | 922.70 ms |
| en → ru | 10 | 286.35 ms | 693.10 ms |
| ja → ru | 10 | 1,082.50 ms | 2,118.40 ms |
| ru → ja | 10 | 1,107.75 ms | 1,737.00 ms |

初回モデルロードと「こんにちは。」の推論の合計は1,111.90 ms。表の値は入力長が異なる各10文の**モデルロードと推論が混在した参考値**であり、100文字固定・ロード済みモデルのみという性能目標の正式測定ではない。p50は中央値、p95はnearest-rankであり、10件では最大値となる。端末RAMのピーク値、スマホ速度、ブラウザ再起動や端末再起動後の保存維持は未測定。

### 品質ゲートは未達

**実行・オフライン検証の成功は意味品質の合格を表さない。P0の「重大な崩壊がない」という品質ゲートは未達で、全方向を実験的対応とする。** 自動診断は主に文字体系の存在確認であり、正しい言語・自然さ・意味保存を証明しない。keyword一致も品質スコアとして使用しない。

実際のbaselineには次の重大な誤りがある。

| ID | 原文 | 実際の出力 | 問題 |
| --- | --- | --- | --- |
| `ja-en-01` | おはようございます。今日はいい天気ですね。 | `I'm glad you did.` | 原文にない意味を生成し、挨拶と天気の情報を欠落 |
| `ja-en-02` | 明日、一緒に公園へ行きませんか。 | `Tomorrow, we're not going to the park together.` | 勧誘を否定の断定に変更 |
| `ru-en-01` | Доброе утро. Сегодня хорошая погода. | `Good morning.` | 天気に関する文を欠落 |
| `ja-ru-02` | 明日、一緒に公園へ行きませんか。 | `Завтра мы не пойдем в парк.` | 中間英訳の否定への意味変更が最終訳にも伝播 |

日本語の否定疑問・勧誘の扱いと、複数文の欠落は優先改善項目。英語経由では一段目の誤りがそのまま伝わる。英語→日本語にも表記混在、英語→ロシア語にも文法・語形の誤りが見られ、正式な品質合格には母語話者の確認と同一セットでの改善比較が必要。

ブラウザconsoleにはMarianTokenizerのfast tokenizer非対応警告44件と、`>>rus<<`をunsupportedとする警告46件があった。固定バージョンのconstructorがglobal正規表現の`.test()`をfilterで使用するため、supported-language一覧が不完全になる実装上の問題がある。今回、prefixの語彙IDは実際に使用されロシア語文字の出力は得られたが、互換性警告と翻訳誤りは継続評価が必要。期待したモデル不足エラーのconsole出力1件とresource 404のconsole出力1件もbaselineに集計しており、ページの未処理例外は0件だった。

現実装はgreedy生成を使う。Transformers.js 3.8.1のbeam search対応状況を確認せずに`num_beams`だけを増やしても品質改善とは扱わない。モデル・tokenizer・生成条件を変更する場合は、このbaselineの60文で退行を比較する。

## ライセンス

元2モデルのモデルカードはApache-2.0を宣言している。各manifestの`licenseUrl`は元モデルカードの固定コミットを指す。ONNX版のカードも対応する元モデルを明示している。

- [元 mul-en](https://huggingface.co/Helsinki-NLP/opus-mt-mul-en/blob/848eae0c1676cfce9bb791c200e8228e5a6396ff/README.md)
- [元 en-mul](https://huggingface.co/Helsinki-NLP/opus-mt-en-mul/blob/07ab277b060b29b7208dc0a198327eeeea92224d/README.md)
- [ONNX mul-en](https://huggingface.co/Xenova/opus-mt-mul-en/blob/72a05e47cee89c718a9db4dc70d02fef3bc39de8/README.md)
- [ONNX en-mul](https://huggingface.co/Xenova/opus-mt-en-mul/blob/e57f9759f8e1e9ed97067bfc11e53e1eab63e57e/README.md)

## 再現

Python 3.9以降、標準ライブラリのみで実行できる。

```sh
python3 scripts/verify-models.py
```

初回は必要ファイルを`.model-audit/`に取得する。以降はローカル実体を再ハッシュし、固定コミットの配布元metadataと、追跡対象manifestの値に一致することを確認する。checkpointのshape集計結果は`.model-audit/Helsinki-NLP/<model>/<revision>/parameter-count.json`にも出力する。

モデルの意図的な更新時だけ、script内の固定コミットを変更して内容を確認した上で以下を使う。通常検証ではmanifestを書き換えない。

```sh
python3 scripts/verify-models.py --update-manifest
```
