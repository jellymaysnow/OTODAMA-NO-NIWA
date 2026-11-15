# OTODAMA NO NIWA

[English](README.md)

音を水彩インクの滴に変換して描くビジュアライザー。静的ページなので、`index.html` を開く（または GitHub Pages で公開する）だけで動きます。

## 機能

- **入力**: 内蔵音声（`Project.wav`）、マイク、自分の音声ファイル（選択・ドロップ）。
- **インク描画**: 低・中・高の帯域（または楽器ごと）が紙にインクを落とし、長い音は広く淡い滲みになります。詳細は [docs/ink.ja.md](docs/ink.ja.md)。
- **パレット**: プリセットと自由選択。広い画面では左下にステレオ・スコープ（ゴニオメーター）を表示します。
- **仕上げ**: 曲が終わると紙が乾き、題・日付・落款が入ります。いつでも画像として保存できます。
- **動画録画**: 曲の最初から、音付きで作品を録画できます。
- **分離モード（ローカル限定）**: Demucs で曲を6楽器に分離し、楽器ごとに描画します。

## 試す

- **公開版（GitHub Pages）**: ページを開いて開始します。内蔵音声・マイク・ファイル読込が使えます。マイクは HTTPS が必要で、Pages なら満たされます。
- **ローカル**: `index.html` をブラウザで開くか、`start.bat` をダブルクリックしてローカルサーバーを起動します（分離モードにも必要です）。

## 「分離」モードはローカル限定

Demucs を使うため、自分のPCで `tools/server.py` を起動しているときだけ動きます。公開版では接続できず、自動で通常モードに戻ります。音声はどこにもアップロードされません。

```
pip install demucs numpy        # GPU/CPU に合った torch も必要
python tools/server.py --open   # または start.bat をダブルクリック
```

詳細は [docs/ink.ja.md](docs/ink.ja.md) を参照してください。

## 構成

| パス | 内容 |
|---|---|
| `index.html`, `css/`, `js/` | アプリ本体（静的） |
| `tools/server.py` | 分離モード用のローカルサーバー |
| `tools/separate.py` | 内蔵音声向けステムの事前分離 |
| `docs/` | モジュール解説（日本語 / 英語） |
| `Project.wav` | 内蔵音声 |

## ライセンス・クレジット

- **コード**: [PolyForm Noncommercial License 1.0.0](LICENSE)。個人・研究・教育・趣味など非商用の利用は可、販売・商用利用は不可です。
- **内蔵音声（`Project.wav`）**: 作者オリジナル。上記ライセンスの対象外で、全権利留保です。無断での再配布・利用はできません。これ以外の音声ファイルはリポジトリに含めません（`.gitignore` で除外）。
- **外部**: Tailwind CSS（MIT）、Inter・Shippori Mincho（SIL OFL 1.1、Google Fonts 経由）、Demucs（MIT、ローカル使用のみ）。

Copyright (c) 2026 Jieli
