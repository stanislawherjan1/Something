// The usage-limit sentence in each language a reader may get it in
// (lib/usage-limit.js limitNotice) — an i18n table, the one place another
// language is allowed in code. `who` is the bot's name, `at` the hour or null.
export const NOTICE = {
  en: (who, at) => (at ? `Claude usage limit reached. ${who} is back at ${at}.` : `Claude usage limit reached. ${who} is back once the plan renews.`),
  pl: (who, at) => (at ? `Wyczerpał się limit Claude. ${who} wraca o ${at}.` : `Wyczerpał się limit Claude. ${who} wróci, gdy limit się odnowi.`),
};
// The name when the bot has none set.
export const UNNAMED = { en: 'The assistant', pl: 'Asystent' };
