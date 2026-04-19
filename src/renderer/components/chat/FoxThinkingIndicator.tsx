import React from 'react';
import './FoxThinkingIndicator.css';

function animClass(names: string, animated: boolean): string | undefined {
  return animated ? names : undefined;
}

/** Shared low-poly fox face; `animated` toggles CSS keyframes from FoxThinkingIndicator.css */
export const FoxFaceGraphic: React.FC<{ animated: boolean }> = ({ animated }) => (
  <>
    {/* HEAD BASE */}
    <polygon className={animClass('fox-facet-top', animated)} points="216,156 340,172 464,156 490,320 432,462 340,486 248,462 190,320" fill="#D4731A" />

    {/* FOREHEAD */}
    <polygon className={animClass('fox-facet-top fox-ear-left', animated)} points="216,156 248,254 294,244 340,172" fill="#EFA03C" />
    <polygon className={animClass('fox-facet-top fox-ear-right', animated)} points="464,156 432,254 386,244 340,172" fill="#EFA03C" />
    <polygon className={animClass('fox-facet-top', animated)} points="248,254 432,254 386,244 340,172 294,244" fill="#EFA03C" />

    {/* EAR INNERS */}
    <polygon className={animClass('fox-ear-left', animated)} points="224,164 252,248 294,244" fill="#F2C898" />
    <polygon className={animClass('fox-ear-right', animated)} points="456,164 428,248 386,244" fill="#F2C898" />

    {/* GOLDEN SLIVER */}
    <polygon className={animClass('fox-facet-top', animated)} points="324,172 356,172 350,252 340,282 330,252" fill="#F8CA52" fillOpacity="0.52" />

    {/* DARK MASKS */}
    <polygon points="190,320 248,254 292,312 266,428 248,462" fill="#180A02" />
    <polygon points="490,320 432,254 388,312 414,428 432,462" fill="#180A02" />

    {/* CENTER FACE */}
    <polygon className={animClass('fox-facet-center', animated)} points="248,254 432,254 388,312 292,312" fill="#EFA03C" />

    {/* LOWER CENTER */}
    <polygon className={animClass('fox-facet-lower', animated)} points="292,312 388,312 398,384 282,384" fill="#E09030" />

    {/* MUZZLE */}
    <polygon className={animClass('fox-facet-muzzle', animated)} points="282,384 398,384 408,452 340,474 272,452" fill="#F2E0C6" />

    {/* EYES */}
    <g className={animClass('fox-eye-left', animated)}>
      <polygon points="248,254 292,278 254,300 218,278" fill="#0E0502" />
    </g>
    <g className={animClass('fox-eye-right', animated)}>
      <polygon points="432,254 388,278 426,300 462,278" fill="#0E0502" />
    </g>

    {/* EYE SHINES */}
    <g className={animClass('fox-shine-l', animated)}>
      <circle cx="257" cy="274" r="7" fill="#FFFFFF" fillOpacity="0.88" />
      <circle cx="254" cy="271" r="2.5" fill="#FFFFFF" />
    </g>
    <g className={animClass('fox-shine-r', animated)}>
      <circle cx="423" cy="274" r="7" fill="#FFFFFF" fillOpacity="0.88" />
      <circle cx="420" cy="271" r="2.5" fill="#FFFFFF" />
    </g>

    {/* NOSE */}
    <ellipse cx="340" cy="416" rx="12" ry="8" fill="#140804" />
    <ellipse cx="337" cy="413" rx="4" ry="2.8" fill="#FFFFFF" fillOpacity="0.28" />
  </>
);

/**
 * Static fox mark used in inline UI like the Thinking chip.
 * - `solid`: render as a single-color silhouette (defaults to currentColor) so
 *   it can pick up surrounding text color, matching other inline icons.
 */
export const FoxChipIcon: React.FC<{
  size?: number;
  className?: string;
  solid?: boolean;
  color?: string;
}> = ({ size = 14, className, solid = false, color }) => (
  // The full FoxFaceGraphic only occupies x:[190..490], y:[156..486] of a
  // 680x680 viewBox, so a tight viewBox makes the head fill the requested
  // pixel size instead of being lost in whitespace at chip dimensions.
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="178 144 324 354"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    {solid ? <FoxSolidSilhouette color={color} /> : <FoxFaceGraphic animated={false} />}
  </svg>
);

/**
 * Single-color (solid) version of the fox face. Uses outline of the head plus
 * negative-space cutouts (eyes + nose) for legibility at small sizes.
 */
const FoxSolidSilhouette: React.FC<{ color?: string }> = ({ color }) => {
  const fill = color ?? 'currentColor';
  return (
    <g fill={fill}>
      {/* Head outline (same hull as the colored version) */}
      <polygon points="216,156 340,172 464,156 490,320 432,462 340,486 248,462 190,320" />
      {/* Eye cutouts: punch through with the parent background by drawing
          inverse via a subtractive mask. SVG can't do CSS blend reliably
          everywhere, so use opacity-0 placeholders and overlay shapes in
          the page background color via fill-opacity. We approximate with
          contrasting shapes instead — small enough to read as a fox. */}
      <polygon points="248,254 292,278 254,300 218,278" fill="#0E0502" />
      <polygon points="432,254 388,278 426,300 462,278" fill="#0E0502" />
      <ellipse cx="340" cy="416" rx="14" ry="10" fill="#0E0502" />
    </g>
  );
};

export interface FoxThinkingIndicatorProps {
  size?: 'large' | 'small';
}

export const FoxThinkingIndicator: React.FC<FoxThinkingIndicatorProps> = ({ size = 'large' }) => {
  const isLarge = size === 'large';
  const svgSize = isLarge ? 80 : 44;

  return (
    <div
      className={`fox-thinking-indicator ${isLarge ? '' : 'fox-thinking-indicator--sm'}`}
      aria-label="Thinking"
      role="status"
    >
      <div className="fox-wrap" style={{ width: svgSize, height: svgSize }}>
        {isLarge && <div className="fox-glow-ring" />}
        <svg
          className="fox-svg"
          width={svgSize}
          height={svgSize}
          viewBox="0 0 680 680"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <FoxFaceGraphic animated />
        </svg>
      </div>

      {/* Thinking dots */}
      <div className="fox-dots">
        <div className="fox-dot" />
        <div className="fox-dot" />
        <div className="fox-dot" />
      </div>

      {/* Thinking label — large variant only */}
      {isLarge && <span className="fox-label">Thinking</span>}
    </div>
  );
};

export default FoxThinkingIndicator;
