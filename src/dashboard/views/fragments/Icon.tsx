/**
 * Server-side Lucide icon rendering
 *
 * Renders SVG icons directly on the server to avoid client-side JavaScript overhead.
 * Icons are imported from lucide-static and rendered as raw SVG strings.
 */

import { raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  AlignLeft,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleCheck,
  CirclePause,
  CirclePlay,
  Clock,
  Cloud,
  Compass,
  Folder,
  GitCompareArrows,
  Heart,
  House,
  Info,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-static';

// Map kebab-case icon names to their SVG strings
const iconMap: Record<string, string> = {
  'align-left': AlignLeft,
  'alert-triangle': AlertTriangle,
  'arrow-right': ArrowRight,
  check: Check,
  'chevron-right': ChevronRight,
  'circle-check': CircleCheck,
  'circle-pause': CirclePause,
  'circle-play': CirclePlay,
  clock: Clock,
  cloud: Cloud,
  compass: Compass,
  folder: Folder,
  'git-compare-arrows': GitCompareArrows,
  heart: Heart,
  house: House,
  info: Info,
  'loader-circle': LoaderCircle,
  pause: Pause,
  play: Play,
  plus: Plus,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  'sliders-horizontal': SlidersHorizontal,
  square: Square,
  star: Star,
  'trash-2': Trash2,
  'triangle-alert': TriangleAlert,
  x: X,
  zap: Zap,
};

export type IconName = keyof typeof iconMap;

interface IconProps {
  name: IconName;
  class?: string;
  size?: number;
}

/**
 * Renders a Lucide icon as an inline SVG.
 *
 * @param name - The icon name in kebab-case (e.g., 'refresh-cw', 'circle-check')
 * @param class - Optional CSS classes to add to the SVG element
 * @param size - Optional size in pixels (sets both width and height)
 */
export function Icon({ name, class: className, size }: IconProps): HtmlEscapedString {
  const svg = iconMap[name];
  if (!svg) {
    console.warn(`[Icon] Unknown icon: ${name}`);
    return raw('');
  }

  // Build attributes to inject into the SVG
  const attrs: string[] = [];
  if (className) {
    attrs.push(`class="${className}"`);
  }
  if (size) {
    attrs.push(`width="${size}" height="${size}"`);
  }

  // Inject attributes after the opening <svg tag
  if (attrs.length > 0) {
    return raw(svg.replace('<svg', `<svg ${attrs.join(' ')}`));
  }

  return raw(svg);
}

// Also export as a raw function for simpler interpolation in templates
export function icon(name: IconName, className?: string, size?: number): HtmlEscapedString {
  return Icon({ name, class: className, size });
}
