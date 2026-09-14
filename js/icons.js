// ============================================================================
//  icons.js — the app's own line icons.
//
//  Drawn on one 24-grid with one stroke weight, so every screen reads as the
//  same hand. They take their colour from the text around them, which is what
//  makes them work on a white sidebar, a dark one, and a blue selected chip
//  without a second copy of anything.
// ============================================================================

const P = {
  // ---- navigation -------------------------------------------------------
  home:        'M3 10.2 12 3l9 7.2M5.6 8.9V20h12.8V8.9M9.8 20v-6.2h4.4V20',
  ledger:      'M4.5 3.8h13a2 2 0 0 1 2 2v14.4H6.5a2 2 0 0 1-2-2V3.8ZM4.5 17.2h15M8.2 7.6h7.6M8.2 11.2h7.6',
  receipt:     'M5.5 2.8v18.4l2.2-1.6 2.2 1.6 2.1-1.6 2.2 1.6 2.3-1.6V2.8H5.5ZM8.6 7.4h6.8M8.6 11.4h6.8M8.6 15.2h4',
  arrowOut:    'M12 21V4M12 4 6.2 9.9M12 4l5.8 5.9',
  arrowIn:     'M12 3v17M12 20l5.8-5.9M12 20l-5.8-5.9',
  scales:      'M12 4.4v16.2M8.4 20.6h7.2M4.6 7.6h14.8M12 4.4 4.6 7.6M12 4.4l7.4 3.2M4.6 7.6 2 14.2h5.2L4.6 7.6ZM19.4 7.6 16.8 14.2H22l-2.6-6.6M2 14.2a2.6 2.6 0 0 0 5.2 0M16.8 14.2a2.6 2.6 0 0 0 5.2 0',
  bars:        'M4 20.2h16M7.4 20.2v-6.6M12 20.2V6.6M16.6 20.2v-9.4',
  trendUp:     'M3.6 16.6 9 11.2l3.6 3.6 7.2-7.2M14.6 7.6h5.2v5.2',
  bank:        'M3 9.6 12 4l9 5.6M4.6 9.6h14.8M6.4 12v6M10.2 12v6M13.8 12v6M17.6 12v6M4 20.4h16',
  shield:      'M12 3.2 5 6v6c0 4.2 2.9 7.3 7 8.8 4.1-1.5 7-4.6 7-8.8V6l-7-2.8Z',
  card:        'M3.2 6.4h17.6a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V7.4a1 1 0 0 1 1-1ZM2.2 10.4h19.6M5.6 14.4h3.2',
  target:      'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 11.2a.8.8 0 1 0 0 1.6.8.8 0 0 0 0-1.6Z',
  bell:        'M12 3.2a5.6 5.6 0 0 0-5.6 5.6c0 5-2.2 6.4-2.2 6.4h15.6s-2.2-1.4-2.2-6.4A5.6 5.6 0 0 0 12 3.2ZM10.3 18.6a2 2 0 0 0 3.4 0',
  gear:        'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8ZM19.1 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1.1v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1 1.5 1.5 0 0 0-1.6.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.5h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1-2.6 1.5 1.5 0 0 0-.3-1.6l-.1-.1A1.8 1.8 0 1 1 6.5 3.6l.1.1a1.5 1.5 0 0 0 1.7.3H8.4a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.5 1.1 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9Z',

  // ---- entry types ------------------------------------------------------
  // Money out and money in: the same circle, the arrow the other way round.
  // A pair has to be read as a pair at a glance, or the picker is a guess.
  spend:       'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM9.2 14.8 15 9M10.4 8.8H15v4.6',
  earn:        'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM14.8 9.2 9 15M13.6 15.2H9v-4.6',
  swap:        'M4.4 8.8h13.2M14.2 5.4l3.4 3.4-3.4 3.4M19.6 15.2H6.4M9.8 11.8l-3.4 3.4 3.4 3.4',
  // Lend / borrow is about people, not gestures — a handshake turns to mush at
  // 20px, two figures do not.
  hands:       'M9 11.4a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM2.6 19.8c0-3.1 2.6-5.2 6.4-5.2s6.4 2.1 6.4 5.2M16.2 5.4a3.2 3.2 0 0 1 0 6.2M18.2 14.9c2.1.6 3.4 2.1 3.4 4.2',
  chartUp:     'M3.6 16.8 9 11.4l3.6 3.6 7.2-7.2M14.6 7.8h5.2V13M3.6 20.4h16.8',
  flag:        'M6 20.6V3.8M6 4.6h11.6l-2.4 4 2.4 4H6',

  // ---- small marks ------------------------------------------------------
  plus:        'M12 5.2v13.6M5.2 12h13.6',
  download:    'M12 3.8v11.4M12 15.2l4.4-4.4M12 15.2 7.6 10.8M4.4 19.4h15.2',
  refresh:     'M20 11.2A8 8 0 0 0 6.3 6.3L4 8.6M4 12.8a8 8 0 0 0 13.7 4.9l2.3-2.3M4 4.6v4h4M20 19.4v-4h-4',
  search:      'M11 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6ZM15.9 15.9l4 4',
  trash:       'M4.4 6.6h15.2M9.4 6.6V4.4h5.2v2.2M6.6 6.6l1 13a1 1 0 0 0 1 1h6.8a1 1 0 0 0 1-1l1-13M10.2 10.4v6.4M13.8 10.4v6.4',
  lock:        'M6.6 10.6h10.8a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1v-7.4a1 1 0 0 1 1-1ZM8.4 10.6V7.8a3.6 3.6 0 0 1 7.2 0v2.8',
  id:          'M3.2 5.4h17.6a1 1 0 0 1 1 1v11.2a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V6.4a1 1 0 0 1 1-1ZM8.4 12.4a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5.2 16.2c.4-1.6 1.7-2.4 3.2-2.4s2.8.8 3.2 2.4M14.6 9.6h4.2M14.6 12.6h4.2M14.6 15.4h2.6',
  doc:         'M6.4 2.8h7L18.6 8v13.2H6.4V2.8ZM13.4 2.8V8h5.2M9 12.6h6M9 16h6',
  clock:       'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 7.4V12l3.2 2',
  menu:        'M4 7h16M4 12h16M4 17h16',
  // Half filled, half not — the two themes, in one mark.
  theme:       'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2ZM12 3.4v17.2a8.6 8.6 0 0 0 0-17.2Z',
  signout:     'M9.4 20.4H5.6a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4h3.8M15.2 16.4l4.6-4.4-4.6-4.4M19.8 12H9.4',
  checkbox:    'M9 12.4l2.2 2.2 4.4-4.4M5.6 3.8h12.8a1.8 1.8 0 0 1 1.8 1.8v12.8a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8V5.6a1.8 1.8 0 0 1 1.8-1.8Z',
  snooze:      'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM9.4 9.4h5.2L9.4 14.6h5.2',
  archive:     'M3.4 4.6h17.2v4H3.4v-4ZM5 8.6v9.8a1.6 1.6 0 0 0 1.6 1.6h10.8a1.6 1.6 0 0 0 1.6-1.6V8.6M9.8 12.4h4.4',
  link:        'M10 13.6a3.6 3.6 0 0 0 5.4.4l2.8-2.8a3.6 3.6 0 0 0-5.1-5.1l-1.6 1.6M14 10.4a3.6 3.6 0 0 0-5.4-.4l-2.8 2.8a3.6 3.6 0 0 0 5.1 5.1l1.6-1.6',
  calendar:    'M4.6 5.6h14.8a1 1 0 0 1 1 1v12.8a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V6.6a1 1 0 0 1 1-1ZM3.6 10.2h16.8M8.4 3.4v4.4M15.6 3.4v4.4',
  sound:       'M11 4.8 6.6 8.6H3.2v6.8h3.4L11 19.2V4.8ZM15.2 9.2a4 4 0 0 1 0 5.6M18.2 6.4a8 8 0 0 1 0 11.2',
  phone:       'M7.4 2.8h9.2a1.6 1.6 0 0 1 1.6 1.6v15.2a1.6 1.6 0 0 1-1.6 1.6H7.4a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6ZM10.6 18.4h2.8',
  // Stands in for anything the set has no mark for yet, so a missing name
  // shows as a neutral dot rather than an empty hole.
  dot:         'M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z',
};

/** The handful of marks that read better solid than hollow. */
const FILLED = new Set(['dotFill']);
P.dotFill = 'M12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z';

/**
 * One icon, as an inline SVG that inherits the colour and size around it.
 * `size` is in px; everything else — colour, alignment — comes from CSS.
 */
export function icon(name, size = 20) {
  const d = P[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', FILLED.has(name) ? 'currentColor' : 'none');
  svg.setAttribute('stroke', FILLED.has(name) ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  if (!d) return svg;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export const ICON_NAMES = Object.keys(P);
