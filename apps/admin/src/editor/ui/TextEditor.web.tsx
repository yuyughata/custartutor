// The text box of the editor in the browser: a real <input> / <textarea> (so selection, spell-check, IME and screen
// readers behave), a Bold button with Ctrl/Cmd+B, a live rendered preview of the `**bold**` markup and a character
// and word count. Plain DOM elements are fine in a `.web.tsx` file (as the Select and the images are).
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { charCount, hasUnmatchedMarker, splitBold, toggleBold, wordCount } from '../markup';
import { colors, radii } from '../../ui/theme';
import type { TextEditorProps } from './textEditorTypes';

// The same stack react-native-web gives its Text, so the plain DOM elements here do not fall back to the browser's serif.
const FONT =
  'System, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const box = {
  width: '100%',
  boxSizing: 'border-box' as const,
  border: `1.5px solid ${colors.borderStrong}`,
  borderRadius: radii.md,
  padding: '8px 12px',
  fontSize: 15,
  lineHeight: '22px',
  color: colors.text,
  background: colors.white,
  fontFamily: FONT,
};

export function TextEditor({
  label,
  value,
  onChange,
  multiline = false,
  rich = false,
  rows = 3,
  hint,
  readOnly = false,
  fieldKey,
  invalid = false,
  mono = false,
  counts = false,
  hideLabel = false,
}: TextEditorProps): ReactNode {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  // After a Bold toggle the text changes under the cursor; put the selection back once React has rendered it.
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    const el = ref.current;
    if (pending && el) {
      el.setSelectionRange(pending.start, pending.end);
      pendingSelection.current = null;
    }
  });

  const bold = (): void => {
    const el = ref.current;
    if (!el || readOnly) return;
    const edit = toggleBold(value, { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
    pendingSelection.current = edit.selection;
    onChange(edit.text);
    el.focus();
  };

  const visibleRows = multiline
    ? Math.max(rows, Math.min(16, Math.ceil(value.length / 80) + value.split('\n').length - 1))
    : 1;

  const common = {
    id,
    value,
    readOnly,
    'aria-label': hideLabel ? label : undefined,
    'aria-invalid': invalid || undefined,
    'aria-describedby': hint ? `${id}-hint` : undefined,
    'data-field': fieldKey,
    spellCheck: true,
    style: {
      ...box,
      borderColor: invalid ? colors.danger : colors.borderStrong,
      backgroundColor: readOnly ? colors.page : colors.white,
      ...(mono ? { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' } : {}),
      ...(multiline ? { resize: 'vertical' as const } : { minHeight: 40 }),
    },
    onKeyDown: (event: {
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      key: string;
      preventDefault: () => void;
    }) => {
      if (
        rich &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault();
        bold();
      }
    },
  };

  const segments = rich ? splitBold(value) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {hideLabel ? null : (
          <label
            htmlFor={id}
            style={{ fontSize: 14, fontWeight: 600, color: colors.textSoft, fontFamily: FONT }}
          >
            {label}
          </label>
        )}
        {rich && !readOnly ? (
          <button
            type="button"
            aria-label={`Bold, in ${label} (Ctrl+B)`}
            title="Bold (Ctrl+B or Cmd+B)"
            onMouseDown={(event) => event.preventDefault()}
            onClick={bold}
            style={{
              minWidth: 32,
              height: 28,
              border: `1.5px solid ${colors.borderStrong}`,
              borderRadius: radii.md,
              background: colors.white,
              color: colors.primaryDark,
              fontWeight: 800,
              fontSize: 14,
              fontFamily: FONT,
              cursor: 'pointer',
            }}
          >
            B
          </button>
        ) : null}
      </div>
      {multiline ? (
        <textarea
          {...common}
          ref={(node) => {
            ref.current = node;
          }}
          rows={visibleRows}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          ref={(node) => {
            ref.current = node;
          }}
          type="text"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? (
        <span id={`${id}-hint`} style={{ fontSize: 13, color: colors.subtle, fontFamily: FONT }}>
          {hint}
        </span>
      ) : null}
      {rich && multiline && value.includes('**') ? (
        <div
          data-testid="rich-preview"
          aria-label={`Preview of ${label}`}
          style={{
            border: `1px dashed ${colors.border}`,
            borderRadius: radii.md,
            padding: '6px 10px',
            fontSize: 15,
            lineHeight: '22px',
            color: colors.text,
            background: colors.primaryTint,
            fontFamily: FONT,
            whiteSpace: 'pre-wrap',
          }}
        >
          {segments.map((part, index) =>
            part.bold ? (
              <strong key={index}>{part.text}</strong>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </div>
      ) : null}
      {(counts || rich) && multiline ? (
        <span style={{ fontSize: 12, color: colors.subtle, fontFamily: FONT }}>
          {charCount(value)} characters · {wordCount(value)} words
          {hasUnmatchedMarker(value) ? ' · ⚠ a ** marker has no partner' : ''}
        </span>
      ) : null}
    </div>
  );
}
