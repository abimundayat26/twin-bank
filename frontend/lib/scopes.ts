/**
 * Names for the control that started an in-flight twin update.
 *
 * Only the control whose scope is saving shows "Saving…", so a save in the goal
 * composer does not put every other button into a waiting state. Ids (a goal's,
 * an obligation's) are used directly; these two constants name the controls that
 * have no natural id of their own.
 *
 * They live in `lib` rather than beside their components so the state provider
 * can use them without importing a component.
 */

export const MINIMUM_BALANCE_SCOPE = "minimum-balance";
export const GOALS_SCOPE = "declared-goals";
