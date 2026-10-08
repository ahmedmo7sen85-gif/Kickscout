/**
 * The one typed client for the KICKSCOUT API. Every request goes through `request()`, which attaches
 * the Supabase access token as a Bearer token and turns RFC 9457 problem responses into `ApiError`.
 * Authorization is the API's job: this client only reports what the server decided.
 */
import { publicEnv } from './env';
import type * as T from './types';

export type ProblemLike = Pick<T.Problem, 'status' | 'code' | 'title'> & Partial<T.Problem>;

/** Codes the UI explains with dedicated copy (see i18n `errors`). */
export const KNOWN_ERROR_CODES = [
  'CONSENT_REQUIRED', 'GUARDIAN_REQUIRED', 'SCOUT_VERIFICATION_REQUIRED', 'CONTACT_NOT_ALLOWED', 'MFA_REQUIRED',
  'NOT_REGISTERED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'ROLE_REQUIRED', 'VALIDATION_FAILED', 'HANDLE_TAKEN',
  'UNDER_MINIMUM_AGE', 'ALREADY_REGISTERED', 'ACCOUNT_INACTIVE', 'BLOCKED', 'COMMENTS_OFF', 'FOLLOWERS_ONLY', 'SELF_FOLLOW',
  'RATE_LIMITED', 'NETWORK_ERROR', 'UPLOAD_FAILED', 'INTERNAL', 'VIDEO_REQUIRED', 'NOT_REMOVED_FOR_COPYRIGHT', 'ALREADY_PENDING',
] as const;
export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly traceId: string | undefined;
  readonly fieldErrors: { path: string; message: string }[];

  constructor(p: ProblemLike) {
    super(p.detail ?? p.title);
    this.name = 'ApiError';
    this.status = p.status;
    this.code = p.code;
    this.title = p.title;
    this.detail = p.detail;
    this.traceId = p.traceId;
    this.fieldErrors = p.errors ?? [];
  }

  get isAuth(): boolean { return this.status === 401 || this.code === 'UNAUTHENTICATED'; }
  get isForbidden(): boolean { return this.status === 403; }
  get isNetwork(): boolean { return this.code === 'NETWORK_ERROR'; }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

function isProblem(v: unknown): v is ProblemLike {
  return typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string'
    && typeof (v as { status?: unknown }).status === 'number';
}

