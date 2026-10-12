/**
 * The code / text editor (CodeMirror 6): line numbers, syntax colours for the file's language, search,
 * undo, and Ctrl/Cmd+S to save. Loaded only when a text file opens; each language loads only when needed.
 * Colours come from CSS classes (tok-*) styled in TextEditor.vue, so light and dark themes both read well.
 */
import { EditorState } from '@codemirror/state'
import {
  drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { classHighlighter } from '@lezer/highlight'

const js = opts => import('@codemirror/lang-javascript').then(m => m.javascript(opts))
const legacy = load => load().then(parser => StreamLanguage.define(parser))
const LANGUAGES = {
  js: () => js(), mjs: () => js(), cjs: () => js(), jsx: () => js({ jsx: true }),
  ts: () => js({ typescript: true }), tsx: () => js({ typescript: true, jsx: true }),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  vue: () => import('@codemirror/lang-html').then(m => m.html()),
  xml: () => import('@codemirror/lang-xml').then(m => m.xml()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  php: () => import('@codemirror/lang-php').then(m => m.php()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
  yml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  sh: () => legacy(() => import('@codemirror/legacy-modes/mode/shell').then(m => m.shell)),
  ini: () => legacy(() => import('@codemirror/legacy-modes/mode/properties').then(m => m.properties)),
  env: () => legacy(() => import('@codemirror/legacy-modes/mode/properties').then(m => m.properties)),
  conf: () => legacy(() => import('@codemirror/legacy-modes/mode/properties').then(m => m.properties)),
  toml: () => legacy(() => import('@codemirror/legacy-modes/mode/toml').then(m => m.toml)),
}

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface-2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace", fontSize: '13px', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--primary) 10%, transparent)', color: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--primary) 25%, transparent) !important' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
  '.cm-panels input, .cm-panels button': { fontSize: '13px' },
})

/**
 * An editor in `parent`. `onChange(text)` after every edit, `onSave()` on Ctrl/Cmd+S.
 * Answers { setText, focus, destroy }.
 */
export async function createEditor({ parent, text, ext, readOnly = false, onChange, onSave }) {
  let language = []
  try { language = LANGUAGES[ext] ? [await LANGUAGES[ext]()] : [] } catch { /* plain text, still editable */ }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), indentOnInput(),
        bracketMatching(), highlightActiveLine(), highlightSelectionMatches(), EditorView.lineWrapping,
        syntaxHighlighting(classHighlighter), theme, language,
        EditorState.readOnly.of(readOnly),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true } },
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
        ]),
        EditorView.updateListener.of(u => { if (u.docChanged) onChange?.(u.state.doc.toString()) }),
        EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      ],
    }),
  })
  return {
    setText(next) {
      if (next === view.state.doc.toString()) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
