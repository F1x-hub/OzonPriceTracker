export const DEFAULT_THEME = 'light';

export function normalizeTheme(value) {
  return value === 'dark' ? 'dark' : DEFAULT_THEME;
}

export function applyTheme(theme) {
  const normalizedTheme = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalizedTheme;
  document.documentElement.style.colorScheme = normalizedTheme;
  return normalizedTheme;
}
