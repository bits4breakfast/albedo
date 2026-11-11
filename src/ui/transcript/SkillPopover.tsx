/**
 * The message box's `/` list (#349), drawn above the box, and the strip a
 * picked skill leaves there. State and keys are useSkillMenu.ts; this only
 * draws and takes clicks.
 *
 * Like the `@` list, a listbox the textarea controls (`aria-activedescendant`):
 * focus stays in the text the whole time, and a click on a row never takes it.
 */

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Highlighted } from '../Highlighted';
import type { Skill } from '../../capture';
import { firstSentence, splitSkillName } from './skillMenu';
import type { SkillMenu } from './useSkillMenu';
import './skillMenu.css';

export function skillOptionId(listId: string, i: number): string {
  return `${listId}-${i}`;
}

/** The name, its plugin prefix in the quieter tier, matched characters marked. */
function SkillName({ name, hits }: { name: string; hits: number[] }): ReactNode {
  const { prefix, base } = splitSkillName(name);
  const at = prefix.length;
  return (
    <>
      {prefix ? (
        <span className="sk-prefix">
          <Highlighted text={prefix} hits={hits.filter((h) => h < at)} className="sk-hit" />
        </span>
      ) : null}
      <Highlighted text={base} hits={hits.filter((h) => h >= at).map((h) => h - at)} className="sk-hit" />
    </>
  );
}

export function SkillPopover({ menu, listId }: { menu: SkillMenu; listId: string }): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    if (!menu.open) return;
    listRef.current?.querySelector<HTMLElement>(`[aria-selected="true"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [menu.open, menu.active]);

  if (menu.empty) {
    return (
      <div className="sk-pop" role="status">
        <div className="sk-note">No skills yet: the session lists them when it starts.</div>
      </div>
    );
  }
  if (!menu.open) return null;
  const { items, active, total } = menu;
  return (
    <div className="sk-pop">
      <div className="sk-list" id={listId} ref={listRef} role="listbox" aria-label="Skills">
        {items.map((item, i) => (
          <div
            key={item.skill.name}
            id={skillOptionId(listId, i)}
            role="option"
            aria-selected={i === active}
            className="sk-row"
            title={item.skill.description || undefined}
            // Move, not enter: a list scrolling under a resting pointer must
            // not drag the selection with it.
            onMouseMove={() => i !== active && menu.setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => menu.pick(item)}
          >
            <span className="sk-name">
              <SkillName name={item.skill.name} hits={item.nameHits} />
            </span>
            <span className="sk-desc">
              <Highlighted text={firstSentence(item.skill.description)} hits={item.descHits} className="sk-hit" />
            </span>
          </div>
        ))}
      </div>
      <div className="sk-foot">
        <span aria-hidden="true">↑↓ Move · ↵ or ⇥ Insert · Esc Close</span>
        <span className="sk-count">
          {items.length} of {total} {total === 1 ? 'skill' : 'skills'}
        </span>
      </div>
    </div>
  );
}

/**
 * What the picked skill says about itself, above the box: its whole
 * description, three lines at most, the rest on hover. The listing carries no
 * argument hints, and the description is where a skill says what it takes.
 */
export function SkillStrip({ skill, onHide }: { skill: Skill; onHide: () => void }): ReactNode {
  return (
    <div className="sk-strip" role="note" aria-label={`About /${skill.name}`}>
      <span className="sk-chip">/{skill.name}</span>
      <span className="sk-strip-desc" title={skill.description || undefined}>
        {skill.description || 'This skill has no description.'}
      </span>
      <button type="button" className="sk-strip-hide" onClick={onHide} aria-label="Hide the description" title="Hide for this message">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
