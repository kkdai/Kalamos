import { markdownLanguage, pasteURLAsLink } from "@codemirror/lang-markdown";
import {
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
} from "@codemirror/language";
import {
  type MarkdownExtension,
  type MarkdownParser,
  parseCode,
} from "@lezer/markdown";

export interface MarkdownSupportConfig {
  codeLanguages?:
    | readonly LanguageDescription[]
    | ((info: string) => Language | LanguageDescription | null);
  extensions?: MarkdownExtension[];
  pasteURLAsLink?: boolean;
}

function getCodeParser(
  languages:
    | readonly LanguageDescription[]
    | ((info: string) => Language | LanguageDescription | null),
) {
  return (info: string) => {
    if (!info) return null;
    const token = /\S*/.exec(info)?.[0] ?? "";
    if (!token) return null;
    const found =
      typeof languages === "function"
        ? languages(token)
        : LanguageDescription.matchLanguageName(languages, token, true);
    if (found instanceof LanguageDescription) {
      return found.support
        ? found.support.language.parser
        : ParseContext.getSkippingParser(found.load());
    }
    return found ? found.parser : null;
  };
}

/**
 * Lightweight CodeMirror Markdown support built on `markdownLanguage` without
 * calling `@codemirror/lang-markdown`'s `markdown()` helper.
 *
 * `@codemirror/lang-markdown`'s `markdown()` statically wires an embedded HTML
 * language parser (`@codemirror/lang-html` -> `@lezer/html`, `@lezer/css`,
 * `@lezer/javascript`) even when `completeHTMLTags: false`. Kalamos parses raw
 * HTML only via `@lezer/markdown`'s own `HTMLTag` / `HTMLBlock` nodes, so
 * skipping the embedded HTML/JS/CSS sub-parsers removes ~178 KB raw (~81 KB
 * minified) of unused grammar code from the startup bundle.
 */
export function createMarkdownSupport(
  config: MarkdownSupportConfig = {},
): LanguageSupport {
  const extensions: MarkdownExtension[] = config.extensions
    ? [...config.extensions]
    : [];
  if (config.codeLanguages) {
    extensions.push(
      parseCode({ codeParser: getCodeParser(config.codeLanguages) }),
    );
  }
  const parser = (markdownLanguage.parser as MarkdownParser).configure(
    extensions,
  );
  const lang = new Language(markdownLanguage.data, parser, [], "markdown");
  const support = config.pasteURLAsLink === false ? [] : [pasteURLAsLink];
  return new LanguageSupport(lang, support);
}
