// The language AI answers are written in. Only these reach a prompt, since the
// value comes from a setting.
export const OUTPUT_LANGUAGES = Object.freeze(['Hebrew', 'English', 'Arabic', 'Russian']);
const DEFAULT_LANGUAGE = 'Hebrew';

export function outputLanguage(config) {
  const language = config?.ai?.outputLanguage;
  return OUTPUT_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
}
