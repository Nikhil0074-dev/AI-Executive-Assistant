import crypto from 'node:crypto';
import type { AuditEntry, InvitationDraft, Participant, SchedulingRequest, User } from './types';

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/**
 * In-memory repository. The relational model for production (PostgreSQL + Prisma)
 * lives in database/prisma/schema.prisma; swap this class for Prisma-backed
 * repositories without touching the services.
 */
export class Store {
  users = new Map<string, User>();
  participants = new Map<string, Participant>();
  requests = new Map<string, SchedulingRequest>();
  drafts = new Map<string, InvitationDraft>();
  audit: AuditEntry[] = [];

  userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }
  participantsOf(userId: string) {
    return [...this.participants.values()].filter((p) => p.ownerId === userId);
  }
  log(userId: string, action: string, resourceType: string, resourceId: string, status: 'ok' | 'error' = 'ok', metadata?: Record<string, unknown>) {
    this.audit.push({ id: newId('aud'), userId, action, resourceType, resourceId, status, timestamp: Date.now(), metadata });
  }
}
