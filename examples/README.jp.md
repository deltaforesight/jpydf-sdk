# JPYdfをローカルのAIクライアントから試す

この接続例では、MCPの標準入出力接続を使い、LP試算と、本番またはstagingの読み取りを試せます。Node 22以上と、ローカルサーバー設定に対応したMCPクライアントを用意してください。初回はインストールと接続確認まで進め、chain設定とエラー対処は必要なときに参照してください。

配布元に、試験利用の問い合わせ先とstaging manifestの提供方法を確認してください。manifest、RPC接続情報、利用者のaccount設定は配布セットとは別に受け取ります。stagingとcanaryは`TEST_ONLY_NOT_FOR_PRODUCTION`です。canaryはアクセス制限付きの内部検証に限ります。

## 配布セットをインストールする

配布アーカイブを展開したディレクトリで実行します。

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/mcp-modes.test.mjs
```

テストが成功すると、公式MCPクライアントからの起動、ツール一覧取得、LP試算、入力エラー、write操作の拒否を確認できます。これはオフライン接続の検証です。本番とstagingの実チェーン読み取りは後述の設定で別途確認します。

## オフラインでLP試算を呼び出す

ローカル設定ファイルに`JPYDF_MODE=offline`を保存します。MCPクライアントの設定に次のエントリを加え、node、設定ファイル、展開先のパスを実際の絶対パスへ置き換えてください。

```json
{
  "mcpServers": {
    "jpydf-read-only": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/jpydf-agent.env",
        "/absolute/path/to/bundle/examples/mcp-stdio.mjs"
      ]
    }
  }
}
```

ツール一覧に`lp.simulate`だけが表示されます。次の引数で呼び出してください。

```json
{
  "budgetJpy": "1000000",
  "fxJpyPerUsd": "150",
  "spotJpydfPerUsdc": "150",
  "lowerJpydfPerUsdc": "140",
  "upperJpydfPerUsdc": "160",
  "futureFxJpyPerUsd": "155",
  "futureJpydfJpy": "1"
}
```

入力はすべて人が読む単位の小数文字列です。予算は円、FXは1ドル当たりの円、spotとrangeは1 USDC当たりのJPYdf、将来のJPYdf価格は1 JPYdf当たりの円です。正数、小数6桁以内、指数表記なしで入力します。予算の上限は1兆円、FX・spot・rangeは100万、将来のJPYdf価格は10円です。lowerはupper未満で、将来のJPYdf/USDC比率は0.000001〜1000000に収めます。

応答の`ok: true`と、`data.simulationOnly: true`、`data.liveData: false`を確認してください。試算はUSDCを1ドルとし、手数料・報酬・gas・リバランスを含みません。初期トークン量は整数の最小単位でも返し、将来価値は数値による概算を返します。rangeはtick単位に調整されるため、入力値と実効rangeが異なる場合があります。

## 本番またはstagingの読み取りに切り替える

設定ファイルを自分だけが読める権限にし、次の値を設定します。

| 変数 | 値 |
| --- | --- |
| `JPYDF_MODE` | 本番は`production`、stagingは`mainnet-staging` |
| `JPYDF_MANIFEST_PATH` | 本番はSDKのsource repositoryにある`descriptors/jpydf-production.json`、stagingは配布元が提供したmanifestの絶対パス。どちらも内容を書き換えない |
| `JPYDF_RPC_URL` | 運用者が承認したEthereum mainnetのHTTPS RPC URL |
| `JPYDF_ACCOUNT` | この利用者に割り当てたアドレス。秘密鍵は不要 |

MCPサーバーを再起動し、`integration.get`を`{}`で呼び出します。続いて`protocol.get`を`{}`、`market.get`を`{"branchId":1}`、`account.get`を`{}`で呼び出してください。応答のdeployment identityと`testOnly`（本番は`false`、stagingは`true`）を確認し、marketの観測block identityを保存します。LP試算は同じ接続から引き続き使えます。

本番では`jpydfUsdc.pool`と`jpydfUsdc.quote`も表示されます。それぞれJPYdf/USDCのUniswap v4プールの状態と、exact-inputの見積りを返します。プール価格はJPYdfの市場価格で、1円の参照目標と違うことがあります。見積りは約定価格の保証ではありません。

起動設定はローカル運用者が管理し、modelへのpromptやtool引数に入れません。接続例は1プロセス・1利用者のローカル用途です。外部HTTPサーバーとして公開するには、別途認証・全体の処理上限・監視を設計し検証する必要があります。

## エラーを確認する

起動に失敗したら、nodeとファイルの絶対パス、設定ファイルの読み取り権限、manifestの対象環境を確認します。manifestが一致しないときは配布元に確認し、pinを書き換えて接続しないでください。

操作の失敗は`isError: true`とSDKの`error.code`で確認できます。`INVALID_INPUT`では入力を修正します。再試行できる応答は`retryable`と`retryAfterMs`を確認し、有限の回数・時間内で待ってから再試行します。接続例自体は自動再試行しません。

問い合わせにはNode・依存バージョン、`verification.json`のsource commit、操作名、error codeを添えてください。RPC credentialや設定ファイルを貼り付けないでください。清算候補の読み取りは実行の承認になりません。署名・broadcast・write操作はこのMCP接続例で提供しません。
