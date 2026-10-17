import { contactKey } from './contact.js';

/**
 * Removing everything we hold for one Zoom user.
 *
 * Called when a user uninstalls the app and Zoom tells us not to retain their
 * data. The synced settings and the card artwork are theirs, and the Zoom
 * account email and name (worker/contact.js) came from Zoom, which requires
 * deleting it after deauthorization; all three go. The Stripe customer link
 * and any subscription record are ours (billing history we are obliged to
 * keep), so those stay.
 *
 * Every step is best-effort and independent: a failed R2 delete must not stop
 * the KV deletes, and vice versa.
 *
 * @param {Object} env - PROFILES, CARD_ASSETS
 * @param {string} uid
 * @returns {Promise<{profileDeleted: boolean, assetsDeleted: number, contactDeleted: boolean}>}
 */
export async function purgeUserData(env, uid) {
  const result = { profileDeleted: false, assetsDeleted: 0, contactDeleted: false };
  if (!uid) return result;

  if (env.PROFILES) {
    try {
      await env.PROFILES.delete(`profile:zoom:${uid}`);
      result.profileDeleted = true;
    } catch (error) {
      console.error('Failed to delete profile for', uid, error?.message || error);
    }
  }

  if (env.CARD_ASSETS) {
    try {
      let cursor;
      do {
        const listed = await env.CARD_ASSETS.list({ prefix: `card/${uid}/`, cursor });
        const keys = listed.objects.map((o) => o.key);
        if (keys.length) {
          await env.CARD_ASSETS.delete(keys);
          result.assetsDeleted += keys.length;
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } catch (error) {
      console.error('Failed to delete card assets for', uid, error?.message || error);
    }
  }

  if (env.PROFILES) {
    try {
      await env.PROFILES.delete(contactKey(uid));
      result.contactDeleted = true;
    } catch (error) {
      console.error('Failed to delete contact for', uid, error?.message || error);
    }
  }

  return result;
}
