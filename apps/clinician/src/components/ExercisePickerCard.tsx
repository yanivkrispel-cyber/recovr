import { useState, type CSSProperties } from 'react';
import { equipmentLabel, exerciseCategoryLabel, formatRecommendReason, t, type BodyRegion, type RecommendReason } from 'shared';
import { clickableDivProps } from 'ui';

export interface PickerPrescription {
  sets?: number;
  reps?: number;
  hold_sec?: number;
}

/** One exercise as the picker endpoints return it (search, recommend, recent). */
export interface PickerCardData {
  id: string;
  name: string;
  name_en: string | null;
  category: string;
  body_region: BodyRegion | null;
  equipment: string[];
  is_favorite: boolean;
  thumb_url: string | null;
  gif_url: string | null;
  media_verified: boolean;
  prescription: PickerPrescription | null;
  frequency?: string | null;
  score?: number;
  rank?: number;
  reasons?: RecommendReason[];
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function pickerMediaSrc(u: string): string {
  return u.startsWith('http') ? u : `${SUPABASE_URL}${u}`;
}

export function formatPrescription(rx: PickerPrescription | null, frequency?: string | null): string | null {
  if (!rx) return frequency ?? null;
  const parts: string[] = [];
  if (rx.sets != null && rx.reps != null) parts.push(`${rx.sets} × ${rx.reps}`);
  else if (rx.reps != null) parts.push(`${rx.reps} חזרות`);
  if (rx.hold_sec != null) parts.push(`${rx.hold_sec} שנ׳`);
  if (frequency) parts.push(frequency);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface ExercisePickerCardProps {
  card: PickerCardData;
  selected: boolean;
  inPhase: boolean;
  favorite: boolean;
  showReasons: boolean;
  onToggle: () => void;
  onFavorite: () => void;
  onDetails: () => void;
}

export default function ExercisePickerCard({
  card, selected, inPhase, favorite, showReasons, onToggle, onFavorite, onDetails,
}: ExercisePickerCardProps) {
  const [hovered, setHovered] = useState(false);
  const imgSrc = hovered && card.gif_url ? card.gif_url : card.thumb_url;
  const rx = formatPrescription(card.prescription, card.frequency);
  const reasons = showReasons ? (card.reasons ?? []) : [];

  return (
    <div
      {...(inPhase ? {} : clickableDivProps(onToggle))}
      aria-pressed={inPhase ? undefined : selected}
      aria-disabled={inPhase || undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--white)',
        border: selected ? '2px solid var(--gold-deep)' : '1px solid var(--shell-border)',
        margin: selected ? 0 : 1,
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        cursor: inPhase ? 'default' : 'pointer',
        opacity: inPhase ? 0.55 : 1,
        boxShadow: hovered && !inPhase ? 'var(--shadow-floating)' : 'none',
        transition: 'box-shadow 120ms ease',
      }}
    >
      <div style={{ position: 'relative', height: 132, background: 'var(--shell-sidebar-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {imgSrc ? (
          <img
            src={pickerMediaSrc(imgSrc)}
            alt=""
            loading="lazy"
            width={132}
            height={132}
            style={{ display: 'block', width: '100%', height: 132, objectFit: 'contain', background: 'var(--white)' }}
          />
        ) : (
          <div style={{ textAlign: 'center', color: 'var(--muted-2)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--gold-deep)' }}>
              {exerciseCategoryLabel(card.category)}
            </div>
            <div style={{ fontSize: 11, marginBlockStart: 4 }}>{t('picker.card.no_media')}</div>
          </div>
        )}

        <span
          aria-hidden
          style={{
            position: 'absolute', insetBlockStart: 8, insetInlineStart: 8,
            width: 22, height: 22, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
            background: selected ? 'var(--gold-deep)' : 'var(--white)',
            color: selected ? 'var(--cream)' : 'transparent',
            border: selected ? 'none' : '1.5px solid var(--line-input)',
          }}
        >
          ✓
        </span>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onFavorite(); }}
          onKeyDown={(e) => e.stopPropagation()}
          aria-pressed={favorite}
          aria-label={favorite ? t('picker.card.favorite.remove') : t('picker.card.favorite.add')}
          title={favorite ? t('picker.card.favorite.remove') : t('picker.card.favorite.add')}
          style={{
            position: 'absolute', insetBlockStart: 6, insetInlineEnd: 6,
            width: 28, height: 28, borderRadius: '50%',
            border: '1px solid var(--line-soft)', background: 'var(--white)',
            color: favorite ? 'var(--gold)' : 'var(--muted-2)',
            fontSize: 16, lineHeight: 1, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {favorite ? '★' : '☆'}
        </button>

        {imgSrc && !card.media_verified && (
          <span style={{ position: 'absolute', insetBlockEnd: 6, insetInlineStart: 6, ...tagStyle, color: 'var(--flag-red)', borderColor: 'var(--flag-red)' }}>
            {t('picker.card.unverified')}
          </span>
        )}
        {inPhase && (
          <span style={{ position: 'absolute', insetBlockEnd: 6, insetInlineEnd: 6, ...tagStyle }}>
            {t('picker.card.in_phase')}
          </span>
        )}
      </div>

      <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>
            {card.name}
          </div>
          {card.name_en && card.name_en !== card.name && (
            <div style={{ fontSize: 11, color: 'var(--muted-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {card.name_en}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span style={chipStyle}>{exerciseCategoryLabel(card.category)}</span>
          {card.equipment.slice(0, 1).map((e) => (
            <span key={e} style={{ ...chipStyle, background: 'var(--line-soft)', color: 'var(--ink-soft)' }}>{equipmentLabel(e)}</span>
          ))}
          {card.body_region && <span style={{ ...chipStyle, background: 'var(--line-soft)', color: 'var(--ink-soft)' }}>{card.body_region.name}</span>}
        </div>

        {reasons.length > 0 && (
          <div title={reasons.map(formatRecommendReason).join('\n')} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {reasons.slice(0, 2).map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: 'var(--gold-deep)', lineHeight: 1.4 }}>
                ✦ {formatRecommendReason(r)}
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBlockStart: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{rx ?? ''}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDetails(); }}
            onKeyDown={(e) => e.stopPropagation()}
            style={{ background: 'transparent', border: '1px solid var(--shell-border)', borderRadius: 'var(--radius-pill)', padding: '3px 10px', fontSize: 11, color: 'var(--ink-soft)', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 }}
          >
            {t('picker.card.details')}
          </button>
        </div>
      </div>
    </div>
  );
}

const chipStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 7px',
  borderRadius: 'var(--radius-pill)',
  background: 'var(--nav-active-bg)',
  color: 'var(--gold-deep)',
  whiteSpace: 'nowrap',
};

const tagStyle: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.04em',
  padding: '2px 6px',
  borderRadius: 5,
  background: 'var(--white)',
  color: 'var(--ink-soft)',
  border: '1px solid var(--line)',
};
