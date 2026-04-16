import React from 'react';
import './FoxThinkingIndicator.css';

export interface FoxThinkingIndicatorProps {
  size?: 'large' | 'small';
}

export const FoxThinkingIndicator: React.FC<FoxThinkingIndicatorProps> = ({ size = 'large' }) => {
  const svgSize = size === 'large' ? 80 : 44;

  return (
    <div
      className="fox-thinking-indicator"
      aria-label="Thinking"
      role="status"
    >
      <svg
        width={svgSize}
        height={svgSize}
        viewBox="0 0 200 200"
        aria-hidden="true"
      >
        {/* Main body group with breathing animation */}
        <g className="fox-breathe">

          {/* --- Head facets (shimmer groups with staggered delays) --- */}

          {/* Group 1: Base head shape — primary fur */}
          <g className="fox-facet-shimmer" style={{ animationDelay: '0s' }}>
            {/* Left head */}
            <polygon points="60,90 100,55 100,130" fill="#D4731A" />
            {/* Right head */}
            <polygon points="140,90 100,55 100,130" fill="#D4731A" />
            {/* Lower left jaw */}
            <polygon points="60,90 100,130 75,135" fill="#D4731A" />
            {/* Lower right jaw */}
            <polygon points="140,90 100,130 125,135" fill="#D4731A" />
          </g>

          {/* Group 2: Secondary highlight facets */}
          <g className="fox-facet-shimmer" style={{ animationDelay: '0.4s' }}>
            {/* Left cheek highlight */}
            <polygon points="65,95 100,70 85,115" fill="#EFA03C" />
            {/* Right cheek highlight */}
            <polygon points="135,95 100,70 115,115" fill="#EFA03C" />
          </g>

          {/* Group 3: Tertiary light accent facets */}
          <g className="fox-facet-shimmer" style={{ animationDelay: '0.8s' }}>
            {/* Forehead accent */}
            <polygon points="85,68 100,55 115,68 100,80" fill="#F2C898" />
            {/* Left muzzle */}
            <polygon points="85,115 100,130 92,135" fill="#F2C898" />
            {/* Right muzzle */}
            <polygon points="115,115 100,130 108,135" fill="#F2C898" />
          </g>

          {/* Group 4: Additional primary facets */}
          <g className="fox-facet-shimmer" style={{ animationDelay: '1.2s' }}>
            {/* Left temple */}
            <polygon points="60,90 75,70 85,90" fill="#D4731A" />
            {/* Right temple */}
            <polygon points="140,90 125,70 115,90" fill="#D4731A" />
          </g>

          {/* Group 5: Secondary lower facets */}
          <g className="fox-facet-shimmer" style={{ animationDelay: '1.6s' }}>
            {/* Chin */}
            <polygon points="92,135 100,145 108,135" fill="#EFA03C" />
          </g>

          {/* --- Ears --- */}

          {/* Left ear */}
          <g className="fox-ear-wiggle" style={{ animationDelay: '0s', transformOrigin: '75px 70px' }}>
            <polygon points="60,90 50,40 80,65" fill="#D4731A" />
            <polygon points="58,75 53,45 75,63" fill="#EFA03C" />
            <polygon points="56,60 55,48 68,58" fill="#F2C898" />
          </g>

          {/* Right ear */}
          <g className="fox-ear-wiggle" style={{ animationDelay: '0.3s', transformOrigin: '125px 70px' }}>
            <polygon points="140,90 150,40 120,65" fill="#D4731A" />
            <polygon points="142,75 147,45 125,63" fill="#EFA03C" />
            <polygon points="144,60 145,48 132,58" fill="#F2C898" />
          </g>

          {/* --- Eyes --- */}

          {/* Left eye */}
          <g className="fox-eye-blink" style={{ transformOrigin: '82px 98px' }}>
            {/* Eye white */}
            <ellipse cx="82" cy="98" rx="8" ry="6" fill="#FFFFFF" />
            {/* Pupil */}
            <ellipse cx="83" cy="98" rx="4" ry="5" fill="#1a1a1a" />
            {/* Shine highlight */}
            <ellipse className="fox-eye-shine" cx="85" cy="96" rx="2" ry="1.5" fill="#F2C898" />
          </g>

          {/* Right eye */}
          <g className="fox-eye-blink" style={{ transformOrigin: '118px 98px' }}>
            {/* Eye white */}
            <ellipse cx="118" cy="98" rx="8" ry="6" fill="#FFFFFF" />
            {/* Pupil */}
            <ellipse cx="117" cy="98" rx="4" ry="5" fill="#1a1a1a" />
            {/* Shine highlight */}
            <ellipse className="fox-eye-shine" cx="115" cy="96" rx="2" ry="1.5" fill="#F2C898" />
          </g>

          {/* --- Nose --- */}
          <polygon points="96,120 100,115 104,120 100,123" fill="#1a1a1a" />

          {/* --- Mouth line --- */}
          <line x1="100" y1="123" x2="100" y2="130" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="95" y1="130" x2="100" y2="130" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="100" y1="130" x2="105" y2="130" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      </svg>
    </div>
  );
};

export default FoxThinkingIndicator;
