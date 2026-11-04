/**
 * ReadOnlyNote.tsx -- the action note shown beside pending items.
 *
 * Some rows a panel lists (open invites, pending signing tasks) are decisions
 * an officer takes in the Authority app, never here. This note tells the
 * officer where that decision is taken. It is shown once per list, under the
 * list heading; a row that needs to repeat it points `aria-describedby` at
 * the note's `id` instead of rendering a second copy.
 *
 * It is plain text: a muted paragraph with no button, link, role, tab stop,
 * tooltip or click handler, and no styling that makes it look like a control
 * that has been switched off. Two variants:
 *   - `short`: one line beside a list that has items.
 *   - `long`: the context line for an empty list.
 *
 * Styling lives in `panels.css`, imported here so the note looks the same
 * wherever it mounts.
 */
import { t } from '@votetorrent/ui-web';
import '../screens/panels/panels.css';

export interface ReadOnlyNoteProps {
	variant: 'short' | 'long';
	/** Lets a row reference this one note from its accessible description. */
	id?: string;
}

export function ReadOnlyNote({ variant, id }: ReadOnlyNoteProps) {
	if (variant === 'long') {
		return (
			<p className="panel-readonly-note panel-readonly-note--long" id={id}>
				{t('panel.readOnly.long')}
			</p>
		);
	}
	return (
		<p className="panel-readonly-note" id={id}>
			{t('panel.readOnly.short')}
		</p>
	);
}
