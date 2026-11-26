// The SQL editor's look, built from the colour tokens so it follows the app
// theme. Structure and highlighting rules mirror CodeMirror's One Dark, whose
// colours are the token defaults.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { cssVar } from "./theme";

const v = cssVar;

const editorView = EditorView.theme(
  {
    "&": { color: v("editor-text"), backgroundColor: v("editor-bg") },
    ".cm-content": { caretColor: v("editor-cursor") },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("editor-cursor") },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: v("editor-selection") },
    ".cm-panels": { backgroundColor: v("editor-panel"), color: v("editor-text") },
    ".cm-panels.cm-panels-top": { borderBottom: "2px solid black" },
    ".cm-panels.cm-panels-bottom": { borderTop: "2px solid black" },
    ".cm-searchMatch": { backgroundColor: "#72a1ff59", outline: "1px solid #457dff" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#6199ff2f" },
    ".cm-activeLine": { backgroundColor: "#6699ff0b" },
    ".cm-selectionMatch": { backgroundColor: "#aafe661a" },
    "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "#bad0f847" },
    ".cm-gutters": { backgroundColor: v("editor-bg"), color: v("editor-gutter-text"), border: "none" },
    ".cm-activeLineGutter": { backgroundColor: v("editor-active-gutter") },
    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "#ddd" },
    ".cm-tooltip": { border: "none", backgroundColor: v("editor-tooltip") },
    ".cm-tooltip .cm-tooltip-arrow:before": { borderTopColor: "transparent", borderBottomColor: "transparent" },
    ".cm-tooltip .cm-tooltip-arrow:after": {
      borderTopColor: v("editor-tooltip"),
      borderBottomColor: v("editor-tooltip"),
    },
    ".cm-tooltip-autocomplete": {
      "& > ul > li[aria-selected]": { backgroundColor: v("editor-active-gutter"), color: v("editor-text") },
    },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: v("syntax-keyword") },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: v("syntax-name") },
  { tag: [tags.function(tags.variableName), tags.labelName], color: v("syntax-function") },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: v("syntax-constant") },
  { tag: [tags.definition(tags.name), tags.separator], color: v("editor-text") },
  {
    tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace],
    color: v("syntax-type"),
  },
  {
    tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
    color: v("syntax-operator"),
  },
  { tag: [tags.meta, tags.comment], color: v("syntax-comment") },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: v("syntax-comment"), textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: v("syntax-name") },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: v("syntax-constant") },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: v("syntax-string") },
  { tag: tags.invalid, color: v("syntax-invalid") },
]);

export const editorTheme = [editorView, syntaxHighlighting(highlight)];
