import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getMockUploadCalls,
  resetMockState,
  seedMockUploadSettings,
  seedMockFile,
  setMockDialogHandlers,
  setMockUploadHandler,
  setSettings,
  getSettings,
  UPLOADER_NOT_CONFIGURED_MESSAGE,
} from "../ipc";
import { createKalamosApp, type KalamosApp } from "../main";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import {
  beginTracking,
  changedInside,
  collectUploadTargets,
  collectUploadTargetsInRange,
  endTracking,
  imgSrcValueRange,
  markdownDestinationFor,
  NO_LOCAL_IMAGES_MESSAGE,
  replaceUploadedImages,
  uploadImagesInEditor,
} from "./image-upload";
import { imageDocPathField, setImageDocPathEffect } from "./images";
import { mathMarkdownExtension } from "./math";

const DOC_PATH = "/tmp/kalamos-test/notes/post.md";

function stateOf(doc: string, selection: EditorSelection | number = 0): EditorState {
  let state = EditorState.create({
    doc,
    selection: typeof selection === "number" ? EditorSelection.cursor(selection) : selection,
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdown({
        base: markdownLanguage,
        addKeymap: false,
        extensions: [mathMarkdownExtension, cjkEmphasisExtension, frontMatterExtension, footnoteExtension],
      }),
      imageDocPathField,
      history(),
    ],
  });
  state = state.update({ effects: setImageDocPathEffect.of(DOC_PATH) }).state;
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

const DOC = [
  "Intro ![cat](assets/cat.png \"Cat title\") text",
  "",
  '<img src="assets/dog%20pic.png" alt="狗" width="120" title="Dog">',
  "",
  "![remote](https://example.test/r.png) ![data](data:image/png;base64,AAAA)",
  "",
  "![abs](/tmp/kalamos-test/pics/abs.jpg)",
].join("\n");

describe("IM-05 collecting upload targets", () => {
  it("collects every local image in the document, skipping remote and data URLs", () => {
    const state = stateOf(DOC, DOC.indexOf("Intro"));
    const { targets, scope } = collectUploadTargets(state);
    expect(scope).toBe("document");
    expect(targets.map((t) => t.path)).toEqual([
      "/tmp/kalamos-test/notes/assets/cat.png",
      "/tmp/kalamos-test/notes/assets/dog pic.png",
      "/tmp/kalamos-test/pics/abs.jpg",
    ]);
    expect(targets.map((t) => state.sliceDoc(t.destFrom, t.destTo))).toEqual([
      "assets/cat.png",
      "assets/dog%20pic.png",
      "/tmp/kalamos-test/pics/abs.jpg",
    ]);
    expect(targets[1].html).toBe(true);
  });

  it("only the images under the cursor or selection when there are some", () => {
    const onDog = stateOf(DOC, DOC.indexOf("dog%20"));
    expect(collectUploadTargets(onDog)).toMatchObject({ scope: "selection", targets: [{ html: true }] });

    const from = DOC.indexOf("![cat]");
    const to = DOC.indexOf("<img");
    const selected = collectUploadTargets(stateOf(DOC, EditorSelection.single(from, to + 3)));
    expect(selected.targets).toHaveLength(2);

    // Cursor on a remote image only: falls back to the whole document.
    const onRemote = collectUploadTargets(stateOf(DOC, DOC.indexOf("remote")));
    expect(onRemote.scope).toBe("document");
    expect(onRemote.targets).toHaveLength(3);
  });

  it("untitled documents only upload absolute paths", () => {
    let state = stateOf(DOC);
    state = state.update({ effects: setImageDocPathEffect.of(null) }).state;
    expect(collectUploadTargetsInRange(state).map((t) => t.path)).toEqual(["/tmp/kalamos-test/pics/abs.jpg"]);
  });

  it("finds the src value of an img tag (first src wins, any quoting)", () => {
    const tag = `<img alt="x" src='a b.png' src="other.png">`;
    const r = imgSrcValueRange(tag)!;
    expect(tag.slice(r.from, r.to)).toBe("a b.png");
    const bare = `<img src=pic.png width=10>`;
    const r2 = imgSrcValueRange(bare)!;
    expect(bare.slice(r2.from, r2.to)).toBe("pic.png");
    expect(imgSrcValueRange("<img alt=x>")).toBeNull();
  });

  it("formats URLs for Markdown destinations", () => {
    expect(markdownDestinationFor("https://x.test/a b(1).png")).toBe("https://x.test/a%20b%281%29.png");
  });
});

