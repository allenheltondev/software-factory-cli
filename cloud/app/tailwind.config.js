/**
 * Colors, fonts and dark mode come from the Ready, Set, Cloud design system (@readysetcloud/ui).
 * Every color resolves through its token CSS variables. Never define colors here (see
 * node_modules/@readysetcloud/ui/AGENTS.md).
 */
import rscPreset from '@readysetcloud/ui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [rscPreset],
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    // The package's components render token utility classes. npm workspaces hoist it to cloud/.
    './node_modules/@readysetcloud/ui/dist/**/*.js',
    '../node_modules/@readysetcloud/ui/dist/**/*.js',
  ],
};
