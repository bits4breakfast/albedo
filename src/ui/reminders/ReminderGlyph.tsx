import { Glyph } from '../icons';

/**
 * An alarm clock: the reminder's label on its card, its row mark and its row
 * in the transcript. currentColor, so the text beside it sets the contrast.
 */
export function ReminderGlyph({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <circle cx="8" cy="8.75" r="5" />
      <path d="M8 6.25v2.5l1.75 1.25M2.5 3.5l2-1.5M13.5 3.5l-2-1.5" />
    </Glyph>
  );
}
