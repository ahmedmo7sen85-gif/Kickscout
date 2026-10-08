import type { FastifyBaseLogger } from 'fastify';

export interface Mailer {
  sendGuardianInvitation(to: string, minorDisplayName: string, acceptToken: string, locale: 'en' | 'ar'): Promise<void>;
  sendOrganizationInvitation(to: string, organizationName: string, role: string, acceptToken: string, locale: 'en' | 'ar'): Promise<void>;
}

/**
 * Development mailer: writes the message to the log instead of sending it. Config refuses it in
 * production. The production mailer (SES) is not built yet.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  async sendGuardianInvitation(to: string, minorDisplayName: string, acceptToken: string, locale: 'en' | 'ar') {
    this.log.info({ mail: 'guardian_invitation', to, minorDisplayName, acceptToken, locale }, 'DEV MAILER: email not sent');
  }

  async sendOrganizationInvitation(to: string, organizationName: string, role: string, acceptToken: string, locale: 'en' | 'ar') {
    this.log.info({ mail: 'organization_invitation', to, organizationName, role, acceptToken, locale }, 'DEV MAILER: email not sent');
  }
}
