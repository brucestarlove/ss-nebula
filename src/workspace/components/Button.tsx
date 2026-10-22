import { forwardRef, type ButtonHTMLAttributes, type CSSProperties } from 'react';

/** A plain button for the workspace. ss-ui's button.css turns every bare
 * <button> into the primary chip and inverts it on press unless it carries
 * a data-variant; "ws" matches no ss-ui variant, so only the workspace's
 * classes style it (workspace.css clears the rest). */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} data-variant="ws" {...props} />;
});

type PlanetProps = { color: string; size?: number; className?: string; title?: string };

/** A project's planet: its colour, lit from the upper left. */
export function Planet({ color, size, className, title }: PlanetProps) {
  const style = { '--planet': color, ...(size ? { '--size': `${size}px` } : {}) } as CSSProperties;
  return <span className={['ws-planet', className ?? ''].filter(Boolean).join(' ')} style={style} aria-hidden="true" title={title} />;
}
