import type { CSSProperties } from 'react';
export const iconNames = ['arrow-left','arrow-right','ban-circle','bell','building','calendar','camera','chat','chevron-down','circle-check','circle-half','circle-question','circle-x','clipboard','clock','clock-arrow','close','coins','connected-nodes','document-signature','download','ellipsis','fan','folder','funnel','gear','inbox','key','layers','ledger','link','mail','map-pin','menu','microphone','package','paperclip','pause-circle','pencil','phone','plug','plus','receipt','repeat-arrows','return-arrow','scales','search','shield-lock','split-route','triangle-alert','truck','upload','user-cog','users','wallet'] as const;
export type IconName = typeof iconNames[number];
export function Icon({ name, className = '', size = 20 }: { name: IconName; className?: string; size?: number }) {
  return <span aria-hidden="true" className={`icon ${className}`} style={{ width: size, height: size, maskImage: `url(/icons/${name}.svg)` } as CSSProperties} />;
}
