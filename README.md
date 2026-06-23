# ccr — Claude Code cross-project session resumer
ターミナル版 Claude Code はセッション履歴を **作業ディレクトリごとに分割** して保存します。
組み込みの `/resume` は「いま開いているディレクトリ」のセッションしか一覧に出さず、別のディレクトリで話していた会話を見失いがちです。

`ccr` は `~/.claude/projects/` 配下の **全ディレクトリのセッションを横断して一覧** し、
fzf ライクなピッカーで絞り込み・選択すると、その会話の **元の作業ディレクトリで `claude --resume` を起動** します。

---

## 目次

- [要件](#要件)
- [インストール](#インストール)
- [使い方](#使い方)
- [ピッカーの操作](#ピッカーの操作)
- [オプション](#オプション)
- [非対話モード](#非対話モードパイプjson)
- [仕組み](#仕組み)
- [環境変数](#環境変数)
- [トラブルシューティング](#トラブルシューティング)
- [アンインストール](#アンインストール)

---

## 要件

- **Node.js 18 以上**
- **Claude Code CLI**（`claude` コマンド）が PATH にあること
- macOS / Linux（`/dev/tty` を使うため Windows ネイティブ環境は非対応。WSL は可）

---

## インストール

依存が無いので、`ccr.mjs` 1 ファイルを PATH 上に置くだけです。
以下は `ccr.mjs` のあるディレクトリで実行してください。

### 方法 A: symlink

```sh
chmod +x ccr.mjs
ln -s "$PWD/ccr.mjs" ~/.local/bin/ccr
```

`~/.local/bin` が PATH に入っていない場合は、PATH 上の任意ディレクトリに置き換えてください。
`$PWD` で実体パスを解決するため、リポジトリをどこに置いても動きます。更新は symlink 経由で即反映されます。

### 方法 B: npm link

```sh
npm link        # `ccr` コマンドが PATH に登録される
```

### 動作確認

```sh
ccr --help
ccr --json | head        # セッションが JSON で列挙されれば成功
```

---

## 使い方

```sh
ccr                        # 全セッションをピッカーで開く
ccr ログイン               # 初期クエリ付きで開く
ccr --here                 # いまのディレクトリ配下のセッションのみ
ccr --cwd ~/path/to/proj   # 指定ディレクトリ配下のみ
ccr --days 3               # 直近 3 日に更新されたものだけ
```

ピッカーで会話を選ぶと、その会話の **元ディレクトリで `claude --resume <sessionId>` が起動** します。
Claude を終了すると **元のシェルに戻ります**（`ccr` は親シェルのカレントディレクトリを変えません）。

> 初めて使うときは `ccr --dry-run` を試すと安全です。選択しても再開コマンドを表示するだけで、実際には起動しません。

---

## ピッカーの操作

| キー | 動作 |
| --- | --- |
| 文字入力 | インクリメンタル絞り込み（スペース区切りは AND 条件） |
| `↑` / `↓`、`Ctrl-P` / `Ctrl-N` | カーソル移動 |
| `Enter` | 選択して再開 |
| `Esc` / `Ctrl-C` | キャンセル |
| `Ctrl-U` | 入力クリア |
| `Ctrl-F` | 再開時の `--fork-session`（別 ID 化）をトグル（ヘッダに `[fork]` 表示） |

**検索対象** は以下を連結した文字列です（大文字小文字は無視）:

- 作業ディレクトリ（cwd）
- タイトル（`ai-title` または最初のユーザーメッセージ）
- slug
- sessionId

### 一覧の見方

```
❯● 24m ~/projects/web-app  ログイン画面のバリデーション修正
│└─ 稼働中マーカー  │            │     └─ タイトル
└─ 選択カーソル     │            └─ 作業ディレクトリ（~ 短縮・長い場合は省略）
                    └─ 最終更新からの相対時間
```

| マーカー | 意味 |
| --- | --- |
| `●`（緑） | そのセッションが現在稼働中（生存している Claude プロセスが存在） |
| `⚠`（赤） | 作業ディレクトリが既に削除されている（再開は不可） |
| （空白） | 通常のセッション |

画面幅が広い場合（おおむね **100 桁以上**）は右側に **プレビュー窓** が出て、
会話の冒頭テキストとメタ情報（cwd の実在可否・git ブランチ・絶対日時・稼働状態）を表示します。
`--no-preview` で無効化できます。

---

## オプション

| オプション | 説明 |
| --- | --- |
| `[query]`、`-q`、`--query <s>` | 初期クエリ（ピッカーの初期絞り込み、非対話時はフィルタ） |
| `--here` | カレントディレクトリ配下のみ（前方一致） |
| `--cwd <path>` | 指定パス配下のみ（前方一致） |
| `--exclude-running`（`--no-running`） | 稼働中らしきセッションを隠す |
| `--include-agents` | サブエージェントのセッションも表示（既定は除外） |
| `--sort mtime\|created\|cwd` | 並び順（既定: `mtime` = 最終更新の新しい順） |
| `--limit <N>` | 最大 N 件 |
| `--days <N>` | 直近 N 日に更新されたものだけ |
| `--fork`（`--fork-session`） | `--fork-session` 付きで再開（新しい session id を生成） |
| `--dry-run` | 実行せず `cd <dir> && claude --resume <id>` を表示 |
| `--json` | 収集結果を JSON で出力して終了 |
| `--no-preview` | プレビュー窓を無効化 |
| `-h`、`--help` | ヘルプ |

### `--sort` の値

| 値 | 並び順 |
| --- | --- |
| `mtime`（既定） | セッションファイルの最終更新が新しい順 |
| `created` | 会話開始（最初のユーザーメッセージ）が新しい順 |
| `cwd` | 作業ディレクトリのパス辞書順 |

---

## 非対話モード（パイプ・JSON）

出力がパイプ等で **TTY でない場合**、または `--json` 指定時は、ピッカーを開かず
`--query` を適用した結果を出力します。スクリプトや確認用途に使えます。

```sh
# プレーン一覧（稼働中マーカー・相対時間・id・cwd・タイトル）
ccr --query ログイン | cat

# JSON（jq で加工可能）
ccr --json | jq -r '.[] | "\(.sessionId)\t\(.cwd)\t\(.label)"'

# 直近の特定プロジェクトのセッション id だけ取り出す
ccr --json --cwd ~/myproj --limit 1 | jq -r '.[0].sessionId'
```

JSON の各要素には `sessionId` / `cwd` / `slug` / `aiTitle` / `firstUserText` /
`label` / `mtimeMs` / `createdMs` / `gitBranch` / `version` / `isRunning` /
`runningStatus` / `cwdExists` / `isAgent` などが含まれます。

---

## 仕組み

- セッションは `~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl` に保存される
- **作業ディレクトリは jsonl 内の `cwd` フィールドから取得** します。
- **稼働中判定** は `~/.claude/sessions/{pid}.json` を読み、その PID が実際に生存している場合（`process.kill(pid, 0)`）のみ「稼働中」とみなします。
- 既定で **サブエージェントのトランスクリプト**（会話ターンを持たない記録）は除外します。
- 選択時は `claude --resume <sessionId>`（`--fork` 時は `--fork-session` 付き）を、その cwd で `stdio: 'inherit'` で起動します。

---

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` の代わりに使う設定ディレクトリ |
| `CLAUDE_BIN` | `claude` バイナリのパスを明示指定 |

---

## アンインストール

```sh
rm ~/.local/bin/ccr        # symlink を消すだけ（方法 A の場合）
# または
npm unlink -g ccr          # 方法 B の場合
```

セッション履歴（`~/.claude/`）には一切手を加えていないため、削除はこれで完了です。

---

## ライセンス

MIT
