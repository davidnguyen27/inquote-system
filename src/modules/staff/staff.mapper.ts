import type { EmployeeRecord } from "./staff.repository.js";
import { staffETag } from "../auth/security.js";

export class StaffMapper {
  constructor(private readonly epoch: string) {}
  read(staff: EmployeeRecord) {
    return { id: staff.id, displayName: staff.displayName, email: staff.normalizedEmail,
      role: staff.role, enabled: staff.enabled, mustChangePassword: staff.mustChangePassword,
      temporaryCredentialExpiresAt: staff.temporaryCredentialExpiresAt?.toISOString() ?? null,
      etag: staffETag(staff.id, staff.revision, this.epoch),
      createdAt: staff.createdAt.toISOString(), updatedAt: staff.updatedAt.toISOString() };
  }
}
