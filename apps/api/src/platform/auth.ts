import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

/** Who the identity provider says the caller is. Authorization is decided separately, in policy. */
export interface Identity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  mfa: boolean;
}

export interface TokenVerifier {
  verify(token: string): Promise<Identity>;
}

/** Verifies access tokens issued by the managed identity provider against its JWKS. */
export class JwtVerifier implements TokenVerifier {
  constructor(
    private readonly keys: JWTVerifyGetKey,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  static remote(jwksUrl: string, issuer: string, audience: string) {
    return new JwtVerifier(createRemoteJWKSet(new URL(jwksUrl)), issuer, audience);
  }

  async verify(token: string): Promise<Identity> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256', 'ES256'],
    });
    if (!payload.sub) throw new Error('token has no subject');
    // amr is a list of strings (OIDC) or of {method} objects (Supabase Auth); Supabase also sets aal.
    const amr = (Array.isArray(payload.amr) ? (payload.amr as unknown[]) : [])
      .map((m) => (typeof m === 'string' ? m : typeof m === 'object' && m && 'method' in m ? String((m as { method: unknown }).method) : ''));
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true || meta.email_verified === true,
      mfa: payload.aal === 'aal2' || amr.some((m) => ['mfa', 'otp', 'totp', 'hwk'].includes(m)),
    };
  }
}
