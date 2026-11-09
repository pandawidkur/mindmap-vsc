import type { Theme } from 'mind-elixir';

const FALLBACK_PALETTE = ['#3794ff', '#b180d7', '#89d185', '#d18616', '#f14c4c', '#cca700'];
const PALETTE_VARIABLES = [
  '--vscode-charts-blue',
  '--vscode-charts-purple',
  '--vscode-charts-green',
  '--vscode-charts-orange',
  '--vscode-charts-red',
  '--vscode-charts-yellow',
];

function isLightTheme(): boolean {
  const { classList } = document.body;
  return classList.contains('vscode-light') || classList.contains('vscode-high-contrast-light');
}

/** Builds a map theme from the VS Code theme, whose colors the webview gets as CSS variables. */
export function buildTheme(): Theme {
  const styles = getComputedStyle(document.body);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;

  const light = isLightTheme();
  const foreground = read('--vscode-editor-foreground', light ? '#333333' : '#cccccc');
  const background = read('--vscode-editor-background', light ? '#ffffff' : '#1e1e1e');
  const widgetBackground = read('--vscode-editorWidget-background', background);
  const border = read('--vscode-widget-border', read('--vscode-contrastBorder', 'transparent'));

  return {
    name: 'VS Code',
    type: light ? 'light' : 'dark',
    palette: PALETTE_VARIABLES.map((name, i) => read(name, FALLBACK_PALETTE[i])),
    cssVar: {
      '--main-color': foreground,
      '--main-bgcolor': widgetBackground,
      '--main-bgcolor-transparent': widgetBackground,
      '--color': foreground,
      '--bgcolor': background,
      '--selected': read('--vscode-focusBorder', '#007fd4'),
      '--root-color': read('--vscode-button-foreground', '#ffffff'),
      '--root-bgcolor': read('--vscode-button-background', '#007acc'),
      '--root-border-color': 'transparent',
      '--accent-color': read('--vscode-focusBorder', '#007fd4'),
      '--panel-color': foreground,
      '--panel-bgcolor': widgetBackground,
      '--panel-border-color': border,
    },
  };
}

/** Calls back whenever VS Code switches theme, which it signals on the body element. */
export function onThemeChange(callback: () => void): void {
  new MutationObserver(callback).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-vscode-theme-id'],
  });
}
