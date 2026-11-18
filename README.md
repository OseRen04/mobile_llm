# Local Translator

日本語・英語・ロシア語の全6方向を、ブラウザの Web Worker / WASM で翻訳する実験的なPWAとChrome拡張です。翻訳API・アカウント・アクセス解析はありません。日露間は英語を経由します。

## 起動

Node.js 22.16以降を使用します。

```sh
npm ci
npm run dev
```

この作業環境ではNode.jsをプロジェクト内の `.tools/` に用意しています。ターミナルのPATHにNode.jsがない場合も、次で起動できます。

```sh
./dev.sh
```

表示されたlocalhostのURLを開きます。実モデルはアプリに同梱せず、画面で容量を確認してから取得します。各約118MB、2モデル合計236,632,377 bytes（約225.7MiB）で、WASMとアプリ本体は別です。初回は通信と相応の空きメモリ・保存容量が必要です。

## 本番ビルドとオフライン

```sh
npm run build
npm run preview
```

PWAは `dist/web/`、Chrome拡張は `dist/extension/` に出力します。静的ホストではPWAをHTTPSで配信してください。サブディレクトリへの配置も可能です。`_headers` 対応ホストでは付属のCSP等が適用されます。別のホストでは同内容をホスト側に設定してください。開発サーバーではService Workerを登録しません。オフライン確認には本番ビルドのpreviewを使います。

拡張のZIPを作る場合は `python3 scripts/package-extension.py` を実行します。`dist/local-translator-extension.zip` が生成されます。

初回にアプリのファイルが保存されるまで待ち、使用するモデルを取得してください。取得したモデルの全必須ファイルを確認してから保存済みと表示します。推論中のモデルのリモート取得は無効です。必要なモデルが欠けていれば原文と前回の完成結果を保持してエラーを表示します。

ブラウザはストレージを削除することがあり、スマホではバックグラウンドの処理が停止することもあります。実機のiPhone・Androidでの性能・メモリ評価は未完了です。常時オフライン動作、翻訳品質、速度を保証していません。モデルはすべて「実験的対応」として表示します。

## Chrome拡張

1. `npm run build:extension` を実行する。
2. PC Chromeの `chrome://extensions` でデベロッパーモードを有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/extension/` を選ぶ。
4. 対象ページの入力欄にカーソルを置き、拡張機能の「入力欄を読み取る」を押す。
5. 翻訳後に「確認して入力欄へ置換」を押し、原文と訳文を確認する。

通常のtext/search入力欄・textarea・単純なcontenteditableを対象にします。選択範囲がある場合は選択部分だけを置換します。原文・選択範囲・ページが変わった場合は置換しません。パスワード・決済・秘密情報の欄、複雑なエディタ、iframe、Shadow DOM等は対象外です。操作できない場合は訳文をコピーして使います。送信操作は行いません。権限は `activeTab` と `scripting` のみです。

スマホ版ChromeにPC用拡張機能は導入できません。スマホではPWAを使用します。PWAから他サイト・他アプリの入力欄を直接変更することはできません。PWAと拡張のモデル保存領域は別です。Chrome Web Storeへの公開・審査は未実施です。

## プライバシー・資産の検証

- 文章はページを閉じるまでのメモリにだけ保持します。保存する設定は言語コードだけです。
- モデル取得は固定revision・固定ファイル名のGETのみです。翻訳する文章は取得リクエストに含めません。
- 保存前に実サイズとSHA-256を確認します。途中取得は利用可能扱いにしません。
- 推論Workerは `allowRemoteModels = false` と `local_files_only = true` を使用し、検証済みキャッシュからのみモデルを読みます。
- WASMの実行コードは同一オリジン／拡張パッケージに含めます。外部CDNから実行コードを取得しません。
- キャンセルはWorkerを終了して演算を止め、古いrequestIdの結果を破棄します。
- 2段階翻訳では1段目を解放してから2段目をロードし、中間英語もトークン数を測って再分割します。

モデルmanifestは `packages/model-manager/src/model-manifest.json` にあります。実パラメータ数は77,518,848と77,487,104です。チェックポイントのtensor shapeから共有重みとbufferを区別して集計しました。検証方法と制限は [モデル検証記録](docs/model-verification.md) を参照してください。

```sh
npm run verify:models
```

この検証はモデル約237MBを `.model-audit/` に取得します。配布元への通信が発生します。通常のビルドと単体テストはモデルを取得しません。

## 検証コマンド

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:extension
```

ローカルのPlaywrightはインストール済みGoogle Chromeを使います。CIはChromiumをインストールします。

拡張機能のsuiteはPlaywrightのChromium（Chrome for Testing）を使用します。未取得なら `npx playwright install chromium` を先に実行してください。テスト用copyにlocalhost限定の許可を付けて実Chrome scripting APIを確認します。本番manifestの権限は変更しません。ツールバー操作による `activeTab` 許可と、拡張ポップアップ内での実モデル翻訳は手動確認項目です。

実モデル・オフライン・本文通信の検証は別の重いsuiteです。

```sh
npm run verify:models
npm run test:models
```

検証suiteでは本物の取得処理を使い、モデル配布元の応答だけを検証済みローカルファイルで代替します。その後ネットワークを遮断し、新しいWorkerで6方向各10文を翻訳します。取得元CDNのブラウザCORS、iPhone／Android実機、母語話者による意味品質、Chrome Web Store審査は別の検証項目です。出力と診断は `test-results/` に保存され、本文は外部へ送信しません。

テスト専用harnessは `npm run build:test` の場合だけビルドされます。配布前には `npm run build` を実行し、通常ビルドを使用してください。

## 構成

- `apps/web`：React PWA、Service Worker、モデル管理UI
- `apps/extension`：Manifest V3のポップアップ、確認付きページ置換
- `packages/translator-core`：言語・6方向ルート・入力検証・トークン分割・逐次翻訳
- `packages/inference-worker`：Transformers.js / ONNX Runtime Web実行
- `packages/model-manager`：固定manifest、SHA-256、Cache Storage、削除
- `tests`：単体、画面、実モデル・オフライン・プライバシー検証

依存はlockfileで固定しています。`.npmrc` はnpm 10によるVitestの任意browser adapterの再帰解決不具合を避ける設定です。上流モデルや依存を更新するときは、同じ評価セットとオフライン検証を再実行してください。第三者ライセンスと出典は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) およびビルドの `licenses/` に含めます。
