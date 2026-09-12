import { avatarLook } from '../../lib/avatar';
import { cx } from '../../lib/cx';
import { initials } from '../../lib/format';

/**
 * A player's face.
 *
 * Drawn from the seed, never rolled — the same player looks the same at every
 * table, on every device, with nothing stored but a short string. The initials
 * sit on top so a table of strangers is still readable when four of them happen
 * to hash to similar colours.
 */
export interface AvatarProps {
  readonly seed: string | null;
  readonly name: string;
  readonly size?: number;
  readonly className?: string;
}

export function Avatar({ seed, name, size = 44, className }: AvatarProps) {
  const look = avatarLook(seed);

  return (
    <span
      aria-hidden
      style={{ width: size, height: size, background: look.background }}
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        'rounded-full ring-1 ring-white/20',
        className,
      )}
    >
      <Backdrop shape={look.shape} color={look.foreground} />
      <span
        style={{ fontSize: size * 0.36 }}
        className="relative font-semibold text-white/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
      >
        {initials(name)}
      </span>
    </span>
  );
}

/** Four shapes, so seeds that land on nearby hues still look different. */
function Backdrop({ shape, color }: { shape: number; color: string }) {
  const common = { fill: color, opacity: 0.45 };

  return (
    <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
      {shape === 0 ? <circle cx="50" cy="100" r="52" {...common} /> : null}
      {shape === 1 ? <polygon points="0,100 50,20 100,100" {...common} /> : null}
      {shape === 2 ? <rect x="-10" y="58" width="120" height="60" {...common} /> : null}
      {shape === 3 ? (
        <>
          <circle cx="18" cy="22" r="26" {...common} />
          <circle cx="86" cy="78" r="34" {...common} />
        </>
      ) : null}
    </svg>
  );
}
