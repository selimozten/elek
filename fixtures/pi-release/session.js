export function getSessionForTenant(sessions, sessionId, tenantId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return session;
}