/** Builds an ApiError from any failed response, problem+json or not. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (isProblem(body)) return new ApiError({ ...body, status: body.status || res.status });
  const code = res.status === 401 ? 'UNAUTHENTICATED' : res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND'
    : res.status === 429 ? 'RATE_LIMITED' : 'INTERNAL';
  return new ApiError({ status: res.status, code, title: res.statusText || 'Request failed' });
}

type TokenGetter = () => string | null | Promise<string | null>;
type Query = Record<string, string | number | boolean | null | undefined>;

export interface ApiClientOptions {
  baseUrl?: string;
  getToken?: TokenGetter;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

export function buildQuery(q: Query | undefined): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const baseUrl = (opts.baseUrl ?? publicEnv.apiUrl).replace(/\/+$/, '');
  let getToken: TokenGetter = opts.getToken ?? (() => null);
  const doFetch: typeof fetch = (...args) => (opts.fetchImpl ?? fetch)(...args);

  async function request<R>(path: string, o: RequestOptions = {}): Promise<R> {
    const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' };
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}${buildQuery(o.query)}`, {
        method: o.method ?? 'GET',
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.signal,
        credentials: 'omit',
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', title: 'The KICKSCOUT service could not be reached' });
    }
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as R;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as R;
  }

  const get = <R>(path: string, query?: Query, signal?: AbortSignal) => request<R>(path, { query, signal });
  const send = <R>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => request<R>(path, { method, body });
  const e = encodeURIComponent;

  return {
    request,
    setTokenGetter(fn: TokenGetter) { getToken = fn; },

    // taxonomy, onboarding, consent
    skills: (s?: AbortSignal) => get<T.SkillList>('/v1/skills', undefined, s),
    register: (b: T.RegisterRequest) => send<T.RegisterResponse>('POST', '/v1/onboarding/register', b),
    me: (s?: AbortSignal) => get<T.MeView>('/v1/me', undefined, s),
    inviteGuardian: (b: T.GuardianInviteRequest) => send<T.GuardianInviteResponse>('POST', '/v1/guardians/invitations', b),
    acceptGuardian: (b: T.GuardianAcceptRequest) => send<unknown>('POST', '/v1/guardians/invitations/accept', b),
    setConsent: (b: T.ConsentRequest) => send<unknown>('POST', '/v1/consents', b),
    consents: (userId: string, s?: AbortSignal) => get<T.ConsentState>(`/v1/users/${e(userId)}/consents`, undefined, s),

    // profiles
    profile: (handle: string, s?: AbortSignal) => get<T.ProfileView>(`/v1/profiles/${e(handle)}`, undefined, s),
    updateProfile: (userId: string, b: T.UpdateProfileRequest) => send<T.ProfileView>('PATCH', `/v1/profiles/${e(userId)}`, b),
    profileVideos: (handle: string, q?: { cursor?: string }, s?: AbortSignal) => get<T.VideoPage>(`/v1/profiles/${e(handle)}/videos`, q, s),

    // videos
    createUpload: (b: T.CreateUploadRequest) => send<T.CreateUploadResponse>('POST', '/v1/uploads', b),
    completeUpload: (videoId: string) => send<T.VideoView>('POST', `/v1/uploads/${e(videoId)}/complete`),
    video: (id: string, s?: AbortSignal) => get<T.VideoView>(`/v1/videos/${e(id)}`, undefined, s),
    updateVideo: (id: string, b: T.UpdateVideoRequest) => send<T.VideoView>('PATCH', `/v1/videos/${e(id)}`, b),
    deleteVideo: (id: string) => send<void>('DELETE', `/v1/videos/${e(id)}`),
    correctTags: (id: string, b: T.TagCorrectionRequest) => send<T.VideoView>('POST', `/v1/videos/${e(id)}/tags`, b),
    recordView: (id: string) => send<void>('POST', `/v1/videos/${e(id)}/view`),
    myVideos: (q?: { cursor?: string }, s?: AbortSignal) => get<T.VideoPage>('/v1/me/videos', q, s),
    mySaves: (q?: { cursor?: string }, s?: AbortSignal) => get<T.VideoPage>('/v1/me/saves', q, s),

    // feed and social
    feed: (q: { tab: T.FeedTab; cursor?: string }, s?: AbortSignal) => get<T.FeedPage>('/v1/feed', q, s),
    like: (id: string, on: boolean) => send<void>(on ? 'PUT' : 'DELETE', `/v1/videos/${e(id)}/like`),
    save: (id: string, on: boolean) => send<void>(on ? 'PUT' : 'DELETE', `/v1/videos/${e(id)}/save`),
    follow: (userId: string, on: boolean) => send<void>(on ? 'PUT' : 'DELETE', `/v1/users/${e(userId)}/follow`),
    block: (userId: string) => send<void>('PUT', `/v1/users/${e(userId)}/block`),
    comments: (id: string, q?: { cursor?: string }, s?: AbortSignal) => get<T.CommentPage>(`/v1/videos/${e(id)}/comments`, q, s),
    addComment: (id: string, b: T.CreateCommentRequest) => send<T.CommentView>('POST', `/v1/videos/${e(id)}/comments`, b),
    report: (b: T.ReportRequest) => send<unknown>('POST', '/v1/reports', b),

    // discovery
    search: (q: T.SearchQuery, s?: AbortSignal) => get<T.SearchResult>('/v1/search', q as Query, s),
    discover: (s?: AbortSignal) => get<T.DiscoverView>('/v1/discover', undefined, s),
    radar: (q: T.RadarQuery, s?: AbortSignal) => get<T.RadarPage>('/v1/radar', q as Query, s),
    challenges: (s?: AbortSignal) => get<T.ChallengeList>('/v1/challenges', undefined, s),
    challenge: (slug: string, s?: AbortSignal) => get<T.ChallengeView>(`/v1/challenges/${e(slug)}`, undefined, s),
    challengeEntries: (slug: string, q?: { cursor?: string }, s?: AbortSignal) => get<T.VideoPage>(`/v1/challenges/${e(slug)}/entries`, q, s),
    enterChallenge: (slug: string, b: T.EnterChallengeRequest) => send<unknown>('POST', `/v1/challenges/${e(slug)}/entries`, b),

    // scouts
    scoutPlayers: (q: T.ScoutSearchQuery, s?: AbortSignal) => get<T.PlayerPage>('/v1/scout/players', q as Query, s),
    shortlists: (s?: AbortSignal) => get<T.ShortlistList>('/v1/scout/shortlists', undefined, s),
    createShortlist: (b: T.CreateShortlistRequest) => send<T.ShortlistView>('POST', '/v1/scout/shortlists', b),
    shortlist: (id: string, s?: AbortSignal) => get<T.ShortlistDetail>(`/v1/scout/shortlists/${e(id)}`, undefined, s),
    deleteShortlist: (id: string) => send<void>('DELETE', `/v1/scout/shortlists/${e(id)}`),
    shortlistPlayer: (id: string, playerId: string, on: boolean) =>
      send<void>(on ? 'PUT' : 'DELETE', `/v1/scout/shortlists/${e(id)}/players/${e(playerId)}`),
    notes: (playerId: string, s?: AbortSignal) => get<T.ScoutNoteList>(`/v1/scout/players/${e(playerId)}/notes`, undefined, s),
    addNote: (playerId: string, b: T.CreateScoutNoteRequest) => send<T.ScoutNoteView>('POST', `/v1/scout/players/${e(playerId)}/notes`, b),
    deleteNote: (noteId: string) => send<void>('DELETE', `/v1/scout/notes/${e(noteId)}`),
    requestContact: (playerId: string, b: T.ContactRequestCreate) => send<T.ContactRequestView>('POST', `/v1/scout/players/${e(playerId)}/contact`, b),
    contactRequests: (direction: 'incoming' | 'outgoing', s?: AbortSignal) => get<T.ContactRequestList>('/v1/contact-requests', { direction }, s),
    respondContact: (id: string, b: T.ContactResponseRequest) => send<T.ContactRequestView>('POST', `/v1/contact-requests/${e(id)}/respond`, b),
    requestVerification: (b: T.VerificationRequestCreate) => send<T.VerificationRequestView>('POST', '/v1/verification-requests', b),

    // privacy, notifications preferences, account
    privacy: (userId: string, s?: AbortSignal) => get<T.PrivacySettingsView>(`/v1/users/${e(userId)}/privacy`, undefined, s),
    updatePrivacy: (userId: string, b: T.UpdatePrivacyRequest) => send<T.PrivacySettingsView>('PATCH', `/v1/users/${e(userId)}/privacy`, b),
    notificationPreferences: (s?: AbortSignal) => get<T.NotificationPreferencesView>('/v1/me/notification-preferences', undefined, s),
    updateNotificationPreferences: (b: T.UpdateNotificationPreferencesRequest) => send<T.NotificationPreferencesView>('PATCH', '/v1/me/notification-preferences', b),
    exportMyData: () => get<T.AccountExport>('/v1/me/export'),
    deleteMyAccount: (b: T.DeleteAccountRequest) => send<T.DeleteAccountResponse>('DELETE', '/v1/me', b),

    // copyright
    copyrightTakedown: (b: T.CopyrightTakedownRequest) => send<T.CopyrightTakedownResponse>('POST', '/v1/copyright/takedowns', b),
    counterNotice: (videoId: string, b: T.CounterNoticeRequest) => send<void>('POST', `/v1/videos/${e(videoId)}/counter-notice`, b),

    // notifications
    notifications: (q?: { cursor?: string }, s?: AbortSignal) => get<T.NotificationPage>('/v1/notifications', q, s),
    markRead: (b: T.MarkReadRequest) => send<void>('POST', '/v1/notifications/read', b),

    // admin
    adminStats: (s?: AbortSignal) => get<T.AdminStats>('/v1/admin/stats', undefined, s),
    moderationCases: (q: { status?: 'open' | 'actioned' | 'dismissed' }, s?: AbortSignal) => get<T.ModerationCaseList>('/v1/admin/moderation-cases', q, s),
    decideCase: (id: string, b: T.ModerationDecisionRequest) => send<unknown>('POST', `/v1/admin/moderation-cases/${e(id)}/decision`, b),
    verificationRequests: (s?: AbortSignal) => get<T.VerificationRequestList>('/v1/admin/verification-requests', undefined, s),
    decideVerification: (id: string, b: T.VerificationDecisionRequest) => send<unknown>('POST', `/v1/admin/verification-requests/${e(id)}/decision`, b),
    auditLogs: (s?: AbortSignal) => get<T.AuditLogPage>('/v1/admin/audit-logs', undefined, s),
    createChallenge: (b: T.CreateChallengeRequest) => send<T.ChallengeView>('POST', '/v1/admin/challenges', b),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Shared browser instance. The auth provider installs the token getter. */
export const api = createApiClient();

/**
 * Uploads the file to the signed URL with the exact headers the API returned, reporting progress.
 * XHR is used because fetch cannot report upload progress.
 */
export function putSignedUpload(
  upload: T.CreateUploadResponse['upload'],
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [k, v] of Object.entries(upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? (onProgress(1), resolve())
      : reject(new ApiError({ status: xhr.status, code: 'UPLOAD_FAILED', title: 'Upload to storage failed' })));
    xhr.onerror = () => reject(new ApiError({ status: 0, code: 'UPLOAD_FAILED', title: 'Upload to storage failed' }));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