describe("IM-05 replacing references", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mount(doc: string, cursor = 0): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf(doc, cursor) });
    return view;
  }

  const URLS = new Map([
    ["/tmp/kalamos-test/notes/assets/cat.png", "https://img.test/cat.png"],
    ["/tmp/kalamos-test/notes/assets/dog pic.png", 'https://img.test/dog?a=1&b="2"'],
    ["/tmp/kalamos-test/pics/abs.jpg", "https://img.test/abs.jpg"],
  ]);

  it("keeps alt / title / attributes and replaces everything in one undo step", () => {
    const v = mount(DOC);
    const targets = collectUploadTargets(v.state).targets;
    const id = beginTracking(v);
    const outcome = replaceUploadedImages(v, targets, URLS, endTracking(v, id));
    expect(outcome).toEqual({ replaced: 3, skipped: 0 });
    const doc = v.state.doc.toString();
    expect(doc).toContain('![cat](https://img.test/cat.png "Cat title")');
    expect(doc).toContain(
      '<img src="https://img.test/dog?a=1&amp;b=&quot;2&quot;" alt="狗" width="120" title="Dog">',
    );
    expect(doc).toContain("![abs](https://img.test/abs.jpg)");
    expect(doc).toContain("![remote](https://example.test/r.png)");
    undo(v);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("remaps positions through edits made during the upload; an edited reference is skipped", () => {
    const v = mount(DOC);
    const targets = collectUploadTargets(v.state).targets;
    const id = beginTracking(v);
    // While uploading: text inserted before everything, right after the cat image,
    // and the dog tag's alt edited.
    v.dispatch({ changes: { from: 0, insert: "新的開頭\n" } });
    const catEnd = v.state.doc.toString().indexOf("\"Cat title\")") + '"Cat title")'.length;
    v.dispatch({ changes: { from: catEnd, insert: "!!" } });
    const alt = v.state.doc.toString().indexOf('alt="狗"');
    v.dispatch({ changes: { from: alt + 5, to: alt + 6, insert: "貓" } });
    const changes = endTracking(v, id);
    expect(changes.empty).toBe(false);

    const outcome = replaceUploadedImages(v, targets, URLS, changes);
    expect(outcome).toEqual({ replaced: 2, skipped: 1 });
    const doc = v.state.doc.toString();
    expect(doc.startsWith("新的開頭\nIntro ![cat](https://img.test/cat.png \"Cat title\")!! text")).toBe(true);
    expect(doc).toContain('<img src="assets/dog%20pic.png" alt="貓"');
    expect(doc).toContain("![abs](https://img.test/abs.jpg)");
  });

  it("changedInside ignores edits next to a reference", () => {
    const state = stateOf("abc");
    const tr = state.update({ changes: { from: 3, insert: "x" } });
    expect(changedInside(tr.changes, 0, 3)).toBe(false);
    expect(changedInside(state.update({ changes: { from: 1, insert: "y" } }).changes, 0, 3)).toBe(true);
    expect(changedInside(state.update({ changes: { from: 0, to: 3 } }).changes, 0, 3)).toBe(true);
  });
});

