import { getConnection } from '@/modules/database/connection.js';

type HandoffLinkRow = { session_id: string; family_id: string; provider: string };

/**
 * Which "family" (the set of sessions one conversation has ever been handed
 * off through, across every provider it visited) each session belongs to.
 * Used only by the handoff module, so that handing a conversation back to a
 * provider it already used earlier in the same family resumes that same
 * session instead of starting yet another new one each time.
 */
export const handoffLinksDb = {
  /** Records one session as a member of a family, replacing any earlier record for that session id. */
  link(sessionId: string, familyId: string, provider: string): void {
    getConnection().prepare(
      `INSERT INTO handoff_links (session_id, family_id, provider)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET family_id = excluded.family_id, provider = excluded.provider`
    ).run(sessionId, familyId, provider);
  },

  /** The family a session belongs to, or null if it was never part of a handoff. */
  getFamilyId(sessionId: string): string | null {
    const row = getConnection().prepare('SELECT family_id FROM handoff_links WHERE session_id = ?').get(sessionId) as HandoffLinkRow | undefined;
    return row?.family_id ?? null;
  },

  /** The most recently linked session for `provider` within `familyId`, or null if that provider was never part of it. */
  findMember(familyId: string, provider: string): string | null {
    const row = getConnection().prepare(
      'SELECT session_id FROM handoff_links WHERE family_id = ? AND provider = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ).get(familyId, provider) as HandoffLinkRow | undefined;
    return row?.session_id ?? null;
  },

  /** Every session ever part of this family, oldest first — the order the conversation actually moved through them. */
  listMembers(familyId: string): Array<{ sessionId: string; provider: string }> {
    const rows = getConnection().prepare(
      'SELECT session_id, provider FROM handoff_links WHERE family_id = ? ORDER BY created_at ASC, rowid ASC'
    ).all(familyId) as HandoffLinkRow[];
    return rows.map((row) => ({ sessionId: row.session_id, provider: row.provider }));
  },
};
