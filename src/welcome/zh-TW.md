---
title: 歡迎使用 Kalamos
tags: [Markdown, 快速入門]
---

# 歡迎使用 Kalamos

Kalamos 是一款專注寫作的本機 Markdown 編輯器。點選任何段落即可編輯原始語法，移開游標便會還原成乾淨的**即時預覽**——支援*斜體*、**粗體**與 `行內程式碼`。

> 這是一份未命名的示範文件，不會寫入磁碟，你可以自由試著編輯。之後隨時可以從「說明 > 歡迎文件」再次開啟。

- [x] 即時預覽與 YAML Front Matter（上方可點擊展開編輯）
- [ ] 按下 {{shortcuts}} 開啟完整快捷鍵速查表

## 常用快捷鍵與表格

| 快捷鍵 | 功能 |
| --- | --- |
| {{quickOpen}} | 快速開啟檔案 |
| {{newTab}} | 新增分頁 |
| {{sourceMode}} | 切換原始碼模式 |
| {{shortcuts}} | 鍵盤快捷鍵速查表 |

## 數學公式

支援行內公式如 $E = mc^2$，以及獨立區塊公式：

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

## 程式碼區塊

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

## 圖表（Mermaid）

```mermaid
flowchart LR
  A[專心寫作] --> B[即時預覽]
  B --> C[匯出 PDF / DOCX]
```