describe("IM-05 upload flow", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function mount(doc: string, cursor = 0): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({ parent, state: stateOf(doc, cursor) });
    return view;
  }

  it("reports a missing uploader without uploading", async () => {
    const v = mount(DOC);
    const statuses: Array<[string, boolean | undefined]> = [];
    let calls = 0;
    const result = await uploadImagesInEditor({
      view: v,
      uploader: null,
      upload: async () => {
        calls++;
        return { urls: [] };
      },
      setStatus: (m, e) => statuses.push([m, e]),
      notConfiguredMessage: UPLOADER_NOT_CONFIGURED_MESSAGE,
    });
    expect(calls).toBe(0);
    expect(result.error).toBe("尚未設定圖床上傳指令（見 docs/image-upload.md）");
    expect(statuses).toEqual([["尚未設定圖床上傳指令（見 docs/image-upload.md）", true]]);
  });

  it("shows progress, uploads each file once and replaces; nothing replaced on failure", async () => {
    const doc = `${DOC}\n\n![again](assets/cat.png)`;
    const v = mount(doc);
    const statuses: string[] = [];
    const uploaded: string[][] = [];
    const ok = await uploadImagesInEditor({
      view: v,
      uploader: "/tmp/kalamos-test/bin/picgo",
      upload: async (paths) => {
        uploaded.push(paths);
        return { urls: paths.map((p) => `https://img.test/${encodeURIComponent(p.split("/").pop()!)}`) };
      },
      setStatus: (m) => statuses.push(m),
      notConfiguredMessage: "x",
    });
    expect(ok).toEqual({ uploaded: 3, replaced: 4, skipped: 0, error: null });
    expect(uploaded).toHaveLength(3);
    expect(statuses[0]).toBe("將上傳 3 張圖片…（picgo）");
    expect(statuses[1]).toBe("上傳中… (1/3)：cat.png（picgo）");
    expect(statuses.at(-1)).toBe("已上傳 3 張圖片");
    expect(v.state.doc.toString().match(/https:\/\/img\.test\/cat\.png/g)).toHaveLength(2);

    const v2 = mount(DOC);
    const fail = await uploadImagesInEditor({
      view: v2,
      uploader: "picgo",
      upload: async (paths) => {
        if (paths[0].endsWith("abs.jpg")) throw { kind: "Io", message: "上傳指令失敗（結束碼 1）" };
        return { urls: ["https://img.test/ok.png"] };
      },
      setStatus: (m) => statuses.push(m),
      notConfiguredMessage: "x",
    });
    expect(fail.error).toBe("上傳失敗：上傳指令失敗（結束碼 1）");
    expect(v2.state.doc.toString()).toBe(DOC);
  });

  it("says so when there is nothing to upload", async () => {
    const v = mount("![r](https://example.test/r.png)");
    const statuses: string[] = [];
    await uploadImagesInEditor({
      view: v,
      uploader: "picgo",
      upload: async () => ({ urls: [] }),
      setStatus: (m) => statuses.push(m),
      notConfiguredMessage: "x",
    });
    expect(statuses).toEqual([NO_LOCAL_IMAGES_MESSAGE]);
  });
});

describe("IM-05 app wiring (mock ipc)", () => {
  let app: KalamosApp | null = null;
  beforeEach(() => {
    resetMockState();
    document.body.innerHTML = `<div id="app"><main id="editor-container"></main><div id="status"></div></div>`;
  });
  afterEach(() => {
    app?.destroy();
    app = null;
  });

  it("Cmd+Opt+U without an uploader shows the setup hint", async () => {
    app = createKalamosApp(document);
    await app.init();
    seedMockFile(DOC_PATH, "![a](a.png)");
    await app.openDocument(DOC_PATH);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyU", key: "†", metaKey: true, altKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(app.getStatusText()).toBe(UPLOADER_NOT_CONFIGURED_MESSAGE);
    expect(getMockUploadCalls()).toEqual([]);
  });

  it("uploads with the configured command and replaces the reference", async () => {
    app = createKalamosApp(document);
    await app.init();
    seedMockUploadSettings("/tmp/kalamos-test/bin/picgo", ["upload"]);
    seedMockFile(DOC_PATH, "# Post\n\n![shot](assets/shot.png)\n");
    await app.openDocument(DOC_PATH);
    expect(await app.uploadDocumentImages()).toBe(true);
    expect(app.editor.getContent()).toBe("# Post\n\n![shot](https://mock-images.kalamos.test/shot.png)\n");
    expect(getMockUploadCalls()).toEqual([["/tmp/kalamos-test/notes/assets/shot.png"]]);
    expect(app.getStatusText()).toBe("已上傳 1 張圖片");
  });

  it("uploadOnInsert uploads pasted images right after importing them", async () => {
    app = createKalamosApp(document);
    await app.init();
    seedMockUploadSettings("picgo");
    await setSettings({ ...(await getSettings()), uploadOnInsert: true });
    seedMockFile(DOC_PATH, "text\n");
    await app.openDocument(DOC_PATH);
    setMockDialogHandlers({});
    setMockUploadHandler(async (paths) => ({ urls: paths.map(() => "https://img.test/pasted.png") }));
    const file = new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" });
    expect(await app.insertPastedImages([file], 5)).toBe(true);
    expect(app.editor.getContent()).toBe("text\n![](https://img.test/pasted.png)");
  });
});
