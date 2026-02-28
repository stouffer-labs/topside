export default function TopsideIcon({ size = 16, color = '#6366f1', className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 260 310" fill={color} className={className}>
      {/* Periscope head */}
      <path d="M100,105 C100,105 100,55 130,35 C150,22 185,25 200,45 L225,95 C232,110 220,125 205,125 L155,125 L155,105 Z" />
      {/* Lens */}
      <circle cx="210" cy="72" r="32" />
      <circle cx="210" cy="72" r="20" fill="white" />
      <ellipse cx="203" cy="65" rx="7" ry="5" fill="white" opacity="0.6" />
      {/* Tube band */}
      <rect x="90" y="115" width="72" height="15" rx="3" />
      {/* Tube body */}
      <rect x="100" y="130" width="52" height="100" rx="3" />
      {/* Water waves */}
      <path d="M10,240 Q50,225 90,240 Q130,255 170,240 Q210,225 250,240" fill="none" stroke={color} strokeWidth="12" strokeLinecap="round" />
      <path d="M10,270 Q50,255 90,270 Q130,285 170,270 Q210,255 250,270" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" />
    </svg>
  );
}
