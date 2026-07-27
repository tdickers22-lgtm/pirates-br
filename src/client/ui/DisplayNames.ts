/**
 * The Reach's own vocabulary — now owned by `src/shared/DisplayNames.ts`.
 *
 * It moved because the SERVER writes rendered strings too (the island cast's
 * names, cutscene cards and spoken lines are authored in MapGenerator), and a
 * client-only module left the server no way to say "the Black Fin" except by
 * hardcoding its own copy. This file stays as the client's front door so every
 * existing `../ui/DisplayNames.js` import keeps working.
 */
export * from '../../shared/DisplayNames.js';
